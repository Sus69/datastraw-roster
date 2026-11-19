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
        G: Dict[Tuple[str, str, str], bool] = {}
        for brand_id, proc_id, _, rule, c_dates in procs:
            for d in dates:
                G[(brand_id, proc_id, d)] = is_process_operating(rule, d, holiday_dates, c_dates)

        # Authorizations: (emp_id, brand_id, process_id) -> 'primary' | 'backup'
        alloc_map: Dict[Tuple[str, str, str], str] = {}
        for a in input_data.allocations:
            alloc_map[(a.employee_id, a.brand_id, a.process_id)] = a.role.lower()

        # Decision variables
        x: Dict[Tuple[str, str, str, str], cp_model.IntVar] = {}
        w: Dict[Tuple[str, str], cp_model.IntVar] = {}
        o: Dict[Tuple[str, str], cp_model.IntVar] = {}
        n: Dict[Tuple[str, str], cp_model.IntVar] = {}
        slack: Dict[Tuple[str, str, str], cp_model.IntVar] = {}

        for e in input_data.employees:
            for d in dates:
                w[(e.id, d)] = model.NewBoolVar(f"w_{e.id}_{d}")
                o[(e.id, d)] = model.NewBoolVar(f"o_{e.id}_{d}")
                n[(e.id, d)] = model.NewBoolVar(f"n_{e.id}_{d}")

                # Unavailability indicator U_ed (leave, comp-off)
                u_ed = 1 if (d in e.leaves or d in e.comp_offs) else 0

                # Employee state partition: w_ed + o_ed + n_ed = 1 - U_ed
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
                        var = model.NewBoolVar(f"x_{e.id}_{brand_id}_{proc_id}_{d}")
                        x[(e.id, brand_id, proc_id, d)] = var

                        # Employee availability constraint: x_eqd <= 1 - U_ed
                        u_ed = 1 if (d in e.leaves or d in e.comp_offs) else 0
                        if u_ed == 1:
                            model.Add(var == 0)

        # Exclusive Daily Employee Assignment: sum_q x_eqd <= 1
        # Working consistency: w_ed = sum_q x_eqd
        for e in input_data.employees:
            for d in dates:
                emp_x = [
                    x[(e.id, b_id, p_id, d)]
                    for b_id, p_id, _, _, _ in procs
                    if (e.id, b_id, p_id, d) in x
                ]
                if emp_x:
                    model.Add(sum(emp_x) <= 1)
                    model.Add(w[(e.id, d)] == sum(emp_x))
                else:
                    model.Add(w[(e.id, d)] == 0)

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

        # Most-constrained priority weights in diagnostic objective
        slack_terms = []
        for brand_id, proc_id, min_staff, _, _ in procs:
            for d in dates:
                s_var = slack[(brand_id, proc_id, d)]
                if isinstance(s_var, cp_model.IntVar):
                    # Compute N_qd
                    eligible_count = sum(
                        1 for e in input_data.employees
                        if (e.id, brand_id, proc_id) in alloc_map
                        and d not in e.leaves
                        and d not in e.comp_offs
                    )
                    weight = 1000 + (100 - min(100, eligible_count))
                    slack_terms.append(s_var * weight)

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

                        eligible_primary = [
                            e for e in input_data.employees
                            if alloc_map.get((e.id, brand_id, proc_id)) == "primary"
                        ]
                        eligible_backup = [
                            e for e in input_data.employees
                            if alloc_map.get((e.id, brand_id, proc_id)) == "backup"
                        ]

                        reasons: List[str] = []
                        for ep in eligible_primary:
                            if d in ep.leaves or d in ep.comp_offs:
                                reasons.append(f"Primary {ep.name} ({ep.id}) is unavailable on approved leave/comp-off")
                            elif solver.Value(w[(ep.id, d)]) == 1:
                                reasons.append(f"Primary {ep.name} ({ep.id}) is assigned to another brand/process")

                        if not eligible_backup:
                            reasons.append("No authorized backup resource exists for this process")
                        else:
                            for eb in eligible_backup:
                                if d in eb.leaves or d in eb.comp_offs:
                                    reasons.append(f"Backup {eb.name} ({eb.id}) is on approved leave/comp-off")
                                elif solver.Value(w[(eb.id, d)]) == 1:
                                    reasons.append(f"Backup {eb.name} ({eb.id}) is assigned to another brand/process")
                                else:
                                    reasons.append(f"Backup {eb.name} ({eb.id}) is unavailable or off")

                        reason_text = "; ".join(reasons) if reasons else "Insufficient eligible staffing."
                        suggestion = (
                            f"Authorize backup coverage for {brand_name} {proc_id}, "
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

            # Record weekly-off override warnings from diagnostic solve
            for brand_id, proc_id, _, _, _ in procs:
                brand = brand_map.get(brand_id)
                brand_name = brand.name if brand else brand_id
                for d in dates:
                    for e in input_data.employees:
                        if (e.id, brand_id, proc_id, d) in x and solver.Value(x[(e.id, brand_id, proc_id, d)]) == 1:
                            wd = get_weekday(d)
                            if wd in e.weekly_off:
                                conflicts.append(
                                    Conflict(
                                        id=f"off-{d}-{e.id}-{brand_id}",
                                        type="OFF_OVERRIDDEN",
                                        severity="warning",
                                        date=d,
                                        brand_id=brand_id,
                                        process_id=proc_id,
                                        employee_id=e.id,
                                        message=f"{e.name} ({e.id}) worked on preferred weekly off to cover {brand_name} ({proc_id}).",
                                        suggestion="Client operational coverage took precedence over preferred weekly off.",
                                    )
                                )

        return conflicts, coverage_list, explanations
