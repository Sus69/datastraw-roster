"""Roster Recovery Engine for the Python CP-SAT scheduling stack.

This is the Python counterpart of ``src/lib/recovery.ts``. It does not simply
look for a free employee: it simulates moving a candidate off their current
assignment, recomputes coverage for every affected brand/process on the date,
and rejects any repair that creates a new shortfall. Permanent allocations are
never modified; the returned instruction is date-specific.

The engine works with both assignment semantics:
- ``process``: legacy CP-SAT entries carry one process each.
- ``brand``: UI/business-rule entries cover every allocated process at a brand.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from .domain import (
    Brand,
    DayCoverage,
    Employee,
    ProcessId,
    RosterEntry,
    SchedulingInput,
)
from .validator import get_weekday, is_process_operating


RECOVERY_REJECTION_TEXT = {
    "ALREADY_ASSIGNED_TARGET": "Already assigned to the target brand/process on this date.",
    "ALREADY_ASSIGNED_OTHER_BRAND": "Already assigned to another brand.",
    "NO_COMPATIBLE_PROCESS_ALLOCATION": "No compatible process allocation for the target process.",
    "ON_LEAVE_OR_COMP_OFF": "On approved leave or comp-off on this date.",
    "REASSIGNMENT_CAUSES_UNDERSTAFFING": "Reassignment would cause understaffing elsewhere (cascading coverage failure).",
    "TARGET_NOT_COVERED": "The move would not actually cover the target slot.",
    "OUTSIDE_PERMITTED_POOL": "Outside the permitted same-brand / same-pod / cross-brand pool.",
    "NO_ELIGIBLE_EMPLOYEE": "No eligible employee exists in the permitted pool.",
}


@dataclass
class RecoveryImpact:
    brand_id: str
    brand_name: str
    process_id: ProcessId
    required: int
    before_scheduled: int
    after_scheduled: int
    before_status: str
    after_status: str

    def to_dict(self) -> Dict[str, object]:
        return {
            "brand_id": self.brand_id,
            "brand_name": self.brand_name,
            "process_id": self.process_id,
            "required": self.required,
            "before_scheduled": self.before_scheduled,
            "after_scheduled": self.after_scheduled,
            "before_status": self.before_status,
            "after_status": self.after_status,
        }


@dataclass
class RecoveryCandidate:
    employee_id: str
    name: str
    current_assignment: Optional[Dict[str, object]]
    target_assignment: Dict[str, object]
    recovery_type: str
    allocation_type: str
    changed_assignments: int
    primary_disruption: int
    weekly_off_overrides: int
    additional_staffing: int
    coverage_impact: List[RecoveryImpact] = field(default_factory=list)
    hard_constraints_satisfied: bool = False
    valid: bool = False
    rejection_code: Optional[str] = None
    rejection_reason: Optional[str] = None
    reasons: List[str] = field(default_factory=list)
    score: int = 0
    directive: Optional[Dict[str, object]] = None

    def to_dict(self) -> Dict[str, object]:
        return {
            "employee_id": self.employee_id,
            "name": self.name,
            "current_assignment": self.current_assignment,
            "target_assignment": self.target_assignment,
            "recovery_type": self.recovery_type,
            "allocation_type": self.allocation_type,
            "changed_assignments": self.changed_assignments,
            "primary_disruption": self.primary_disruption,
            "weekly_off_overrides": self.weekly_off_overrides,
            "additional_staffing": self.additional_staffing,
            "coverage_impact": [i.to_dict() for i in self.coverage_impact],
            "hard_constraints_satisfied": self.hard_constraints_satisfied,
            "valid": self.valid,
            "rejection_code": self.rejection_code,
            "rejection_reason": self.rejection_reason,
            "reasons": self.reasons,
            "score": self.score,
            "directive": self.directive,
        }


@dataclass
class RecoveryAnalysis:
    date: str
    brand_id: str
    process_id: ProcessId
    proposals: List[RecoveryCandidate] = field(default_factory=list)
    rejected: List[RecoveryCandidate] = field(default_factory=list)
    pool_size: int = 0
    explanation: str = ""

    def to_dict(self) -> Dict[str, object]:
        return {
            "date": self.date,
            "brand_id": self.brand_id,
            "process_id": self.process_id,
            "proposals": [p.to_dict() for p in self.proposals],
            "rejected": [r.to_dict() for r in self.rejected],
            "pool_size": self.pool_size,
            "explanation": self.explanation,
        }


class RosterRecoveryEngine:
    """Constraint-aware recovery evaluation and ranking."""

    @classmethod
    def _coverage(
        cls, input_data: SchedulingInput, entries: List[RosterEntry], date: str
    ) -> List[DayCoverage]:
        holiday_dates = {h.date for h in input_data.holidays}
        day_entries = [e for e in entries if e.date == date]
        coverage: List[DayCoverage] = []
        for brand in input_data.brands:
            for bp in brand.processes:
                operating = is_process_operating(
                    bp.rule, date, holiday_dates, set(bp.custom_operating_dates)
                )
                if not operating:
                    coverage.append(
                        DayCoverage(
                            date=date,
                            brand_id=brand.id,
                            process_id=bp.process_id,
                            operating=False,
                            required=bp.min_staff,
                            scheduled=[],
                            shortage=0,
                            status="not-operating",
                        )
                    )
                    continue
                scheduled = [
                    e.employee_id
                    for e in day_entries
                    if e.brand_id == brand.id and bp.process_id in e.processes
                ]
                shortage = max(0, bp.min_staff - len(scheduled))
                status = (
                    "covered"
                    if shortage == 0
                    else ("gap" if len(scheduled) == 0 else "understaffed")
                )
                coverage.append(
                    DayCoverage(
                        date=date,
                        brand_id=brand.id,
                        process_id=bp.process_id,
                        operating=True,
                        required=bp.min_staff,
                        scheduled=scheduled,
                        shortage=shortage,
                        status=status,
                    )
                )
        return coverage

    @classmethod
    def _recovery_processes(
        cls,
        input_data: SchedulingInput,
        employee_id: str,
        brand: Brand,
        target_process: ProcessId,
        allocation_type: str,
        date: str,
    ) -> List[ProcessId]:
        if allocation_type == "temporary-backup":
            return [target_process]
        holiday_dates = {h.date for h in input_data.holidays}
        authorized = {
            a.process_id
            for a in input_data.allocations
            if a.employee_id == employee_id and a.brand_id == brand.id
        }
        processes = [
            bp.process_id
            for bp in brand.processes
            if bp.process_id in authorized
            and is_process_operating(bp.rule, date, holiday_dates, set(bp.custom_operating_dates))
        ]
        if target_process not in processes:
            processes.append(target_process)
        return processes

    @classmethod
    def _simulate(
        cls, input_data: SchedulingInput, entries: List[RosterEntry], directive: Dict[str, object]
    ) -> List[RosterEntry]:
        emp_id = str(directive["employee_id"])
        date = str(directive["date"])
        brand_id = str(directive["brand_id"])
        process_id = str(directive["process_id"])
        allocation_type = str(directive["type"])
        brand = next((b for b in input_data.brands if b.id == brand_id), None)
        emp = next((e for e in input_data.employees if e.id == emp_id), None)
        if brand is None or emp is None or date in emp.leaves or date in emp.comp_offs:
            return [RosterEntry(**e.to_dict()) for e in entries if not (e.employee_id == emp_id and e.date == date)]

        next_entries = [
            RosterEntry(**e.to_dict())
            for e in entries
            if not (e.employee_id == emp_id and e.date == date)
        ]
        processes = cls._recovery_processes(
            input_data, emp_id, brand, process_id, allocation_type, date
        )
        next_entries.append(
            RosterEntry(
                date=date,
                employee_id=emp_id,
                brand_id=brand_id,
                processes=processes,
                is_weekly_off=get_weekday(date) in emp.weekly_off,
                is_backup=allocation_type == "temporary-backup",
            )
        )
        return next_entries

    @classmethod
    def _rejection(
        cls,
        input_data: SchedulingInput,
        entries: List[RosterEntry],
        date: str,
        brand_id: str,
        process_id: ProcessId,
        employee_id: str,
        code: str,
        **overrides: object,
    ) -> RecoveryCandidate:
        emp = next((e for e in input_data.employees if e.id == employee_id), None)
        brand = next((b for b in input_data.brands if b.id == brand_id), None)
        current = next((e for e in entries if e.date == date and e.employee_id == employee_id), None)
        current_brand = (
            next((b for b in input_data.brands if b.id == current.brand_id), None)
            if current
            else None
        )
        data: Dict[str, object] = {
            "employee_id": employee_id,
            "name": emp.name if emp else employee_id,
            "current_assignment": (
                {
                    "brand_id": current.brand_id,
                    "brand_name": current_brand.name if current_brand else current.brand_id,
                    "processes": list(current.processes),
                    "is_primary": any(
                        a.employee_id == employee_id
                        and a.brand_id == current.brand_id
                        and a.is_primary
                        for a in input_data.allocations
                    ),
                }
                if current
                else None
            ),
            "target_assignment": {
                "brand_id": brand_id,
                "brand_name": brand.name if brand else brand_id,
                "process_id": process_id,
            },
            "recovery_type": "cross-brand-reassignment" if current else "direct-backup",
            "allocation_type": "temporary-reassignment" if current else "temporary-backup",
            "changed_assignments": 2 if current else 1,
            "primary_disruption": 0,
            "weekly_off_overrides": 1 if emp and get_weekday(date) in emp.weekly_off else 0,
            "additional_staffing": 0,
            "coverage_impact": [],
            "hard_constraints_satisfied": False,
            "valid": False,
            "rejection_code": code,
            "rejection_reason": RECOVERY_REJECTION_TEXT[code],
            "reasons": [RECOVERY_REJECTION_TEXT[code]],
            "score": 2**31 - 1,
            "directive": None,
        }
        data.update(overrides)
        return RecoveryCandidate(**data)  # type: ignore[arg-type]

    @classmethod
    def analyze(
        cls,
        input_data: SchedulingInput,
        entries: List[RosterEntry],
        date: str,
        brand_id: str,
        process_id: ProcessId,
        exclude_employee_id: Optional[str] = None,
    ) -> RecoveryAnalysis:
        holiday_dates = {h.date for h in input_data.holidays}
        brand = next((b for b in input_data.brands if b.id == brand_id), None)
        target_bp = (
            next((p for p in brand.processes if p.process_id == process_id), None)
            if brand
            else None
        )
        if brand is None or target_bp is None:
            return RecoveryAnalysis(
                date=date,
                brand_id=brand_id,
                process_id=process_id,
                explanation="Target brand/process does not exist in the roster model.",
            )

        before = cls._coverage(input_data, entries, date)
        before_by_key = {(c.brand_id, c.process_id): c for c in before}
        same_day = [e for e in entries if e.date == date]
        assigned_other = {e.employee_id for e in same_day if e.brand_id != brand_id}
        same_brand_pool = {
            a.employee_id for a in input_data.allocations if a.brand_id == brand_id
        }
        same_pod_pool = {e.id for e in input_data.employees if e.pod_id == brand.pod_id}
        pool = same_brand_pool | same_pod_pool | assigned_other
        if exclude_employee_id:
            pool.discard(exclude_employee_id)

        proposals: List[RecoveryCandidate] = []
        rejected: List[RecoveryCandidate] = []

        for employee_id in sorted(pool):
            emp = next((e for e in input_data.employees if e.id == employee_id), None)
            if emp is None:
                continue
            target_allocation = any(
                a.employee_id == employee_id
                and a.brand_id == brand_id
                and a.process_id == process_id
                for a in input_data.allocations
            )
            process_allocation_any = any(
                a.employee_id == employee_id and a.process_id == process_id
                for a in input_data.allocations
            )
            same_pod = emp.pod_id == brand.pod_id
            current = next(
                (e for e in same_day if e.employee_id == employee_id), None
            )
            currently_target = (
                current is not None
                and current.brand_id == brand_id
                and process_id in current.processes
            )

            if date in emp.leaves or date in emp.comp_offs:
                rejected.append(
                    cls._rejection(
                        input_data, entries, date, brand_id, process_id, employee_id,
                        "ON_LEAVE_OR_COMP_OFF",
                    )
                )
                continue
            if currently_target:
                rejected.append(
                    cls._rejection(
                        input_data, entries, date, brand_id, process_id, employee_id,
                        "ALREADY_ASSIGNED_TARGET",
                    )
                )
                continue
            if not target_allocation and not process_allocation_any:
                rejected.append(
                    cls._rejection(
                        input_data, entries, date, brand_id, process_id, employee_id,
                        "NO_COMPATIBLE_PROCESS_ALLOCATION",
                    )
                )
                continue
            if current is None and not target_allocation and not (same_pod and process_allocation_any):
                rejected.append(
                    cls._rejection(
                        input_data, entries, date, brand_id, process_id, employee_id,
                        "OUTSIDE_PERMITTED_POOL",
                    )
                )
                continue
            if current is not None and current.brand_id != brand_id and not same_pod and not process_allocation_any and not target_allocation:
                rejected.append(
                    cls._rejection(
                        input_data, entries, date, brand_id, process_id, employee_id,
                        "OUTSIDE_PERMITTED_POOL",
                    )
                )
                continue

            recovery_type = (
                "same-brand-reassignment"
                if current is not None and current.brand_id == brand_id
                else "cross-brand-reassignment"
                if current is not None
                else "direct-backup"
                if target_allocation
                else "same-pod-backup"
            )
            allocation_type = "temporary-reassignment" if current else "temporary-backup"
            directive = {
                "date": date,
                "employee_id": employee_id,
                "brand_id": brand_id,
                "process_id": process_id,
                "type": allocation_type,
                "from_brand_id": current.brand_id if current else None,
                "from_processes": list(current.processes) if current else None,
                "id": f"recovery-{date}-{employee_id}-{brand_id}-{process_id}",
            }

            simulated = cls._simulate(input_data, entries, directive)
            after = cls._coverage(input_data, simulated, date)
            after_by_key = {(c.brand_id, c.process_id): c for c in after}

            impact: List[RecoveryImpact] = []
            cascading: Optional[DayCoverage] = None
            for slot in after:
                if not slot.operating:
                    continue
                prior = before_by_key.get((slot.brand_id, slot.process_id))
                if prior is None:
                    continue
                if (
                    prior.status != slot.status
                    or len(prior.scheduled) != len(slot.scheduled)
                    or (slot.brand_id == brand_id and slot.process_id == process_id)
                ):
                    impact.append(
                        RecoveryImpact(
                            brand_id=slot.brand_id,
                            brand_name=next(
                                (b.name for b in input_data.brands if b.id == slot.brand_id),
                                slot.brand_id,
                            ),
                            process_id=slot.process_id,
                            required=slot.required,
                            before_scheduled=len(prior.scheduled),
                            after_scheduled=len(slot.scheduled),
                            before_status=prior.status,
                            after_status=slot.status,
                        )
                    )
                if len(slot.scheduled) < len(prior.scheduled) and len(slot.scheduled) < slot.required:
                    cascading = slot

            target_after = after_by_key.get((brand_id, process_id))
            target_covered = target_after is not None and target_after.status == "covered"

            if cascading is not None:
                cascading_name = next(
                    (b.name for b in input_data.brands if b.id == cascading.brand_id),
                    cascading.brand_id,
                )
                rejected.append(
                    cls._rejection(
                        input_data, entries, date, brand_id, process_id, employee_id,
                        "REASSIGNMENT_CAUSES_UNDERSTAFFING",
                        recovery_type=recovery_type,
                        allocation_type=allocation_type,
                        coverage_impact=impact,
                        reasons=[
                            f"Moving {emp.name} would leave {cascading_name} "
                            f"{cascading.process_id} at {len(cascading.scheduled)}/{cascading.required}."
                        ],
                    )
                )
                continue
            if not target_covered:
                rejected.append(
                    cls._rejection(
                        input_data, entries, date, brand_id, process_id, employee_id,
                        "TARGET_NOT_COVERED",
                        recovery_type=recovery_type,
                        allocation_type=allocation_type,
                        coverage_impact=impact,
                    )
                )
                continue

            is_primary = bool(
                current
                and any(
                    a.employee_id == employee_id
                    and a.brand_id == current.brand_id
                    and a.is_primary
                    for a in input_data.allocations
                )
            )
            changed = 1 if current is None or current.brand_id == brand_id else 2
            primary_disruption = 1 if is_primary else 0
            weekly_off = 1 if get_weekday(date) in emp.weekly_off else 0
            additional = 0 if target_allocation else 1
            score = changed * 1000 + primary_disruption * 100 + weekly_off * 10 + additional

            reasons = []
            if recovery_type == "direct-backup":
                reasons.append("Free on this date and permanently allocated to the target process.")
            elif recovery_type == "same-pod-backup":
                reasons.append("Free on this date; same pod and has target-process experience.")
            else:
                reasons.append("Safe to move: no other coverage falls below minimum.")
            if weekly_off:
                reasons.append("Would work a preferred weekly off (flagged as a warning).")
            if additional:
                reasons.append("Needs date-specific temporary authorization; permanent allocations are unchanged.")

            proposals.append(
                RecoveryCandidate(
                    employee_id=employee_id,
                    name=emp.name,
                    current_assignment=(
                        {
                            "brand_id": current.brand_id,
                            "brand_name": next(
                                (b.name for b in input_data.brands if b.id == current.brand_id),
                                current.brand_id,
                            ),
                            "processes": list(current.processes),
                            "is_primary": is_primary,
                        }
                        if current
                        else None
                    ),
                    target_assignment={
                        "brand_id": brand_id,
                        "brand_name": brand.name,
                        "process_id": process_id,
                    },
                    recovery_type=recovery_type,
                    allocation_type=allocation_type,
                    changed_assignments=changed,
                    primary_disruption=primary_disruption,
                    weekly_off_overrides=weekly_off,
                    additional_staffing=additional,
                    coverage_impact=impact,
                    hard_constraints_satisfied=True,
                    valid=True,
                    reasons=reasons,
                    score=score,
                    directive=directive,
                )
            )

        proposals.sort(key=lambda p: (p.score, p.name, p.employee_id))
        rejected.sort(key=lambda p: (p.name, p.employee_id))

        explanation = ""
        if not proposals:
            counts: Dict[str, int] = {}
            for r in rejected:
                if r.rejection_code:
                    counts[r.rejection_code] = counts.get(r.rejection_code, 0) + 1
            parts = [
                f"{RECOVERY_REJECTION_TEXT[code]} ({count})"
                for code, count in sorted(counts.items())
            ]
            explanation = (
                f"No safe repair was found. {' '.join(parts)}"
                if parts
                else RECOVERY_REJECTION_TEXT["NO_ELIGIBLE_EMPLOYEE"]
            )

        return RecoveryAnalysis(
            date=date,
            brand_id=brand_id,
            process_id=process_id,
            proposals=proposals,
            rejected=rejected,
            pool_size=len(pool),
            explanation=explanation,
        )

    @classmethod
    def validate(
        cls,
        input_data: SchedulingInput,
        entries: List[RosterEntry],
        candidate: RecoveryCandidate,
    ) -> Dict[str, object]:
        """Independent validation gate for one proposed repair."""
        if not candidate.valid or not candidate.directive:
            return {
                "valid": False,
                "hard_constraints_satisfied": False,
                "reason": candidate.rejection_reason or "Proposal is not a valid repair.",
            }
        directive = candidate.directive
        emp_id = str(directive["employee_id"])
        date = str(directive["date"])
        brand_id = str(directive["brand_id"])
        process_id = str(directive["process_id"])
        emp = next((e for e in input_data.employees if e.id == emp_id), None)
        brand = next((b for b in input_data.brands if b.id == brand_id), None)
        bp = next((p for p in brand.processes if p.process_id == process_id), None) if brand else None
        if emp is None or brand is None or bp is None:
            return {"valid": False, "hard_constraints_satisfied": False, "reason": "Unknown employee/brand/process."}
        if date in emp.leaves or date in emp.comp_offs:
            return {"valid": False, "hard_constraints_satisfied": False, "reason": "Employee is unavailable."}
        if not is_process_operating(bp.rule, date, {h.date for h in input_data.holidays}, set(bp.custom_operating_dates)):
            return {"valid": False, "hard_constraints_satisfied": False, "reason": "Target process is closed."}

        before = {(c.brand_id, c.process_id): c for c in cls._coverage(input_data, entries, date)}
        simulated = cls._simulate(input_data, entries, directive)
        after = {(c.brand_id, c.process_id): c for c in cls._coverage(input_data, simulated, date)}

        regressions = [
            slot
            for key, slot in after.items()
            if key in before
            and len(slot.scheduled) < len(before[key].scheduled)
            and len(slot.scheduled) < slot.required
        ]
        target = after.get((brand_id, process_id))
        valid = target is not None and target.status == "covered" and not regressions and len(simulated) > 0
        return {
            "valid": valid,
            "hard_constraints_satisfied": valid,
            "reason": (
                f"All hard constraints remain satisfied. {emp.name} is cleared to cover {brand.name} {process_id} on {date}."
                if valid
                else "The repair would create a new coverage gap elsewhere."
                if regressions
                else "The target slot would still not be covered."
            ),
            "coverage_impact": [i.to_dict() for i in candidate.coverage_impact],
        }
