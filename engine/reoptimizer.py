"""Dynamic Re-optimization Engine for Workforce Scheduling.

Modifies an existing roster in response to operational disruptions (leaves, unavailabilities,
operating rule changes, staffing requirement changes) while strictly minimizing assignment
disruptions:
    min sum_{e,q,d} Delta_{eqd}
where:
    Delta_{eqd} >= x_{eqd} - x^0_{eqd}
    Delta_{eqd} >= x^0_{eqd} - x_{eqd}
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from .domain import (
    OperatingRule,
    ProcessId,
    ReferenceAssignment,
    RosterEntry,
    SchedulingInput,
    SchedulingResult,
    SolverStatus,
)
from .model import SchedulingEngine


@dataclass
class ReoptimizationDelta:
    total_changes: int
    added_assignments: List[Dict[str, str]] = field(default_factory=list)
    removed_assignments: List[Dict[str, str]] = field(default_factory=list)
    unaffected_assignments_count: int = 0
    stability_ratio: float = 1.0


class Reoptimizer:
    """Handles operational changes and re-optimizes the workforce schedule."""

    @classmethod
    def reoptimize(
        cls,
        base_input: SchedulingInput,
        current_entries: List[RosterEntry],
        unavailable_employee_id: Optional[str] = None,
        unavailable_date: Optional[str] = None,
        approved_leaves: Optional[List[Tuple[str, str]]] = None,  # (emp_id, date)
        weekly_off_changes: Optional[Dict[str, List[int]]] = None,  # emp_id -> list of preferred offs
        calendar_changes: Optional[Dict[Tuple[str, str], OperatingRule]] = None,  # (brand_id, proc_id) -> new rule
        min_staff_changes: Optional[Dict[Tuple[str, str], int]] = None,  # (brand_id, proc_id) -> new min_staff
        timeout_seconds: float = 10.0,
    ) -> Tuple[SchedulingResult, ReoptimizationDelta]:
        """Re-optimize an existing schedule against operational changes."""
        # Clone input data to avoid mutating original
        new_input_dict = base_input.to_dict()
        new_input = SchedulingInput.from_dict(new_input_dict)
        new_input.timeout_seconds = timeout_seconds
        new_input.enable_reoptimization = True

        # Build reference assignments from current_entries
        reference_assignments: List[ReferenceAssignment] = []
        for entry in current_entries:
            for proc_id in entry.processes:
                reference_assignments.append(
                    ReferenceAssignment(
                        employee_id=entry.employee_id,
                        brand_id=entry.brand_id,
                        process_id=proc_id,
                        date=entry.date,
                    )
                )
        new_input.reference_roster = reference_assignments

        # 1. Apply single employee unavailability
        if unavailable_employee_id and unavailable_date:
            for emp in new_input.employees:
                if emp.id == unavailable_employee_id:
                    if unavailable_date not in emp.leaves:
                        emp.leaves.append(unavailable_date)

        # 2. Apply batch approved leaves
        if approved_leaves:
            emp_map = {e.id: e for e in new_input.employees}
            for emp_id, leave_date in approved_leaves:
                if emp_id in emp_map and leave_date not in emp_map[emp_id].leaves:
                    emp_map[emp_id].leaves.append(leave_date)

        # 3. Apply weekly-off changes
        if weekly_off_changes:
            emp_map = {e.id: e for e in new_input.employees}
            for emp_id, offs in weekly_off_changes.items():
                if emp_id in emp_map:
                    emp_map[emp_id].weekly_off = list(offs)

        # 4. Apply operating calendar changes
        if calendar_changes:
            for b in new_input.brands:
                for bp in b.processes:
                    key = (b.id, bp.process_id)
                    if key in calendar_changes:
                        bp.rule = calendar_changes[key]

        # 5. Apply min_staff changes
        if min_staff_changes:
            for b in new_input.brands:
                for bp in b.processes:
                    key = (b.id, bp.process_id)
                    if key in min_staff_changes:
                        bp.min_staff = min_staff_changes[key]

        # Run CP-SAT solver with reference roster
        engine = SchedulingEngine(new_input)
        result = engine.solve(lexicographic=True)

        # Compute delta metrics
        delta = cls._compute_delta(reference_assignments, result.entries)
        return result, delta

    @classmethod
    def _compute_delta(
        cls,
        reference_assignments: List[ReferenceAssignment],
        new_entries: List[RosterEntry],
    ) -> ReoptimizationDelta:
        ref_set: Set[Tuple[str, str, str, str]] = {
            (ra.employee_id, ra.brand_id, ra.process_id, ra.date)
            for ra in reference_assignments
        }

        new_set: Set[Tuple[str, str, str, str]] = set()
        for e in new_entries:
            for p in e.processes:
                new_set.add((e.employee_id, e.brand_id, p, e.date))

        added = [
            {"employee_id": item[0], "brand_id": item[1], "process_id": item[2], "date": item[3]}
            for item in sorted(list(new_set - ref_set))
        ]
        removed = [
            {"employee_id": item[0], "brand_id": item[1], "process_id": item[2], "date": item[3]}
            for item in sorted(list(ref_set - new_set))
        ]

        total_changes = len(added) + len(removed)
        total_ref = len(ref_set)
        unaffected = len(ref_set.intersection(new_set))
        stability = (unaffected / total_ref) if total_ref > 0 else 1.0

        return ReoptimizationDelta(
            total_changes=total_changes,
            added_assignments=added,
            removed_assignments=removed,
            unaffected_assignments_count=unaffected,
            stability_ratio=round(stability, 4),
        )
