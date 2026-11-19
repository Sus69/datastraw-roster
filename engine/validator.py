"""Independent Hard-Constraint Validator for Workforce Scheduling.

Verifies generated rosters against every mathematical constraint without trusting
the solver output.
"""

from __future__ import annotations

import datetime
from typing import Dict, List, Set, Tuple

from .domain import (
    OperatingRule,
    ProcessId,
    RosterEntry,
    SchedulingInput,
)


def get_weekday(iso_date: str) -> int:
    """Return weekday integer 0=Sun, 1=Mon, ..., 6=Sat (matching JS getDay convention)."""
    # Python datetime.weekday(): 0=Mon, 1=Tue, ..., 6=Sun
    # JS getDay(): 0=Sun, 1=Mon, ..., 6=Sat
    dt = datetime.date.fromisoformat(iso_date)
    py_wd = dt.weekday()
    return (py_wd + 1) % 7


def is_process_operating(
    rule: OperatingRule,
    iso_date: str,
    holiday_dates: Set[str],
    custom_dates: Set[str],
) -> bool:
    """Determine whether a process operates on a given date under its calendar rule."""
    if rule == OperatingRule.CUSTOM:
        return iso_date in custom_dates
    is_hol = iso_date in holiday_dates
    if rule == OperatingRule.ALL_YEAR:
        return True
    if rule == OperatingRule.EXCEPT_HOLIDAYS:
        return not is_hol
    if rule == OperatingRule.NO_SUN_HOLIDAYS:
        is_sun = get_weekday(iso_date) == 0
        return (not is_hol) and (not is_sun)
    return True


class RosterValidator:
    """Independent verifier for hard constraints."""

    @classmethod
    def validate(
        cls,
        input_data: SchedulingInput,
        entries: List[RosterEntry],
        employee_days: Dict[str, Dict[str, str]] | None = None,
    ) -> Tuple[bool, List[str]]:
        """Validate every hard constraint against the roster entries.

        Returns:
            (is_valid, list_of_violations)
        """
        violations: List[str] = []

        holiday_dates = {h.date for h in input_data.holidays}
        emp_map = {e.id: e for e in input_data.employees}
        brand_map = {b.id: b for b in input_data.brands}

        # Authorizations map: (emp_id, brand_id, process_id) -> role
        alloc_map: Dict[Tuple[str, str, str], str] = {}
        for a in input_data.allocations:
            alloc_map[(a.employee_id, a.brand_id, a.process_id)] = a.role.lower()

        # Incompatibility map: set of frozen pairs
        incompat_pairs: Set[Tuple[Tuple[str, str], Tuple[str, str]]] = set()
        for ip in input_data.incompatible_pairs:
            p1 = (ip.brand_id_1, ip.process_id_1)
            p2 = (ip.brand_id_2, ip.process_id_2)
            incompat_pairs.add((p1, p2))
            incompat_pairs.add((p2, p1))

        # Check entries for assignments
        # emp_id -> date -> set of (brand_id, process_id)
        emp_date_procs: Dict[Tuple[str, str], Set[Tuple[str, str]]] = {}
        # (brand_id, process_id, date) -> set of scheduled employee_ids
        proc_date_scheduled: Dict[Tuple[str, str, str], Set[str]] = {}

        for entry in entries:
            emp = emp_map.get(entry.employee_id)
            if not emp:
                violations.append(f"Unknown employee {entry.employee_id} in roster entry on {entry.date}.")
                continue

            # Hard Constraint: Employee Availability (Leave / Comp-off)
            is_unavailable = (entry.date in emp.leaves) or (entry.date in emp.comp_offs)
            if is_unavailable and len(entry.processes) > 0:
                violations.append(
                    f"Employee {emp.name} ({emp.id}) is scheduled on {entry.date} while on approved leave/comp-off."
                )

            for proc_id in entry.processes:
                q_key = (entry.brand_id, proc_id)
                ed_key = (entry.employee_id, entry.date)
                emp_date_procs.setdefault(ed_key, set()).add(q_key)

                # Track coverage
                proc_key = (entry.brand_id, proc_id, entry.date)
                proc_date_scheduled.setdefault(proc_key, set()).add(entry.employee_id)

                # Hard Constraint: Assignment Eligibility
                alloc_key = (entry.employee_id, entry.brand_id, proc_id)
                if alloc_key not in alloc_map:
                    violations.append(
                        f"Unauthorized assignment: Employee {emp.name} ({emp.id}) assigned to "
                        f"{entry.brand_id}-{proc_id} on {entry.date} without primary or backup authorization."
                    )

                # Hard Constraint: Operating Calendar
                brand = brand_map.get(entry.brand_id)
                bp = next((p for p in (brand.processes if brand else []) if p.process_id == proc_id), None)
                if bp:
                    custom_dates = set(bp.custom_operating_dates)
                    operating = is_process_operating(bp.rule, entry.date, holiday_dates, custom_dates)
                    if not operating:
                        violations.append(
                            f"Operating calendar violation: Employee {emp.name} ({emp.id}) assigned to "
                            f"{entry.brand_id}-{proc_id} on {entry.date}, but process is closed."
                        )

        # Hard Constraint: Incompatible Assignments
        for (emp_id, date), assigned_procs in emp_date_procs.items():
            assigned_list = list(assigned_procs)
            for i in range(len(assigned_list)):
                for j in range(i + 1, len(assigned_list)):
                    pair = (assigned_list[i], assigned_list[j])
                    if pair in incompat_pairs:
                        emp = emp_map.get(emp_id)
                        emp_label = emp.name if emp else emp_id
                        violations.append(
                            f"Incompatible duty conflict: Employee {emp_label} ({emp_id}) assigned to both "
                            f"{pair[0][0]}-{pair[0][1]} and {pair[1][0]}-{pair[1][1]} on {date}."
                        )

        # Hard Constraint: Minimum Process Coverage
        dates = input_data.dates
        if not dates and entries:
            dates = sorted(list({e.date for e in entries}))

        for brand in input_data.brands:
            for bp in brand.processes:
                custom_dates = set(bp.custom_operating_dates)
                for date in dates:
                    operating = is_process_operating(bp.rule, date, holiday_dates, custom_dates)
                    if operating and bp.min_staff > 0:
                        proc_key = (brand.id, bp.process_id, date)
                        scheduled = proc_date_scheduled.get(proc_key, set())
                        if len(scheduled) < bp.min_staff:
                            violations.append(
                                f"Minimum coverage shortage: Brand {brand.name} ({brand.id}) process "
                                f"{bp.process_id} on {date} has {len(scheduled)} staff scheduled, but requires {bp.min_staff}."
                            )

        # Hard Constraint: Weekly-off Entitlement and Exclusivity
        # Group dates into 7-day calendar weeks
        if dates and employee_days:
            # Check weekly off entitlements per 7-day block
            # Split dates into weeks of up to 7 days
            weeks = [dates[i : i + 7] for i in range(0, len(dates), 7)]
            for emp in input_data.employees:
                emp_states = employee_days.get(emp.id, {})
                for w_idx, week_dates in enumerate(weeks):
                    if len(week_dates) == 7:
                        offs = sum(1 for d in week_dates if emp_states.get(d) == "OFF")
                        min_off = emp.min_weekly_off
                        max_off = emp.max_weekly_off
                        if offs < min_off:
                            violations.append(
                                f"Weekly-off entitlement underflow: Employee {emp.name} ({emp.id}) has {offs} offs "
                                f"in week {w_idx + 1}, required minimum is {min_off}."
                            )
                        if offs > max_off:
                            violations.append(
                                f"Weekly-off entitlement overflow: Employee {emp.name} ({emp.id}) has {offs} offs "
                                f"in week {w_idx + 1}, maximum allowed is {max_off}."
                            )

        is_valid = len(violations) == 0
        return is_valid, violations
