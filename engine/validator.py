"""Independent Hard-Constraint Validator and Reporting Engine.

Categorizes roster validation results into:
- Hard-constraint failures: Leave clashes, comp-off clashes, multiple daily assignments,
  unauthorized assignments, closed process assignments, and coverage shortages.
- Warnings: Preferred weekly-off overrides, backup resource assignments.
- Informational results: Available unassigned employees, normal weekly offs, coverage maintained.
"""

from __future__ import annotations

import datetime
from typing import Dict, List, Set, Tuple

from .domain import (
    OperatingRule,
    ProcessId,
    RosterEntry,
    SchedulingInput,
    ValidationReport,
)


def get_weekday(iso_date: str) -> int:
    """Return weekday integer 0=Sun, 1=Mon, ..., 6=Sat (matching JS getDay convention)."""
    dt = datetime.date.fromisoformat(iso_date)
    return (dt.weekday() + 1) % 7


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
    """Independent validator separating hard-constraint failures, warnings, and informational results."""

    @classmethod
    def validate(
        cls,
        input_data: SchedulingInput,
        entries: List[RosterEntry],
        employee_days: Dict[str, Dict[str, str]] | None = None,
    ) -> ValidationReport:
        hard_failures: List[str] = []
        warnings: List[str] = []
        informational: List[str] = []

        holiday_dates = {h.date for h in input_data.holidays}
        emp_map = {e.id: e for e in input_data.employees}
        brand_map = {b.id: b for b in input_data.brands}

        # Authorizations map: (emp_id, brand_id, process_id) -> role ('primary' or 'backup')
        alloc_map: Dict[Tuple[str, str, str], str] = {}
        for a in input_data.allocations:
            alloc_map[(a.employee_id, a.brand_id, a.process_id)] = a.role.lower()

        # Incompatibility map
        incompat_pairs: Set[Tuple[Tuple[str, str], Tuple[str, str]]] = set()
        for ip in input_data.incompatible_pairs:
            p1 = (ip.brand_id_1, ip.process_id_1)
            p2 = (ip.brand_id_2, ip.process_id_2)
            incompat_pairs.add((p1, p2))
            incompat_pairs.add((p2, p1))

        # emp_id -> date -> list of (brand_id, process_id)
        emp_date_procs: Dict[Tuple[str, str], List[Tuple[str, str]]] = {}
        # (brand_id, process_id, date) -> list of scheduled employee_ids
        proc_date_scheduled: Dict[Tuple[str, str, str], List[str]] = {}

        # 1. Inspect Roster Entries
        for entry in entries:
            emp = emp_map.get(entry.employee_id)
            if not emp:
                hard_failures.append(f"Unknown employee {entry.employee_id} in roster on {entry.date}.")
                continue

            # Hard Constraint: Approved Leave and Comp-off
            if entry.date in emp.leaves:
                hard_failures.append(
                    f"Employee {emp.name} ({emp.id}) is scheduled on {entry.date} during approved leave."
                )
            if entry.date in emp.comp_offs:
                hard_failures.append(
                    f"Employee {emp.name} ({emp.id}) is scheduled on {entry.date} during approved comp-off."
                )

            # Record processes
            ed_key = (entry.employee_id, entry.date)
            for proc_id in entry.processes:
                q_key = (entry.brand_id, proc_id)
                emp_date_procs.setdefault(ed_key, []).append(q_key)

                proc_key = (entry.brand_id, proc_id, entry.date)
                proc_date_scheduled.setdefault(proc_key, []).append(entry.employee_id)

                # Hard Constraint: Assignment Eligibility
                alloc_key = (entry.employee_id, entry.brand_id, proc_id)
                role = alloc_map.get(alloc_key)
                if role is None:
                    hard_failures.append(
                        f"Unauthorized employee assignment: {emp.name} ({emp.id}) assigned to "
                        f"{entry.brand_id}-{proc_id} on {entry.date} without authorization."
                    )
                elif role == "backup":
                    warnings.append(
                        f"Backup assignment: {emp.name} ({emp.id}) deployed as backup for "
                        f"{entry.brand_id}-{proc_id} on {entry.date}."
                    )

                # Hard Constraint: Operating Calendar
                brand = brand_map.get(entry.brand_id)
                bp = next((p for p in (brand.processes if brand else []) if p.process_id == proc_id), None)
                if bp:
                    custom_dates = set(bp.custom_operating_dates)
                    operating = is_process_operating(bp.rule, entry.date, holiday_dates, custom_dates)
                    if not operating:
                        hard_failures.append(
                            f"Operating calendar violation: Employee {emp.name} ({emp.id}) assigned to "
                            f"{entry.brand_id}-{proc_id} on {entry.date}, but process is closed."
                        )

            # Warning: Preferred weekly off overridden
            wd = get_weekday(entry.date)
            if wd in emp.weekly_off and len(entry.processes) > 0:
                warnings.append(
                    f"Preferred weekly off overridden: {emp.name} ({emp.id}) scheduled on preferred off "
                    f"({entry.date}) to cover {entry.brand_id} ({', '.join(entry.processes)})."
                )

        # 2. Hard Constraint: Exclusive Daily Employee Assignment
        # Legacy process semantics: at most one brand/process per day.
        # Brand semantics: at most one brand per day; several processes at that
        # brand are one working day and are explicitly allowed.
        brand_semantics = getattr(input_data, "assignment_semantics", "process") == "brand"
        for (emp_id, date), procs in emp_date_procs.items():
            if brand_semantics:
                distinct_brands = {b for b, _ in procs}
                if len(distinct_brands) > 1:
                    emp = emp_map.get(emp_id)
                    emp_name = emp.name if emp else emp_id
                    proc_desc = ", ".join(f"{b}-{p}" for b, p in procs)
                    hard_failures.append(
                        f"Multiple daily assignments: Employee {emp_name} ({emp_id}) assigned to "
                        f"{len(distinct_brands)} brands on {date} ({proc_desc}). Max allowed is 1 brand."
                    )
            elif len(procs) > 1:
                emp = emp_map.get(emp_id)
                emp_name = emp.name if emp else emp_id
                proc_desc = ", ".join(f"{b}-{p}" for b, p in procs)
                hard_failures.append(
                    f"Multiple daily assignments: Employee {emp_name} ({emp_id}) assigned to "
                    f"{len(procs)} brand/process combinations on {date} ({proc_desc}). Max allowed is 1."
                )

            # Incompatible duty check
            for i in range(len(procs)):
                for j in range(i + 1, len(procs)):
                    pair = (procs[i], procs[j])
                    if pair in incompat_pairs:
                        emp = emp_map.get(emp_id)
                        emp_name = emp.name if emp else emp_id
                        hard_failures.append(
                            f"Incompatible duty assignment: Employee {emp_name} ({emp_id}) assigned to both "
                            f"{pair[0][0]}-{pair[0][1]} and {pair[1][0]}-{pair[1][1]} on {date}."
                        )

        # 3. Hard Constraint: Missing Mandatory Operational Coverage
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
                        scheduled = proc_date_scheduled.get(proc_key, [])
                        if len(scheduled) < bp.min_staff:
                            hard_failures.append(
                                f"Missing mandatory operational coverage: Brand {brand.name} ({brand.id}) process "
                                f"{bp.process_id} on {date} has {len(scheduled)} of {bp.min_staff} required staff scheduled."
                            )
                        else:
                            informational.append(
                                f"Coverage successfully maintained: {brand.id}-{bp.process_id} on {date} "
                                f"({len(scheduled)}/{bp.min_staff} staff)."
                            )

        # 4. Informational Results: Employee States
        if employee_days:
            for emp in input_data.employees:
                emp_states = employee_days.get(emp.id, {})
                for d, state in emp_states.items():
                    if state == "UNASSIGNED":
                        informational.append(
                            f"Available but unassigned: Employee {emp.name} ({emp.id}) available but unassigned on {d}."
                        )
                    elif state == "OFF" and get_weekday(d) in emp.weekly_off:
                        informational.append(
                            f"Normal weekly-off allocation: Employee {emp.name} ({emp.id}) on weekly off on {d}."
                        )

        is_valid = len(hard_failures) == 0
        return ValidationReport(
            is_valid=is_valid,
            hard_failures=hard_failures,
            warnings=warnings,
            informational=informational,
        )
