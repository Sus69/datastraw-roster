"""Constraint Programming (CP-SAT) workforce scheduling engine.

Implements the exact mathematical optimization model specified in the task description:
- Exclusive daily employee assignment: sum_{q in Q} x_{eqd} <= 1
- Most-constrained assignment priority: N_{qd} = |{e eligible and available}|
- Soft weekly-off preferences: v_{ed} in {0, 1}, min sum c_{ed} v_{ed}
- Hard planned leaves and comp-offs: x_{eqd} <= 1 - U_{ed}
- Operating calendar rules: 365-day ops, except holidays, no Sun & holidays
- Categorized validation results: hard-constraint failures, warnings, informational
"""

from __future__ import annotations

import datetime
import time
from typing import Dict, List, Optional, Set, Tuple

from ortools.sat.python import cp_model

from .conflict_analyzer import ConflictAnalyzer
from .domain import (
    Allocation,
    Brand,
    BrandProcess,
    Conflict,
    DayCoverage,
    Employee,
    Holiday,
    IncompatiblePair,
    OperatingRule,
    ProcessId,
    ReferenceAssignment,
    RosterEntry,
    RosterStats,
    SchedulingInput,
    SchedulingResult,
    SolverStatus,
    ValidationReport,
    WorkloadPolicy,
)
from .validator import RosterValidator, get_weekday, is_process_operating


class SchedulingEngine:
    """Core mathematical workforce scheduling engine using Google OR-Tools CP-SAT."""

    def __init__(self, input_data: SchedulingInput):
        self.input_data = input_data
        self.assignment_semantics = getattr(input_data, "assignment_semantics", "process")
        self.holiday_dates: Set[str] = {h.date for h in input_data.holidays}
        self.dates: List[str] = input_data.dates
        self.emp_map: Dict[str, Employee] = {e.id: e for e in input_data.employees}
        self.brand_map: Dict[str, Brand] = {b.id: b for b in input_data.brands}

        # Operational process combinations q = (brand_id, process_id, min_staff, rule, custom_dates)
        self.procs: List[Tuple[str, str, int, OperatingRule, Set[str]]] = []
        for b in input_data.brands:
            for bp in b.processes:
                self.procs.append((b.id, bp.process_id, bp.min_staff, bp.rule, set(bp.custom_operating_dates)))

        # Precompute operational status G[brand_id, process_id, date]
        self.G: Dict[Tuple[str, str, str], bool] = {}
        for brand_id, proc_id, _, rule, c_dates in self.procs:
            for d in self.dates:
                self.G[(brand_id, proc_id, d)] = is_process_operating(
                    rule, d, self.holiday_dates, c_dates
                )

        # Authorizations map: (emp_id, brand_id, process_id) -> 'primary' | 'backup'
        self.alloc_map: Dict[Tuple[str, str, str], str] = {}
        for a in input_data.allocations:
            self.alloc_map[(a.employee_id, a.brand_id, a.process_id)] = a.role.lower()

        # Incompatibility map
        self.incompat_set: Set[Tuple[Tuple[str, str], Tuple[str, str]]] = set()
        for ip in input_data.incompatible_pairs:
            p1 = (ip.brand_id_1, ip.process_id_1)
            p2 = (ip.brand_id_2, ip.process_id_2)
            self.incompat_set.add((p1, p2))
            self.incompat_set.add((p2, p1))

        # Reference roster lookup for re-optimization: (emp_id, brand_id, proc_id, date) -> 1
        self.ref_map: Set[Tuple[str, str, str, str]] = set()
        for ra in input_data.reference_roster:
            self.ref_map.add((ra.employee_id, ra.brand_id, ra.process_id, ra.date))

        # Calculate Most-Constrained variable counts N_qd:
        # N_qd = |{e : (e, q) is authorized and U_ed == 0}|
        self.N_qd: Dict[Tuple[str, str, str], int] = {}
        for brand_id, proc_id, _, _, _ in self.procs:
            for d in self.dates:
                count = sum(
                    1
                    for e in self.input_data.employees
                    if (e.id, brand_id, proc_id) in self.alloc_map
                    and d not in e.leaves
                    and d not in e.comp_offs
                )
                self.N_qd[(brand_id, proc_id, d)] = count

    def _validate_inputs(self) -> Tuple[bool, List[str]]:
        """Validate normalized scheduling inputs for internal mathematical consistency."""
        errors: List[str] = []
        if not self.input_data.employees:
            errors.append("No employees provided in scheduling input.")
        if not self.input_data.brands:
            errors.append("No brands or processes provided in scheduling input.")
        if not self.dates:
            errors.append("No scheduling dates provided.")

        for b in self.input_data.brands:
            for bp in b.processes:
                if bp.min_staff < 0:
                    errors.append(f"Process {b.id}-{bp.process_id} min_staff cannot be negative.")

        return len(errors) == 0, errors

    def solve(self, lexicographic: bool = True) -> SchedulingResult:
        """Solve the workforce scheduling problem using CP-SAT."""
        start_time = time.perf_counter()

        # Step 0: Input consistency validation
        valid_input, input_errors = self._validate_inputs()
        if not valid_input:
            elapsed = time.perf_counter() - start_time
            return SchedulingResult(
                status=SolverStatus.MODEL_INVALID,
                solve_time_seconds=elapsed,
                diagnostic_explanations=input_errors,
            )

        # Step 1: Build the CP-SAT Model
        model = cp_model.CpModel()

        # Decision Variables
        x: Dict[Tuple[str, str, str, str], cp_model.IntVar] = {}
        w: Dict[Tuple[str, str], cp_model.IntVar] = {}
        o: Dict[Tuple[str, str], cp_model.IntVar] = {}
        n: Dict[Tuple[str, str], cp_model.IntVar] = {}
        v: Dict[Tuple[str, str], cp_model.IntVar] = {}  # Weekly off override indicator

        delta_vars: List[cp_model.IntVar] = []

        # Decision Variables for Employee States
        for e in self.input_data.employees:
            for d in self.dates:
                w[(e.id, d)] = model.NewBoolVar(f"w_{e.id}_{d}")
                o[(e.id, d)] = model.NewBoolVar(f"o_{e.id}_{d}")
                n[(e.id, d)] = model.NewBoolVar(f"n_{e.id}_{d}")

                # Hard Constraint 4: Planned Leaves and Comp-Offs (U_ed)
                u_ed = 1 if (d in e.leaves or d in e.comp_offs) else 0

                # Hard Constraint: Employee state partition
                # w_ed + o_ed + n_ed = 1 - U_ed
                model.Add(w[(e.id, d)] + o[(e.id, d)] + n[(e.id, d)] == 1 - u_ed)

                # Soft Constraint 3: Weekly-Off Preferences
                wd = get_weekday(d)
                is_pref_off = wd in e.weekly_off
                if is_pref_off and u_ed == 0:
                    # v_ed = 1 if employee works on preferred off day
                    v_var = model.NewBoolVar(f"v_{e.id}_{d}")
                    v[(e.id, d)] = v_var
                    model.Add(v_var == w[(e.id, d)])
                else:
                    v[(e.id, d)] = model.NewConstant(0)

        # Process Assignment Variables x[e, q, d]
        # Sort processes by N_qd (most-constrained first)
        proc_vars_by_constraint: List[Tuple[int, int, cp_model.IntVar]] = []

        for brand_id, proc_id, min_staff, _, _ in self.procs:
            for d in self.dates:
                is_operating = self.G[(brand_id, proc_id, d)]
                n_qd_val = self.N_qd[(brand_id, proc_id, d)]

                for e in self.input_data.employees:
                    is_authorized = (e.id, brand_id, proc_id) in self.alloc_map

                    if is_authorized and is_operating:
                        var = model.NewBoolVar(f"x_{e.id}_{brand_id}_{proc_id}_{d}")
                        x[(e.id, brand_id, proc_id, d)] = var

                        # Hard Constraint 4: Availability constraint
                        u_ed = 1 if (d in e.leaves or d in e.comp_offs) else 0
                        if u_ed == 1:
                            model.Add(var == 0)

                        is_primary = 1 if self.alloc_map.get((e.id, brand_id, proc_id)) == "primary" else 0
                        proc_vars_by_constraint.append((n_qd_val, -is_primary, var))

                        # Re-optimization delta tracking
                        if self.input_data.enable_reoptimization and self.input_data.reference_roster:
                            x0 = 1 if (e.id, brand_id, proc_id, d) in self.ref_map else 0
                            delta = model.NewBoolVar(f"delta_{e.id}_{brand_id}_{proc_id}_{d}")
                            model.Add(delta >= var - x0)
                            model.Add(delta >= x0 - var)
                            delta_vars.append(delta)

        # Hard Constraint 1: Exclusive Daily Employee Assignment
        # sum_{q in Q} x_{eqd} <= 1
        # Working-status consistency: w_{ed} = sum_{q in Q} x_{eqd}
        for e in self.input_data.employees:
            for d in self.dates:
                emp_x_vars = [
                    x[(e.id, b_id, p_id, d)]
                    for b_id, p_id, _, _, _ in self.procs
                    if (e.id, b_id, p_id, d) in x
                ]
                if self.assignment_semantics == "brand":
                    # Business rule used by the web UI: one brand per employee per
                    # day, but every authorized operating process at that brand is
                    # covered by the same working day. Keep a representative y per
                    # (employee, brand, date) and equate all process variables.
                    by_brand: Dict[str, List[cp_model.IntVar]] = {}
                    for b_id, p_id, _, _, _ in self.procs:
                        var = x.get((e.id, b_id, p_id, d))
                        if var is not None:
                            by_brand.setdefault(b_id, []).append(var)

                    brand_vars: List[cp_model.IntVar] = []
                    for b_id in sorted(by_brand):
                        group = by_brand[b_id]
                        y_var = model.NewBoolVar(f"y_{e.id}_{b_id}_{d}")
                        for var in group:
                            model.Add(var == y_var)
                        brand_vars.append(y_var)
                    if brand_vars:
                        model.Add(sum(brand_vars) <= 1)
                        model.Add(w[(e.id, d)] == sum(brand_vars))
                    else:
                        model.Add(w[(e.id, d)] == 0)
                else:
                    if emp_x_vars:
                        # Enforce sum_q x_eqd <= 1
                        model.Add(sum(emp_x_vars) <= 1)
                        # Working status consistency: w_ed == sum_q x_eqd
                        model.Add(w[(e.id, d)] == sum(emp_x_vars))
                    else:
                        model.Add(w[(e.id, d)] == 0)

        # Hard Constraint: Minimum Process Coverage
        # sum_e x_{eqd} >= M_{qd} for every operational process and applicable date
        for brand_id, proc_id, min_staff, _, _ in self.procs:
            for d in self.dates:
                if self.G[(brand_id, proc_id, d)] and min_staff > 0:
                    cand_vars = [
                        x[(e.id, brand_id, proc_id, d)]
                        for e in self.input_data.employees
                        if (e.id, brand_id, proc_id, d) in x
                    ]
                    model.Add(sum(cand_vars) >= min_staff)

        # Hard Constraint: Incompatible assignments
        for (p1, p2) in self.incompat_set:
            b1, pr1 = p1
            b2, pr2 = p2
            for e in self.input_data.employees:
                for d in self.dates:
                    v1 = x.get((e.id, b1, pr1, d))
                    v2 = x.get((e.id, b2, pr2, d))
                    if v1 is not None and v2 is not None:
                        model.Add(v1 + v2 <= 1)

        # Optional Workload & Capacity Constraints
        workload = self.input_data.workload_policy
        h_vars: Dict[Tuple[str, str, str, str], cp_model.IntVar] = {}
        if workload.enabled and workload.demands and workload.capacities:
            demands_map = {
                (d.brand_id, d.process_id, d.date): int(round(d.demand_hours * 10))
                for d in workload.demands
            }
            daily_caps = {
                (c.employee_id, c.date): int(round(c.max_daily_hours * 10))
                for c in workload.capacities
            }
            proc_caps = {}
            for c in workload.capacities:
                for proc_k, max_h in c.process_capacity_hours.items():
                    proc_caps[(c.employee_id, proc_k, c.date)] = int(round(max_h * 10))

            for (e_id, b_id, p_id, d), x_var in x.items():
                h_var = model.NewIntVar(0, daily_caps.get((e_id, d), 80), f"h_{e_id}_{b_id}_{p_id}_{d}")
                h_vars[(e_id, b_id, p_id, d)] = h_var
                u_limit = proc_caps.get((e_id, f"{b_id}:{p_id}", d), proc_caps.get((e_id, p_id, d), daily_caps.get((e_id, d), 80)))
                model.Add(h_var <= u_limit * x_var)

            for (b_id, p_id, d), d_req in demands_map.items():
                relevant_h = [h_vars[(e.id, b_id, p_id, d)] for e in self.input_data.employees if (e.id, b_id, p_id, d) in h_vars]
                if relevant_h:
                    model.Add(sum(relevant_h) >= d_req)

            for e in self.input_data.employees:
                for d in self.dates:
                    e_h = [h_vars[(e.id, b_id, p_id, d)] for b_id, p_id, _, _, _ in self.procs if (e.id, b_id, p_id, d) in h_vars]
                    h_limit = daily_caps.get((e.id, d), 80)
                    if e_h:
                        model.Add(sum(e_h) <= h_limit * w[(e.id, d)])

        # Step 2: Most-Constrained Variable Strategy
        # Sort variables by smallest N_qd first, then primary resource preference
        if proc_vars_by_constraint:
            proc_vars_by_constraint.sort(key=lambda t: (t[0], t[1]))
            strategy_vars = [t[2] for t in proc_vars_by_constraint]
            model.AddDecisionStrategy(
                strategy_vars,
                cp_model.CHOOSE_FIRST,
                cp_model.SELECT_MAX_VALUE,
            )

        # Step 3: Objective Formulation
        # 1. Minimize re-optimization changes (if enabled)
        # 2. Minimize backup deployment (prefer primary resources)
        # 3. Minimize weekly-off preference overrides: min sum c_{ed} v_{ed}
        # 4. Minimize excess staffing
        backup_penalty_terms: List[cp_model.IntVar] = []
        for (e_id, b_id, p_id, d), var in x.items():
            if self.alloc_map.get((e_id, b_id, p_id)) == "backup":
                backup_penalty_terms.append(var)

        pref_override_terms: List[cp_model.IntVar] = [
            var for var in v.values() if isinstance(var, cp_model.IntVar)
        ]

        excess_staffing_terms: List[cp_model.IntVar] = []
        for brand_id, proc_id, min_staff, _, _ in self.procs:
            for d in self.dates:
                if self.G[(brand_id, proc_id, d)] and min_staff > 0:
                    cand_vars = [
                        x[(e.id, brand_id, proc_id, d)]
                        for e in self.input_data.employees
                        if (e.id, brand_id, proc_id, d) in x
                    ]
                    if cand_vars and len(cand_vars) > min_staff:
                        excess = model.NewIntVar(0, len(cand_vars) - min_staff, f"excess_{brand_id}_{proc_id}_{d}")
                        model.Add(excess == sum(cand_vars) - min_staff)
                        excess_staffing_terms.append(excess)

        # Fairness objective: cap the busiest employee's month-to-date workload.
        # Total coverage is fixed by demand, but this spreads shared/backup work
        # instead of repeatedly loading the same floater.
        fairness_terms: List[cp_model.IntVar] = []
        if x:
            max_load = model.NewIntVar(0, max(1, len(self.dates) * len(self.procs)), "max_employee_load")
            for e in self.input_data.employees:
                employee_vars = [
                    var for (e_id, _b, _p, _d), var in x.items() if e_id == e.id
                ]
                if employee_vars:
                    model.Add(max_load >= sum(employee_vars))
            fairness_terms.append(max_load)

        # Staged re-optimization if delta_vars active
        if lexicographic and delta_vars:
            model.Minimize(sum(delta_vars))
            solver = cp_model.CpSolver()
            solver.parameters.max_time_in_seconds = max(1.0, self.input_data.timeout_seconds / 2)
            stg1_status = solver.Solve(model)
            if stg1_status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                min_delta = int(solver.ObjectiveValue())
                model.Add(sum(delta_vars) <= min_delta)
            elif stg1_status == cp_model.INFEASIBLE:
                return self._handle_infeasible(start_time)
            elif stg1_status == cp_model.UNKNOWN:
                elapsed = time.perf_counter() - start_time
                return SchedulingResult(
                    status=SolverStatus.UNKNOWN,
                    solve_time_seconds=elapsed,
                    diagnostic_explanations=["Solver timed out during re-optimization."],
                )

        obj_terms: List[Tuple[cp_model.IntVar, int]] = []
        if delta_vars:
            for dv in delta_vars:
                obj_terms.append((dv, 10_000_000))
        for bv in backup_penalty_terms:
            obj_terms.append((bv, 10_000))
        for pv in pref_override_terms:
            obj_terms.append((pv, 100))
        for ev in excess_staffing_terms:
            obj_terms.append((ev, 10))
        for fv in fairness_terms:
            obj_terms.append((fv, 1))

        if obj_terms:
            model.Minimize(sum(var * coeff for var, coeff in obj_terms))

        # Step 4: Solve the CP-SAT Model
        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = self.input_data.timeout_seconds
        solver.parameters.num_search_workers = 4

        raw_status = solver.Solve(model)
        elapsed = time.perf_counter() - start_time

        if raw_status == cp_model.OPTIMAL:
            status = SolverStatus.OPTIMAL
        elif raw_status == cp_model.FEASIBLE:
            status = SolverStatus.FEASIBLE
        elif raw_status == cp_model.INFEASIBLE:
            return self._handle_infeasible(start_time)
        elif raw_status == cp_model.UNKNOWN:
            return SchedulingResult(
                status=SolverStatus.UNKNOWN,
                solve_time_seconds=elapsed,
                diagnostic_explanations=[
                    f"Solver returned UNKNOWN after {elapsed:.2f} seconds (limit: {self.input_data.timeout_seconds}s)."
                ],
            )
        else:
            return SchedulingResult(
                status=SolverStatus.MODEL_INVALID,
                solve_time_seconds=elapsed,
                diagnostic_explanations=[f"Unexpected solver status code: {raw_status}."],
            )

        return self._extract_solution(solver, x, w, o, n, v, status, elapsed)

    def _handle_infeasible(self, start_time: float) -> SchedulingResult:
        """Analyze and report infeasibility with diagnostic slack model."""
        diag_conflicts, diag_coverage, diag_explanations = ConflictAnalyzer.diagnose_infeasibility(self.input_data)
        elapsed = time.perf_counter() - start_time

        op_slots = sum(1 for c in diag_coverage if c.operating)
        cov_slots = sum(1 for c in diag_coverage if c.status == "covered")
        gap_slots = sum(1 for c in diag_coverage if c.status == "gap")
        under_slots = sum(1 for c in diag_coverage if c.status == "understaffed")
        err_cnt = sum(1 for c in diag_conflicts if c.severity == "error")
        warn_cnt = sum(1 for c in diag_conflicts if c.severity == "warning")
        cov_pct = round((cov_slots / op_slots * 100), 1) if op_slots > 0 else 100.0
        emps_working = len({emp_id for c in diag_coverage for emp_id in c.scheduled})

        # Build employee_days for diagnostic tracking
        diag_employee_days: Dict[str, Dict[str, str]] = {}
        for e in self.input_data.employees:
            emp_days: Dict[str, str] = {}
            for d in self.dates:
                if d in e.leaves:
                    emp_days[d] = "LEAVE"
                elif d in e.comp_offs:
                    emp_days[d] = "COMP_OFF"
                else:
                    emp_days[d] = "UNASSIGNED"
            diag_employee_days[e.id] = emp_days

        val_report = ValidationReport(
            is_valid=False,
            hard_failures=[c.message for c in diag_conflicts if c.severity == "error"],
            warnings=[c.message for c in diag_conflicts if c.severity == "warning"],
            informational=[f"Operational slot {c.brand_id}-{c.process_id} on {c.date}: {c.status}" for c in diag_coverage if c.status == "covered"],
        )

        return SchedulingResult(
            status=SolverStatus.INFEASIBLE,
            solve_time_seconds=elapsed,
            entries=[],
            coverage=diag_coverage,
            conflicts=diag_conflicts,
            stats=RosterStats(
                operating_slots=op_slots,
                covered_slots=cov_slots,
                gap_slots=gap_slots,
                understaffed_slots=under_slots,
                errors=err_cnt,
                warnings=warn_cnt,
                coverage_pct=cov_pct,
                employees_working=emps_working,
            ),
            diagnostic_explanations=diag_explanations,
            employee_days=diag_employee_days,
            validation_report=val_report,
        )

    def _extract_solution(
        self,
        solver: cp_model.CpSolver,
        x: Dict[Tuple[str, str, str, str], cp_model.IntVar],
        w: Dict[Tuple[str, str], cp_model.IntVar],
        o: Dict[Tuple[str, str], cp_model.IntVar],
        n: Dict[Tuple[str, str], cp_model.IntVar],
        v: Dict[Tuple[str, str], cp_model.IntVar],
        status: SolverStatus,
        elapsed: float,
    ) -> SchedulingResult:
        entries: List[RosterEntry] = []
        coverage: List[DayCoverage] = []
        conflicts: List[Conflict] = []
        employee_days: Dict[str, Dict[str, str]] = {}

        # 1. Extract Roster Entries
        if self.assignment_semantics == "brand":
            # Combine all processes covered at the same brand into one working day.
            grouped: Dict[Tuple[str, str, str], List[str]] = {}
            for (e_id, b_id, p_id, d), var in x.items():
                if solver.Value(var) == 1:
                    grouped.setdefault((e_id, b_id, d), []).append(p_id)
            for (e_id, b_id, d), procs in sorted(grouped.items()):
                emp = self.emp_map[e_id]
                entries.append(
                    RosterEntry(
                        date=d,
                        employee_id=e_id,
                        brand_id=b_id,
                        processes=sorted(procs),
                        is_weekly_off=get_weekday(d) in emp.weekly_off,
                        is_backup=any(self.alloc_map.get((e_id, b_id, p)) == "backup" for p in procs),
                    )
                )
        else:
            for (e_id, b_id, p_id, d), var in x.items():
                if solver.Value(var) == 1:
                    emp = self.emp_map[e_id]
                    is_pref_off = get_weekday(d) in emp.weekly_off
                    is_backup = (self.alloc_map.get((e_id, b_id, p_id)) == "backup")

                    entries.append(
                        RosterEntry(
                            date=d,
                            employee_id=e_id,
                            brand_id=b_id,
                            processes=[p_id],
                            is_weekly_off=is_pref_off,
                            is_backup=is_backup,
                        )
                    )

        # 2. Extract Employee Day States
        for e in self.input_data.employees:
            emp_days: Dict[str, str] = {}
            for d in self.dates:
                if d in e.leaves:
                    emp_days[d] = "LEAVE"
                elif d in e.comp_offs:
                    emp_days[d] = "COMP_OFF"
                elif solver.Value(w[(e.id, d)]) == 1:
                    emp_days[d] = "WORK"
                elif solver.Value(o[(e.id, d)]) == 1:
                    emp_days[d] = "OFF"
                else:
                    emp_days[d] = "UNASSIGNED"
            employee_days[e.id] = emp_days

        # 3. Calculate Coverage
        for brand_id, proc_id, min_staff, _, _ in self.procs:
            for d in self.dates:
                is_op = self.G[(brand_id, proc_id, d)]
                if not is_op:
                    coverage.append(
                        DayCoverage(
                            date=d,
                            brand_id=brand_id,
                            process_id=proc_id,
                            operating=False,
                            required=min_staff,
                            scheduled=[],
                            shortage=0,
                            status="not-operating",
                        )
                    )
                    continue

                scheduled_emps = [
                    e.id
                    for e in self.input_data.employees
                    if (e.id, brand_id, proc_id, d) in x
                    and solver.Value(x[(e.id, brand_id, proc_id, d)]) == 1
                ]
                shortage = max(0, min_staff - len(scheduled_emps))
                c_status = (
                    "covered"
                    if len(scheduled_emps) >= min_staff
                    else ("gap" if len(scheduled_emps) == 0 else "understaffed")
                )

                coverage.append(
                    DayCoverage(
                        date=d,
                        brand_id=brand_id,
                        process_id=proc_id,
                        operating=True,
                        required=min_staff,
                        scheduled=scheduled_emps,
                        shortage=shortage,
                        status=c_status,
                    )
                )

        # 4. Independent Validation and Categorization
        val_report = RosterValidator.validate(self.input_data, entries, employee_days)

        # Add warnings for weekly-off overrides
        for entry in entries:
            emp = self.emp_map[entry.employee_id]
            if get_weekday(entry.date) in emp.weekly_off:
                brand = self.brand_map.get(entry.brand_id)
                b_name = brand.name if brand else entry.brand_id
                conflicts.append(
                    Conflict(
                        id=f"off-{entry.date}-{entry.employee_id}",
                        type="OFF_OVERRIDDEN",
                        severity="warning",
                        date=entry.date,
                        brand_id=entry.brand_id,
                        employee_id=entry.employee_id,
                        process_id=entry.processes[0] if entry.processes else None,
                        message=f"{emp.name} ({emp.id}) worked on preferred weekly off to cover {b_name} ({', '.join(entry.processes)}).",
                        suggestion="Client operational coverage took precedence over preferred weekly off.",
                    )
                )

        # Add warnings for backup deployments
        for entry in entries:
            if entry.is_backup:
                emp = self.emp_map[entry.employee_id]
                brand = self.brand_map.get(entry.brand_id)
                b_name = brand.name if brand else entry.brand_id
                conflicts.append(
                    Conflict(
                        id=f"backup-{entry.date}-{entry.employee_id}-{entry.brand_id}",
                        type="BACKUP_ASSIGNMENT",
                        severity="warning",
                        date=entry.date,
                        brand_id=entry.brand_id,
                        employee_id=entry.employee_id,
                        process_id=entry.processes[0] if entry.processes else None,
                        message=f"{emp.name} ({emp.id}) deployed as backup for {b_name} ({', '.join(entry.processes)}).",
                        suggestion="Assigned backup resource to meet operational staffing requirements.",
                    )
                )

        # Record any hard failures from independent validation
        for err in val_report.hard_failures:
            conflicts.append(
                Conflict(
                    id=f"hard-err-{len(conflicts)}",
                    type="HARD_CONSTRAINT_FAILURE",
                    severity="error",
                    date=self.dates[0] if self.dates else "",
                    message=err,
                )
            )

        # Calculate Statistics
        op_slots = sum(1 for c in coverage if c.operating)
        cov_slots = sum(1 for c in coverage if c.status == "covered")
        gap_slots = sum(1 for c in coverage if c.status == "gap")
        under_slots = sum(1 for c in coverage if c.status == "understaffed")
        warn_cnt = len(val_report.warnings)
        err_cnt = len(val_report.hard_failures)
        cov_pct = round((cov_slots / op_slots * 100), 1) if op_slots > 0 else 100.0

        stats = RosterStats(
            operating_slots=op_slots,
            covered_slots=cov_slots,
            gap_slots=gap_slots,
            understaffed_slots=under_slots,
            warnings=warn_cnt,
            errors=err_cnt,
            coverage_pct=cov_pct,
            employees_working=len({e.employee_id for e in entries}),
        )

        return SchedulingResult(
            status=status,
            solve_time_seconds=elapsed,
            entries=entries,
            coverage=coverage,
            conflicts=conflicts,
            stats=stats,
            diagnostic_explanations=[],
            employee_days=employee_days,
            validation_report=val_report,
        )
