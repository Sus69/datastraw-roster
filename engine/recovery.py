"""Roster Recovery Engine for the Python CP-SAT scheduling stack.

This is the Python counterpart of ``src/lib/recovery.ts``. It does not simply
look for a free employee: it simulates moving a candidate off their current
assignment, recomputes coverage for every affected brand/process on the date,
and rejects any repair that creates a new shortfall. Permanent allocations are
never modified; the returned instruction is date-specific.

The engine works with both assignment semantics:
- ``process``: legacy CP-SAT entries carry one process each.
- ``brand``: UI/business-rule entries cover every allocated process at a brand.

Recovery has three independent stages:
1. ``evaluate_eligibility`` — one centralized hard-rule evaluator.
2. ``analyze`` — simulation, source-impact calculation and lexicographic ranking.
3. ``validate`` — independent reconstruction that does not trust candidate flags.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .domain import (
    Brand,
    DayCoverage,
    ProcessId,
    RosterEntry,
    SchedulingInput,
)
from .validator import RosterValidator, get_weekday, is_process_operating


RECOVERY_REJECTION_TEXT = {
    "UNKNOWN_EMPLOYEE": "Employee does not exist in the roster model.",
    "UNKNOWN_TARGET": "Target brand or process does not exist in the roster model.",
    "TARGET_NOT_OPERATING": "Target process is not operating on this date.",
    "ON_LEAVE_OR_COMP_OFF": "On approved leave or comp-off on this date.",
    "ALREADY_ASSIGNED_TARGET": "Already assigned to the target brand/process on this date.",
    "CANDIDATE_DOUBLE_BOOKED": "Candidate already has multiple assignments on this date.",
    "NO_COMPATIBLE_PROCESS_ALLOCATION": "No allocation for the required process.",
    "NO_DESTINATION_AUTHORIZATION": (
        "No explicit destination brand/process authorization; process experience alone is not enough."
    ),
    "REASSIGNMENT_CAUSES_UNDERSTAFFING": (
        "Reassignment would cause understaffing elsewhere (cascading coverage failure)."
    ),
    "TARGET_NOT_COVERED": "The move would not actually cover the target slot.",
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
class RecoverySourceImpact:
    brand_id: str
    brand_name: str
    process_id: ProcessId
    required: int
    before_scheduled: int
    after_scheduled: int
    remaining_slack: int
    remains_covered: bool
    primary_owned_by_candidate: bool
    candidate_still_covers: bool
    covered_by_other_employees: bool

    def to_dict(self) -> Dict[str, object]:
        return {
            "brand_id": self.brand_id,
            "brand_name": self.brand_name,
            "process_id": self.process_id,
            "required": self.required,
            "before_scheduled": self.before_scheduled,
            "after_scheduled": self.after_scheduled,
            "remaining_slack": self.remaining_slack,
            "remains_covered": self.remains_covered,
            "primary_owned_by_candidate": self.primary_owned_by_candidate,
            "candidate_still_covers": self.candidate_still_covers,
            "covered_by_other_employees": self.covered_by_other_employees,
        }


@dataclass
class RecoveryEligibility:
    employee_id: str
    employee_name: str
    eligible: bool
    current_assignment: Optional[Dict[str, object]] = None
    recovery_type: Optional[str] = None
    allocation_type: Optional[str] = None
    target_authorized: bool = False
    process_authorized: bool = False
    same_pod: bool = False
    cross_pod_authorized: bool = False
    rejection_code: Optional[str] = None
    rejection_reason: Optional[str] = None

    def to_dict(self) -> Dict[str, object]:
        return {
            "employee_id": self.employee_id,
            "employee_name": self.employee_name,
            "eligible": self.eligible,
            "current_assignment": self.current_assignment,
            "recovery_type": self.recovery_type,
            "allocation_type": self.allocation_type,
            "target_authorized": self.target_authorized,
            "process_authorized": self.process_authorized,
            "same_pod": self.same_pod,
            "cross_pod_authorized": self.cross_pod_authorized,
            "rejection_code": self.rejection_code,
            "rejection_reason": self.rejection_reason,
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
    source_impact: List[RecoverySourceImpact] = field(default_factory=list)
    source_processes_at_minimum: int = 0
    hard_constraints_satisfied: bool = False
    valid: bool = False
    rejection_code: Optional[str] = None
    rejection_reason: Optional[str] = None
    reasons: List[str] = field(default_factory=list)
    ranking_key: List[int] = field(default_factory=list)
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
            "source_impact": [i.to_dict() for i in self.source_impact],
            "source_processes_at_minimum": self.source_processes_at_minimum,
            "hard_constraints_satisfied": self.hard_constraints_satisfied,
            "valid": self.valid,
            "rejection_code": self.rejection_code,
            "rejection_reason": self.rejection_reason,
            "reasons": self.reasons,
            "ranking_key": self.ranking_key,
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
    def _target_authorized(
        cls, input_data: SchedulingInput, employee_id: str, brand_id: str, process_id: ProcessId
    ) -> bool:
        return any(
            a.employee_id == employee_id
            and a.brand_id == brand_id
            and a.process_id == process_id
            for a in input_data.allocations
        )

    @classmethod
    def _process_authorized(
        cls, input_data: SchedulingInput, employee_id: str, process_id: ProcessId
    ) -> bool:
        return any(
            a.employee_id == employee_id and a.process_id == process_id
            for a in input_data.allocations
        )

    @classmethod
    def _cross_pod_authorized(
        cls, input_data: SchedulingInput, employee_id: str, brand_id: str, process_id: ProcessId
    ) -> bool:
        return any(
            c.employee_id == employee_id
            and c.brand_id == brand_id
            and c.process_id == process_id
            for c in input_data.cross_pod_authorizations
        )

    @classmethod
    def _primary_owned(
        cls, input_data: SchedulingInput, employee_id: str, brand_id: str, process_id: ProcessId
    ) -> bool:
        return any(
            a.employee_id == employee_id
            and a.brand_id == brand_id
            and a.process_id == process_id
            and a.is_primary
            for a in input_data.allocations
        )

    @classmethod
    def _current_entries(
        cls, entries: List[RosterEntry], date: str, employee_id: str
    ) -> List[RosterEntry]:
        return [e for e in entries if e.date == date and e.employee_id == employee_id]

    @classmethod
    def _display_current(
        cls, input_data: SchedulingInput, entry: Optional[RosterEntry]
    ) -> Optional[Dict[str, object]]:
        if entry is None:
            return None
        brand = next((b for b in input_data.brands if b.id == entry.brand_id), None)
        return {
            "brand_id": entry.brand_id,
            "brand_name": brand.name if brand else entry.brand_id,
            "processes": list(entry.processes),
            "is_primary": any(
                a.employee_id == entry.employee_id
                and a.brand_id == entry.brand_id
                and a.is_primary
                for a in input_data.allocations
            ),
        }

    @classmethod
    def evaluate_eligibility(
        cls,
        input_data: SchedulingInput,
        entries: List[RosterEntry],
        date: str,
        brand_id: str,
        process_id: ProcessId,
        employee_id: str,
        exclude_employee_id: Optional[str] = None,
    ) -> RecoveryEligibility:
        """Centralized hard-rule evaluator used by discovery and validation."""
        emp = next((e for e in input_data.employees if e.id == employee_id), None)
        brand = next((b for b in input_data.brands if b.id == brand_id), None)
        target_bp = (
            next((p for p in brand.processes if p.process_id == process_id), None)
            if brand
            else None
        )
        if employee_id == exclude_employee_id:
            return RecoveryEligibility(
                employee_id=employee_id,
                employee_name=emp.name if emp else employee_id,
                eligible=False,
                rejection_code="NO_ELIGIBLE_EMPLOYEE",
                rejection_reason=RECOVERY_REJECTION_TEXT["NO_ELIGIBLE_EMPLOYEE"],
            )
        if emp is None:
            return RecoveryEligibility(
                employee_id=employee_id,
                employee_name=employee_id,
                eligible=False,
                rejection_code="UNKNOWN_EMPLOYEE",
                rejection_reason=RECOVERY_REJECTION_TEXT["UNKNOWN_EMPLOYEE"],
            )
        if brand is None or target_bp is None:
            return RecoveryEligibility(
                employee_id=employee_id,
                employee_name=emp.name,
                eligible=False,
                rejection_code="UNKNOWN_TARGET",
                rejection_reason=RECOVERY_REJECTION_TEXT["UNKNOWN_TARGET"],
            )

        assignments = cls._current_entries(entries, date, employee_id)
        current = assignments[0] if assignments else None
        current_assignment = cls._display_current(input_data, current)
        target_authorized = cls._target_authorized(input_data, employee_id, brand_id, process_id)
        process_authorized = cls._process_authorized(input_data, employee_id, process_id)
        same_pod = emp.pod_id == brand.pod_id
        cross_pod_authorized = cls._cross_pod_authorized(
            input_data, employee_id, brand_id, process_id
        )
        base = RecoveryEligibility(
            employee_id=employee_id,
            employee_name=emp.name,
            eligible=False,
            current_assignment=current_assignment,
            target_authorized=target_authorized,
            process_authorized=process_authorized,
            same_pod=same_pod,
            cross_pod_authorized=cross_pod_authorized,
        )

        if not is_process_operating(
            target_bp.rule, date, {h.date for h in input_data.holidays},
            set(target_bp.custom_operating_dates),
        ):
            base.rejection_code = "TARGET_NOT_OPERATING"
            base.rejection_reason = RECOVERY_REJECTION_TEXT["TARGET_NOT_OPERATING"]
            return base
        if date in emp.leaves or date in emp.comp_offs:
            base.rejection_code = "ON_LEAVE_OR_COMP_OFF"
            base.rejection_reason = RECOVERY_REJECTION_TEXT["ON_LEAVE_OR_COMP_OFF"]
            return base
        if len(assignments) > 1:
            base.rejection_code = "CANDIDATE_DOUBLE_BOOKED"
            base.rejection_reason = RECOVERY_REJECTION_TEXT["CANDIDATE_DOUBLE_BOOKED"]
            return base
        if current is not None and current.brand_id == brand_id and process_id in current.processes:
            base.rejection_code = "ALREADY_ASSIGNED_TARGET"
            base.rejection_reason = RECOVERY_REJECTION_TEXT["ALREADY_ASSIGNED_TARGET"]
            return base

        if current is not None:
            recovery_type = (
                "same-brand-reassignment"
                if current.brand_id == brand_id
                else "cross-brand-reassignment"
            )
            base.recovery_type = recovery_type
            base.allocation_type = "temporary-reassignment"
            if not target_authorized and not cross_pod_authorized:
                base.rejection_code = "NO_DESTINATION_AUTHORIZATION"
                base.rejection_reason = RECOVERY_REJECTION_TEXT["NO_DESTINATION_AUTHORIZATION"]
                return base
            base.eligible = True
            return base

        if target_authorized:
            base.eligible = True
            base.recovery_type = "direct-backup"
            base.allocation_type = "temporary-backup"
            return base
        if same_pod and process_authorized:
            base.eligible = True
            base.recovery_type = "same-pod-backup"
            base.allocation_type = "temporary-backup"
            return base
        if process_authorized:
            base.rejection_code = "NO_DESTINATION_AUTHORIZATION"
            base.rejection_reason = RECOVERY_REJECTION_TEXT["NO_DESTINATION_AUTHORIZATION"]
            return base
        base.rejection_code = "NO_COMPATIBLE_PROCESS_ALLOCATION"
        base.rejection_reason = RECOVERY_REJECTION_TEXT["NO_COMPATIBLE_PROCESS_ALLOCATION"]
        return base

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
        # Legacy process semantics keep one process per entry; brand semantics
        # let one working day cover every allocated process at the destination.
        if getattr(input_data, "assignment_semantics", "process") != "brand":
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

        next_entries = [RosterEntry(**e.to_dict()) for e in entries]
        if allocation_type == "temporary-reassignment":
            next_entries = [
                e for e in next_entries if not (e.employee_id == emp_id and e.date == date)
            ]
        if brand is None or emp is None or date in emp.leaves or date in emp.comp_offs:
            return next_entries

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
        date: str,
        brand_id: str,
        process_id: ProcessId,
        employee_id: str,
        eligibility: RecoveryEligibility,
        **overrides: object,
    ) -> RecoveryCandidate:
        emp = next((e for e in input_data.employees if e.id == employee_id), None)
        brand = next((b for b in input_data.brands if b.id == brand_id), None)
        code = eligibility.rejection_code or "NO_ELIGIBLE_EMPLOYEE"
        data: Dict[str, object] = {
            "employee_id": employee_id,
            "name": emp.name if emp else employee_id,
            "current_assignment": eligibility.current_assignment,
            "target_assignment": {
                "brand_id": brand_id,
                "brand_name": brand.name if brand else brand_id,
                "process_id": process_id,
            },
            "recovery_type": eligibility.recovery_type
            or ("cross-brand-reassignment" if eligibility.current_assignment else "direct-backup"),
            "allocation_type": eligibility.allocation_type
            or ("temporary-reassignment" if eligibility.current_assignment else "temporary-backup"),
            "changed_assignments": 2 if eligibility.current_assignment else 1,
            "primary_disruption": 0,
            "weekly_off_overrides": 1 if emp and get_weekday(date) in emp.weekly_off else 0,
            "additional_staffing": 0,
            "coverage_impact": [],
            "source_impact": [],
            "source_processes_at_minimum": 0,
            "hard_constraints_satisfied": False,
            "valid": False,
            "rejection_code": code,
            "rejection_reason": eligibility.rejection_reason
            or RECOVERY_REJECTION_TEXT[code],
            "reasons": [eligibility.rejection_reason or RECOVERY_REJECTION_TEXT[code]],
            "ranking_key": [],
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
        cross_pod_pool = {
            c.employee_id
            for c in input_data.cross_pod_authorizations
            if c.brand_id == brand_id and c.process_id == process_id
        }
        pool = same_brand_pool | same_pod_pool | assigned_other | cross_pod_pool
        if exclude_employee_id:
            pool.discard(exclude_employee_id)

        proposals: List[RecoveryCandidate] = []
        rejected: List[RecoveryCandidate] = []

        for employee_id in sorted(pool):
            emp = next((e for e in input_data.employees if e.id == employee_id), None)
            if emp is None:
                continue

            eligibility = cls.evaluate_eligibility(
                input_data, entries, date, brand_id, process_id, employee_id,
                exclude_employee_id,
            )
            if not eligibility.eligible:
                rejected.append(
                    cls._rejection(
                        input_data, date, brand_id, process_id, employee_id, eligibility
                    )
                )
                continue

            current = cls._current_entries(entries, date, employee_id)
            current_entry = current[0] if current else None
            directive = {
                "date": date,
                "employee_id": employee_id,
                "brand_id": brand_id,
                "process_id": process_id,
                "type": eligibility.allocation_type,
                "from_brand_id": current_entry.brand_id if current_entry else None,
                "from_processes": list(current_entry.processes) if current_entry else None,
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
                cascading_eligibility = RecoveryEligibility(
                    employee_id=employee_id,
                    employee_name=emp.name,
                    eligible=False,
                    current_assignment=eligibility.current_assignment,
                    recovery_type=eligibility.recovery_type,
                    allocation_type=eligibility.allocation_type,
                    rejection_code="REASSIGNMENT_CAUSES_UNDERSTAFFING",
                    rejection_reason=RECOVERY_REJECTION_TEXT["REASSIGNMENT_CAUSES_UNDERSTAFFING"],
                )
                rejected.append(
                    cls._rejection(
                        input_data, date, brand_id, process_id, employee_id,
                        cascading_eligibility,
                        coverage_impact=impact,
                        reasons=[
                            f"Moving {emp.name} would leave {cascading_name} "
                            f"{cascading.process_id} at {len(cascading.scheduled)}/{cascading.required}."
                        ],
                    )
                )
                continue
            if not target_covered:
                target_eligibility = RecoveryEligibility(
                    employee_id=employee_id,
                    employee_name=emp.name,
                    eligible=False,
                    current_assignment=eligibility.current_assignment,
                    recovery_type=eligibility.recovery_type,
                    allocation_type=eligibility.allocation_type,
                    rejection_code="TARGET_NOT_COVERED",
                    rejection_reason=RECOVERY_REJECTION_TEXT["TARGET_NOT_COVERED"],
                )
                rejected.append(
                    cls._rejection(
                        input_data, date, brand_id, process_id, employee_id,
                        target_eligibility,
                        coverage_impact=impact,
                    )
                )
                continue

            current_brand = (
                next((b for b in input_data.brands if b.id == current_entry.brand_id), None)
                if current_entry
                else None
            )
            after_entry = next(
                (
                    e for e in simulated
                    if e.date == date and e.employee_id == employee_id and e.brand_id == brand_id
                ),
                None,
            )
            source_impact: List[RecoverySourceImpact] = []
            if current_entry is not None and current_brand is not None:
                for p in current_entry.processes:
                    before_slot = before_by_key.get((current_entry.brand_id, p))
                    after_slot = after_by_key.get((current_entry.brand_id, p))
                    if before_slot is None or after_slot is None or not before_slot.operating:
                        continue
                    still_covers = bool(after_entry and p in after_entry.processes)
                    source_impact.append(
                        RecoverySourceImpact(
                            brand_id=current_entry.brand_id,
                            brand_name=current_brand.name,
                            process_id=p,
                            required=after_slot.required,
                            before_scheduled=len(before_slot.scheduled),
                            after_scheduled=len(after_slot.scheduled),
                            remaining_slack=len(after_slot.scheduled) - after_slot.required,
                            remains_covered=after_slot.status == "covered",
                            primary_owned_by_candidate=cls._primary_owned(
                                input_data, employee_id, current_entry.brand_id, p
                            ),
                            candidate_still_covers=still_covers,
                            covered_by_other_employees=any(
                                other != employee_id for other in after_slot.scheduled
                            ),
                        )
                    )

            lost_source_processes = [s for s in source_impact if not s.candidate_still_covers]
            primary_disruption = sum(
                1 for s in lost_source_processes if s.primary_owned_by_candidate
            )
            source_processes_at_minimum = sum(
                1 for s in lost_source_processes if s.after_scheduled == s.required
            )
            changed = 1 if current_entry is None or current_entry.brand_id == brand_id else 2
            weekly_off = 1 if get_weekday(date) in emp.weekly_off else 0
            additional = (
                1
                if eligibility.recovery_type == "same-pod-backup"
                or (
                    eligibility.allocation_type == "temporary-reassignment"
                    and not eligibility.target_authorized
                )
                else 0
            )
            current_workload = sum(1 for entry in entries if entry.employee_id == employee_id)
            ranking_key = [
                changed,
                primary_disruption,
                source_processes_at_minimum,
                weekly_off,
                additional,
                current_workload,
            ]

            reasons = []
            if eligibility.recovery_type == "direct-backup":
                reasons.append("Free on this date and explicitly allocated to the destination brand/process.")
            elif eligibility.recovery_type == "same-pod-backup":
                reasons.append("Free on this date; same pod and allocated to the required process.")
            else:
                reasons.append("Safe to move: all source processes remain above minimum.")
            if primary_disruption:
                reasons.append(
                    f"Primary ownership changes for {primary_disruption} source process(es), "
                    "with cover maintained by another assigned employee."
                )
            if weekly_off:
                reasons.append("Would work a preferred weekly off (flagged as a warning).")
            if additional:
                reasons.append(
                    "Needs date-specific temporary authorization; permanent allocations are unchanged."
                )

            proposals.append(
                RecoveryCandidate(
                    employee_id=employee_id,
                    name=emp.name,
                    current_assignment=eligibility.current_assignment,
                    target_assignment={
                        "brand_id": brand_id,
                        "brand_name": brand.name,
                        "process_id": process_id,
                    },
                    recovery_type=eligibility.recovery_type or "direct-backup",
                    allocation_type=eligibility.allocation_type or "temporary-backup",
                    changed_assignments=changed,
                    primary_disruption=primary_disruption,
                    weekly_off_overrides=weekly_off,
                    additional_staffing=additional,
                    coverage_impact=impact,
                    source_impact=source_impact,
                    source_processes_at_minimum=source_processes_at_minimum,
                    hard_constraints_satisfied=True,
                    valid=True,
                    reasons=reasons,
                    ranking_key=ranking_key,
                    score=0,
                    directive=directive,
                )
            )

        proposals.sort(key=lambda p: (
            tuple(p.ranking_key), p.name, p.employee_id
        ))
        for index, proposal in enumerate(proposals):
            # Legacy field retained for API compatibility. Ordering is ranking_key.
            proposal.score = index
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
        """Independently reconstruct and validate one proposed repair.

        The candidate's ``valid`` / ``hard_constraints_satisfied`` flags are
        deliberately ignored; only its directive is used as input.
        """
        directive = candidate.directive

        def failure(code: str, message: str, **extra: object) -> Dict[str, object]:
            return {
                "valid": False,
                "hard_constraints_satisfied": False,
                "reason": message,
                "failures": [{"code": code, "message": message, **extra}],
                "coverage_impact": [i.to_dict() for i in candidate.coverage_impact],
                "new_conflicts": [],
            }

        if not directive:
            return failure("NO_DIRECTIVE", "Proposal has no date-specific recovery directive.")

        emp_id = str(directive["employee_id"])
        date = str(directive["date"])
        brand_id = str(directive["brand_id"])
        process_id = str(directive["process_id"])
        allocation_type = str(directive["type"])
        emp = next((e for e in input_data.employees if e.id == emp_id), None)
        brand = next((b for b in input_data.brands if b.id == brand_id), None)
        bp = next((p for p in brand.processes if p.process_id == process_id), None) if brand else None
        if emp is None:
            return failure("UNKNOWN_EMPLOYEE", "Unknown employee.", employee_id=emp_id)
        if brand is None or bp is None:
            return failure(
                "UNKNOWN_TARGET", "Unknown destination brand or process.",
                brand_id=brand_id, process_id=process_id,
            )
        if not is_process_operating(
            bp.rule, date, {h.date for h in input_data.holidays},
            set(bp.custom_operating_dates),
        ):
            return failure(
                "TARGET_NOT_OPERATING", "Target process is closed.",
                brand_id=brand_id, process_id=process_id,
            )
        if date in emp.leaves or date in emp.comp_offs:
            return failure(
                "ON_LEAVE_OR_COMP_OFF", "Employee is unavailable.",
                employee_id=emp_id,
            )

        eligibility = cls.evaluate_eligibility(
            input_data, entries, date, brand_id, process_id, emp_id
        )
        if not eligibility.eligible:
            return failure(
                "NOT_ELIGIBLE", eligibility.rejection_reason or "Candidate is not eligible.",
                employee_id=emp_id, brand_id=brand_id, process_id=process_id,
            )
        if eligibility.allocation_type != allocation_type:
            return failure(
                "ALLOCATION_TYPE_MISMATCH",
                f"Directive is {allocation_type}, but the employee must use {eligibility.allocation_type}.",
                employee_id=emp_id, brand_id=brand_id, process_id=process_id,
            )

        allocations_before = [a.to_dict() for a in input_data.allocations]
        simulated = cls._simulate(input_data, entries, directive)
        allocations_after = [a.to_dict() for a in input_data.allocations]
        before_lookup = {
            (c.brand_id, c.process_id): c
            for c in cls._coverage(input_data, entries, date)
        }
        after_lookup = {
            (c.brand_id, c.process_id): c
            for c in cls._coverage(input_data, simulated, date)
        }

        failures: List[Dict[str, object]] = []
        if allocations_before != allocations_after:
            failures.append({
                "code": "PERMANENT_ALLOCATION_MUTATED",
                "message": "Recovery simulation changed a permanent allocation.",
                "employee_id": emp_id,
            })

        candidate_entries = [
            e for e in simulated if e.date == date and e.employee_id == emp_id
        ]
        candidate_brands = {e.brand_id for e in candidate_entries}
        if len(candidate_entries) != 1 or len(candidate_brands) != 1:
            failures.append({
                "code": "DOUBLE_BOOKED",
                "message": (
                    f"{emp.name} would have {len(candidate_entries)} assignment(s) "
                    f"across {len(candidate_brands)} brand(s) on {date}."
                ),
                "employee_id": emp_id,
            })

        target = after_lookup.get((brand_id, process_id))
        if target is None or target.status != "covered":
            failures.append({
                "code": "TARGET_UNDERSTAFFED",
                "message": f"{brand.name} {process_id} would still be "
                f"{target.status if target else 'not covered'} after the repair.",
                "brand_id": brand_id,
                "process_id": process_id,
            })

        for key, slot in after_lookup.items():
            if not slot.operating:
                continue
            prior = before_lookup.get(key)
            if prior is None:
                continue
            if len(slot.scheduled) < len(prior.scheduled) and len(slot.scheduled) < slot.required:
                failures.append({
                    "code": "SOURCE_UNDERSTAFFED",
                    "message": (
                        f"{next((b.name for b in input_data.brands if b.id == slot.brand_id), slot.brand_id)} "
                        f"{slot.process_id} would fall to {len(slot.scheduled)}/{slot.required}."
                    ),
                    "brand_id": slot.brand_id,
                    "process_id": slot.process_id,
                })

        before_report = RosterValidator.validate(input_data, entries, None)
        after_report = RosterValidator.validate(input_data, simulated, None)
        before_hard = set(before_report.hard_failures)
        new_hard = [message for message in after_report.hard_failures if message not in before_hard]
        # A temporary same-pod or explicitly authorized recovery assignment is
        # itself the date-specific authorization. The roster validator only
        # knows permanent allocations, so ignore its authorization warning for
        # this candidate's destination slot.
        target_unauthorized = (
            f"Unauthorized employee assignment: {emp.name} ({emp.id}) "
            f"assigned to {brand_id}-{process_id}"
        )
        new_hard = [message for message in new_hard if not message.startswith(target_unauthorized)]
        # A successfully repaired target gap disappears from the new-hard list,
        # so any genuinely new hard failure is an independent rejection reason.
        for message in new_hard:
            failures.append({"code": "NEW_HARD_CONSTRAINT", "message": message})

        coverage_impact: List[Dict[str, object]] = []
        for key, slot in after_lookup.items():
            if not slot.operating:
                continue
            prior = before_lookup.get(key)
            if prior is None:
                continue
            if (
                prior.status != slot.status
                or len(prior.scheduled) != len(slot.scheduled)
                or slot.brand_id == brand_id
            ):
                coverage_impact.append(
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
                    ).to_dict()
                )

        valid = not failures
        return {
            "valid": valid,
            "hard_constraints_satisfied": valid,
            "reason": (
                f"All hard constraints remain satisfied. {emp.name} is cleared to cover "
                f"{brand.name} {process_id} on {date}."
                if valid
                else " ".join(f["message"] for f in failures)
            ),
            "failures": failures,
            "coverage_impact": coverage_impact,
            "new_conflicts": new_hard,
        }
