"""Diagnostic conflict detection and infeasibility root cause analyzer.

When scheduling constraints cannot be satisfied, solves a diagnostic slack model
to isolate the exact dates, processes, and coverage shortages without presenting
an invalid roster as valid.
"""

from __future__ import annotations

import datetime
from typing import Dict, List, Set, Tuple

from ortools.sat.python import cp_model

from .domain import (
    Conflict,
    DayCoverage,
    Employee,
    OperatingRule,
    ProcessId,
    SchedulingInput,
)
from .validator import get_weekday, is_process_operating


class ConflictAnalyzer:
    """Diagnoses infeasibility and pinpoints coverage shortages and root causes."""

    @classmethod
    def diagnose_infeasibility(
        cls,
        input_data: SchedulingInput,
    ) -> Tuple[List[Conflict], List[DayCoverage], List[str]]:
        """Run a diagnostic slack model to identify all shortages and explanations."""
        model = cp_model.CpModel()
        holiday_dates = {h.date for h in input_data.holidays}
        dates = input_data.dates

        emp_map = {e.id: e for e in input_data.employees}
        brand_map = {b.id: b for b in input_data.brands}

        # List of operational processes
        # q = (brand_id, process_id, min_staff, rule, custom_dates)
        procs: List[Tuple[str, str, int, OperatingRule, Set[str]]] = []
        for b in input_data.brands:
            for bp in b.processes:
                procs.append((b.id, bp.process_id, bp.min_staff, bp.rule, set(bp.custom_operating_dates)))

        # Precompute operational status G[q, d]
        # (brand_id, process_id, date) -> bool
        G: Dict[Tuple[str, str, str], bool] = {}
        for brand_id, proc_id, _, rule, c_dates in procs:
            for d in dates:
                G[(brand_id, proc_id, d)] = is_process_operating(rule, d, holiday_dates, c_dates)

        # Authorizations: (emp_id, brand_id, process_id) -> 'primary' | 'backup'
        alloc_map: Dict[Tuple[str, str, str], str] = {}
        for a in input_data.allocations:
            alloc_map[(a.employee_id, a.brand_id, a.process_id)] = a.role.lower()

        # Incompatibility map
        incompat_set: Set[Tuple[Tuple[str, str], Tuple[str, str]]] = set()
        for ip in input_data.incompatible_pairs:
            p1 = (ip.brand_id_1, ip.process_id_1)
            p2 = (ip.brand_id_2, ip.process_id_2)
            incompat_set.add((p1, p2))
            incompat_set.add((p2, p1))

        # Decision variables
        # x[e, q, d]
        x: Dict[Tuple[str, str, str, str], cp_model.IntVar] = {}
        w: Dict[Tuple[str, str], cp_model.IntVar] = {}
        o: Dict[Tuple[str, str], cp_model.IntVar] = {}
        n: Dict[Tuple[str, str], cp_model.IntVar] = {}

        # Diagnostic slack variables: s[brand_id, proc_id, date] >= 0
        slack: Dict[Tuple[str, str, str], cp_model.IntVar] = {}

        for e in input_data.employees:
            for d in dates:
                w[(e.id, d)] = model.NewBoolVar(f"w_{e.id}_{d}")
                o[(e.id, d)] = model.NewBoolVar(f"o_{e.id}_{d}")
                n[(e.id, d)] = model.NewBoolVar(f"n_{e.id}_{d}")

                # Unavailability indicator u_ed
                u_ed = 1 if (d in e.leaves or d in e.comp_offs) else 0

                # Employee state partition: w_ed + o_ed + n_ed = 1 - u_ed
                model.Add(w[(e.id, d)] + o[(e.id, d)] + n[(e.id, d)] == 1 - u_ed)

        for brand_id, proc_id, min_staff, _, _ in procs:
            for d in dates:
                is_op = G[(brand_id, proc_id, d)]
                if is_op and min_staff > 0:
                    slack[(brand_id, proc_id, d)] = model.NewIntVar(0, min_staff, f"slack_{brand_id}_{proc_id}_{d}")
                else:
                    slack[(brand_id, proc_id, d)] = model.NewConstant(0)

                for e in input_data.employees:
                    is_eligible = (e.id, brand_id, proc_id) in alloc_map
                    if is_eligible and is_op:
                        x[(e.id, brand_id, proc_id, d)] = model.NewBoolVar(f"x_{e.id}_{brand_id}_{proc_id}_{d}")
                        # Employee availability constraint: x_eqd <= 1 - u_ed
                        u_ed = 1 if (d in e.leaves or d in e.comp_offs) else 0
                        if u_ed == 1:
                            model.Add(x[(e.id, brand_id, proc_id, d)] == 0)
                        # Working consistency: x_eqd <= w_ed
                        model.Add(x[(e.id, brand_id, proc_id, d)] <= w[(e.id, d)])
                    else:
                        pass

        # Working status lower bound: w_ed <= sum_q x_eqd
        for e in input_data.employees:
            for d in dates:
                emp_x = [
                    x[(e.id, b_id, p_id, d)]
                    for b_id, p_id, _, _, _ in procs
                    if (e.id, b_id, p_id, d) in x
                ]
                if emp_x:
                    model.Add(w[(e.id, d)] <= sum(emp_x))
                else:
                    model.Add(w[(e.id, d)] == 0)

        # Weekly-off entitlements per 7-day period
        weeks = [dates[i : i + 7] for i in range(0, len(dates), 7)]
        for e in input_data.employees:
            for week_dates in weeks:
                if len(week_dates) == 7:
                    off_vars = [o[(e.id, d)] for d in week_dates]
                    model.Add(sum(off_vars) >= e.min_weekly_off)
                    model.Add(sum(off_vars) <= e.max_weekly_off)

        # Incompatible duties constraint
        for (p1, p2) in incompat_set:
            b1, pr1 = p1
            b2, pr2 = p2
            for e in input_data.employees:
                for d in dates:
                    v1 = x.get((e.id, b1, pr1, d))
                    v2 = x.get((e.id, b2, pr2, d))
                    if v1 is not None and v2 is not None:
                        model.Add(v1 + v2 <= 1)

        # Relaxed coverage constraint with slack: sum_e x_eqd + s_qd >= M_qd
        for brand_id, proc_id, min_staff, _, _ in procs:
            for d in dates:
                if G[(brand_id, proc_id, d)] and min_staff > 0:
                    cand_vars = [
                        x[(e.id, brand_id, proc_id, d)]
                        for e in input_data.employees
                        if (e.id, brand_id, proc_id, d) in x
                    ]
                    s_var = slack[(brand_id, proc_id, d)]
                    model.Add(sum(cand_vars) + s_var >= min_staff)

        # Objective: minimize total slack (shortages)
        slack_terms = [s for s in slack.values() if isinstance(s, cp_model.IntVar)]
        model.Minimize(sum(slack_terms))

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = 5.0
        diag_status = solver.Solve(model)

        conflicts: List[Conflict] = []
        coverage_list: List[DayCoverage] = []
        explanations: List[str] = []

        if diag_status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            for brand_id, proc_id, min_staff, _, _ in procs:
                brand = brand_map.get(brand_id)
                brand_name = brand.name if brand else brand_id
                for d in dates:
                    is_op = G[(brand_id, proc_id, d)]
                    if not is_op:
                        coverage_list.append(
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

                    s_val = int(solver.Value(slack[(brand_id, proc_id, d)])) if min_staff > 0 else 0
                    scheduled_emps = [
                        e.id
                        for e in input_data.employees
                        if (e.id, brand_id, proc_id, d) in x
                        and solver.Value(x[(e.id, brand_id, proc_id, d)]) == 1
                    ]

                    status_str = "covered"
                    if s_val > 0:
                        status_str = "gap" if len(scheduled_emps) == 0 else "understaffed"

                        # Analyze root cause
                        eligible_primary = [
                            e
                            for e in input_data.employees
                            if alloc_map.get((e.id, brand_id, proc_id)) == "primary"
                        ]
                        eligible_backup = [
                            e
                            for e in input_data.employees
                            if alloc_map.get((e.id, brand_id, proc_id)) == "backup"
                        ]

                        reasons: List[str] = []
                        for ep in eligible_primary:
                            if d in ep.leaves or d in ep.comp_offs:
                                reasons.append(f"Primary {ep.name} ({ep.id}) is unavailable (leave/comp-off)")
                            elif solver.Value(o[(ep.id, d)]) == 1:
                                reasons.append(f"Primary {ep.name} ({ep.id}) is on weekly off")

                        if not eligible_backup:
                            reasons.append("No authorized backup resources are configured for this process")
                        else:
                            for eb in eligible_backup:
                                if d in eb.leaves or d in eb.comp_offs:
                                    reasons.append(f"Backup {eb.name} ({eb.id}) is on leave/comp-off")
                                elif solver.Value(o[(eb.id, d)]) == 1:
                                    reasons.append(f"Backup {eb.name} ({eb.id}) is on weekly off")
                                else:
                                    # Check if backup was blocked by incompatible assignment
                                    reasons.append(
                                        f"Backup {eb.name} ({eb.id}) is unavailable or constrained by conflicting assignments"
                                    )

                        reason_text = "; ".join(reasons) if reasons else "Insufficient eligible staffing."
                        suggestion = (
                            f"Authorize additional backup resources for {brand_name} {proc_id}, "
                            f"adjust employee leave dates, or reduce minimum coverage requirement."
                        )

                        cid = f"shortage-{d}-{brand_id}-{proc_id}"
                        msg = (
                            f"Coverage shortage of {s_val} on {d} for {brand_name} ({brand_id}) "
                            f"process {proc_id}: required {min_staff}, scheduled {len(scheduled_emps)}. "
                            f"Causes: {reason_text}"
                        )
                        conflicts.append(
                            Conflict(
                                id=cid,
                                type="COVERAGE_GAP" if len(scheduled_emps) == 0 else "UNDERSTAFFED",
                                severity="error",
                                date=d,
                                brand_id=brand_id,
                                process_id=proc_id,
                                message=msg,
                                suggestion=suggestion,
                                diagnostic_shortage=s_val,
                            )
                        )
                        explanations.append(msg)

                    coverage_list.append(
                        DayCoverage(
                            date=d,
                            brand_id=brand_id,
                            process_id=proc_id,
                            operating=True,
                            required=min_staff,
                            scheduled=scheduled_emps,
                            shortage=s_val,
                            status=status_str,
                        )
                    )

        return conflicts, coverage_list, explanations
