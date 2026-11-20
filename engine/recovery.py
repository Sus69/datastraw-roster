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

import datetime
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
    "NO_CROSS_POD_AUTHORIZATION": (
        "Destination is outside the employee pod and no explicit cross-pod authorization exists."
    ),
    "REASSIGNMENT_CAUSES_UNDERSTAFFING": (
        "Reassignment would cause understaffing elsewhere (cascading coverage failure)."
    ),
    "TARGET_NOT_COVERED": "The move would not actually cover the target slot.",
    "INCOMPATIBLE_DUTY": "The destination processes are explicitly incompatible.",
    "SIMULATION_INVALID": "The recovery directive could not be simulated safely.",
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
    effect: str = "changed"  # resolved | introduced | changed

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
            "effect": self.effect,
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
    destination_authorized: bool = False
    same_pod: bool = False
    cross_pod_required: bool = False
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
            "destination_authorized": self.destination_authorized,
            "same_pod": self.same_pod,
            "cross_pod_required": self.cross_pod_required,
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
    source_coverage_loss: int = 0
    current_workload: int = 0
    removed_assignments: List[Dict[str, object]] = field(default_factory=list)
    added_assignments: List[Dict[str, object]] = field(default_factory=list)
    hard_constraints_satisfied: bool = False
    valid: bool = False
    rejection_code: Optional[str] = None
    rejection_reason: Optional[str] = None
    reasons: List[str] = field(default_factory=list)
    ranking_key: List[int] = field(default_factory=list)
    ranking_explanation: str = ""
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
            "removed_assignments": self.removed_assignments,
            "added_assignments": self.added_assignments,
            "source_coverage_loss": self.source_coverage_loss,
            "primary_disruption": self.primary_disruption,
            "weekly_off_overrides": self.weekly_off_overrides,
            "additional_staffing": self.additional_staffing,
            "coverage_impact": [i.to_dict() for i in self.coverage_impact],
            "source_impact": [i.to_dict() for i in self.source_impact],
            "source_processes_at_minimum": self.source_processes_at_minimum,
            "current_workload": self.current_workload,
            "hard_constraints_satisfied": self.hard_constraints_satisfied,
            "valid": self.valid,
            "rejection_code": self.rejection_code,
            "rejection_reason": self.rejection_reason,
            "reasons": self.reasons,
            "ranking_key": self.ranking_key,
            "ranking_explanation": self.ranking_explanation,
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


def _impact_effect(before: DayCoverage, after: DayCoverage) -> str:
    if before.status != "covered" and after.status == "covered":
        return "resolved"
    if after.status != "covered" and (
        before.status == "covered" or len(after.scheduled) < len(before.scheduled)
    ):
        return "introduced"
    return "changed"


def _same_process_set(left: List[ProcessId], right: List[ProcessId]) -> bool:
    return sorted(left) == sorted(right)


def _entry_signature(entry: RosterEntry) -> str:
    return "|".join(
        [
            entry.date,
            entry.employee_id,
            entry.brand_id,
            ",".join(sorted(entry.processes)),
            "override" if entry.is_weekly_off else "normal",
        ]
    )


def _directive_source(directive: Dict[str, object]) -> tuple[object, object]:
    from_brand = directive.get("from_brand_id", directive.get("fromBrandId"))
    from_processes = directive.get("from_processes", directive.get("fromProcesses"))
    return from_brand, from_processes


def _find_incompatible_duty(
    input_data: SchedulingInput, brand_id: str, processes: List[ProcessId]
) -> Optional[tuple[ProcessId, ProcessId]]:
    for index, first in enumerate(processes):
        for second in processes[index + 1:]:
            for pair in input_data.incompatible_pairs:
                forward = (
                    pair.brand_id_1 == brand_id
                    and pair.process_id_1 == first
                    and pair.brand_id_2 == brand_id
                    and pair.process_id_2 == second
                )
                reverse = (
                    pair.brand_id_1 == brand_id
                    and pair.process_id_1 == second
                    and pair.brand_id_2 == brand_id
                    and pair.process_id_2 == first
                )
                if forward or reverse:
                    return first, second
    return None


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
        cross_pod_authorized = cls._cross_pod_authorized(
            input_data, employee_id, brand_id, process_id
        )
        destination_authorized = target_authorized or cross_pod_authorized
        same_pod = emp.pod_id == brand.pod_id
        cross_pod_required = not same_pod
        base = RecoveryEligibility(
            employee_id=employee_id,
            employee_name=emp.name,
            eligible=False,
            current_assignment=current_assignment,
            target_authorized=target_authorized,
            process_authorized=process_authorized,
            destination_authorized=destination_authorized,
            same_pod=same_pod,
            cross_pod_required=cross_pod_required,
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
            if not destination_authorized:
                base.rejection_code = "NO_DESTINATION_AUTHORIZATION"
                base.rejection_reason = RECOVERY_REJECTION_TEXT["NO_DESTINATION_AUTHORIZATION"]
                return base
            if (
                cross_pod_required
                and current.brand_id != brand_id
                and not cross_pod_authorized
            ):
                base.rejection_code = "NO_CROSS_POD_AUTHORIZATION"
                base.rejection_reason = RECOVERY_REJECTION_TEXT["NO_CROSS_POD_AUTHORIZATION"]
                return base
            base.eligible = True
            return base

        if destination_authorized:
            if cross_pod_required and not cross_pod_authorized:
                base.rejection_code = "NO_CROSS_POD_AUTHORIZATION"
                base.rejection_reason = RECOVERY_REJECTION_TEXT["NO_CROSS_POD_AUTHORIZATION"]
                return base
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
    def _simulate_detailed(
        cls, input_data: SchedulingInput, entries: List[RosterEntry], directive: Dict[str, object]
    ) -> Dict[str, object]:
        """Return immutable entries, exact changes, and explicit invalid-input issues."""
        baseline = [RosterEntry(**e.to_dict()) for e in entries]
        issues: List[Dict[str, str]] = []

        def failed(code: str, message: str) -> Dict[str, object]:
            return {
                "entries": baseline,
                "removed": [],
                "added": [],
                "issues": [*issues, {"code": code, "message": message}],
                "valid": False,
            }

        required = ("date", "employee_id", "brand_id", "process_id", "type")
        if not isinstance(directive, dict) or any(
            not isinstance(directive.get(key), str) or not directive.get(key)
            for key in required
        ):
            return failed("INVALID_DIRECTIVE", "Recovery directive is malformed or incomplete.")
        try:
            datetime.date.fromisoformat(str(directive["date"]))
        except ValueError:
            return failed("INVALID_DIRECTIVE", "Recovery directive has an invalid date.")

        emp_id = str(directive["employee_id"])
        date = str(directive["date"])
        brand_id = str(directive["brand_id"])
        process_id = str(directive["process_id"])
        allocation_type = str(directive["type"])
        if allocation_type not in ("temporary-backup", "temporary-reassignment"):
            return failed("INVALID_DIRECTIVE", "Recovery directive has an unknown assignment type.")
        source_brand, source_processes = _directive_source(directive)
        if source_brand is not None and not isinstance(source_brand, str):
            return failed("INVALID_DIRECTIVE", "Recovery directive has malformed source metadata.")
        if source_processes is not None and (
            not isinstance(source_processes, list)
            or not all(isinstance(process, str) for process in source_processes)
        ):
            return failed("INVALID_DIRECTIVE", "Recovery directive has malformed source metadata.")

        current = [e for e in baseline if e.employee_id == emp_id and e.date == date]
        if len(current) > 1:
            return failed(
                "DUPLICATE_ASSIGNMENT",
                f"{emp_id} already has {len(current)} assignments on {date}.",
            )

        brand = next((b for b in input_data.brands if b.id == brand_id), None)
        target_bp = (
            next((p for p in brand.processes if p.process_id == process_id), None)
            if brand
            else None
        )
        emp = next((e for e in input_data.employees if e.id == emp_id), None)
        if emp is None:
            return failed("UNKNOWN_EMPLOYEE", f"Unknown employee {emp_id}.")
        if brand is None or target_bp is None:
            return failed("UNKNOWN_TARGET", f"Unknown destination {brand_id}-{process_id}.")
        if not is_process_operating(
            target_bp.rule,
            date,
            {h.date for h in input_data.holidays},
            set(target_bp.custom_operating_dates),
        ):
            return failed(
                "TARGET_NOT_OPERATING",
                f"{brand.name} {process_id} is not operating on {date}.",
            )
        if date in emp.leaves or date in emp.comp_offs:
            return failed("EMPLOYEE_UNAVAILABLE", f"{emp.name} is unavailable on {date}.")

        from_brand, from_processes = _directive_source(directive)
        has_source_metadata = from_brand is not None or (
            isinstance(from_processes, list) and len(from_processes) > 0
        )
        if allocation_type == "temporary-reassignment":
            if (
                len(current) != 1
                or from_brand != current[0].brand_id
                or not isinstance(from_processes, list)
                or not all(isinstance(p, str) for p in from_processes)
                or not _same_process_set(list(from_processes), current[0].processes)
            ):
                return failed(
                    "SOURCE_METADATA_MISMATCH",
                    "Source metadata does not match the baseline assignment.",
                )
        else:
            if current:
                return failed(
                    "ALREADY_ASSIGNED",
                    "A temporary backup cannot be added for an employee who is already assigned.",
                )
            if has_source_metadata:
                return failed(
                    "SOURCE_METADATA_MISMATCH",
                    "A temporary backup must not claim a source assignment.",
                )

        # Build the complete destination entry before planning any removal.
        # Every precondition above has passed; a failure while constructing
        # the destination still leaves the baseline and simulation plan intact.
        processes = cls._recovery_processes(
            input_data, emp_id, brand, process_id, allocation_type, date
        )
        added = RosterEntry(
            date=date,
            employee_id=emp_id,
            brand_id=brand_id,
            processes=processes,
            is_weekly_off=get_weekday(date) in emp.weekly_off,
            is_backup=allocation_type == "temporary-backup",
        )
        removed = (
            [RosterEntry(**e.to_dict()) for e in current]
            if allocation_type == "temporary-reassignment"
            else []
        )
        retained = [RosterEntry(**e.to_dict()) for e in baseline]
        if allocation_type == "temporary-reassignment":
            retained = [
                e for e in retained if not (e.employee_id == emp_id and e.date == date)
            ]
        return {
            "entries": [*retained, added],
            "removed": removed,
            "added": [added],
            "issues": [],
            "valid": True,
        }

    @classmethod
    def _simulate(
        cls, input_data: SchedulingInput, entries: List[RosterEntry], directive: Dict[str, object]
    ) -> List[RosterEntry]:
        simulation = cls._simulate_detailed(input_data, entries, directive)
        if not simulation["valid"]:
            messages = " ".join(
                str(issue["message"])
                for issue in simulation["issues"]  # type: ignore[union-attr]
            )
            raise ValueError(f"Invalid recovery simulation: {messages}")
        return simulation["entries"]  # type: ignore[return-value]

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
            "removed_assignments": [],
            "added_assignments": [],
            "source_coverage_loss": 0,
            "current_workload": 0,
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
            "ranking_explanation": eligibility.rejection_reason or RECOVERY_REJECTION_TEXT[code],
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

            simulation = cls._simulate_detailed(input_data, entries, directive)
            if not simulation["valid"]:
                messages = [
                    str(issue["message"])
                    for issue in simulation["issues"]  # type: ignore[union-attr]
                ]
                simulation_eligibility = RecoveryEligibility(
                    employee_id=employee_id,
                    employee_name=emp.name,
                    eligible=False,
                    current_assignment=eligibility.current_assignment,
                    recovery_type=eligibility.recovery_type,
                    allocation_type=eligibility.allocation_type,
                    rejection_code="SIMULATION_INVALID",
                    rejection_reason=" ".join(messages),
                )
                rejected.append(
                    cls._rejection(
                        input_data, date, brand_id, process_id, employee_id,
                        simulation_eligibility,
                        reasons=messages,
                    )
                )
                continue
            simulated = simulation["entries"]  # type: ignore[assignment]
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
                            effect=_impact_effect(prior, slot),
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

            added_entries = simulation["added"]  # type: ignore[assignment]
            destination_entry = added_entries[0] if added_entries else None
            incompatible_duty = (
                _find_incompatible_duty(
                    input_data, destination_entry.brand_id, destination_entry.processes
                )
                if destination_entry is not None
                else None
            )
            if incompatible_duty is not None and destination_entry is not None:
                incompatible_eligibility = RecoveryEligibility(
                    employee_id=employee_id,
                    employee_name=emp.name,
                    eligible=False,
                    current_assignment=eligibility.current_assignment,
                    recovery_type=eligibility.recovery_type,
                    allocation_type=eligibility.allocation_type,
                    rejection_code="INCOMPATIBLE_DUTY",
                    rejection_reason=RECOVERY_REJECTION_TEXT["INCOMPATIBLE_DUTY"],
                )
                rejected.append(
                    cls._rejection(
                        input_data, date, brand_id, process_id, employee_id,
                        incompatible_eligibility,
                        coverage_impact=impact,
                        reasons=[
                            f"Cannot cover both {destination_entry.brand_id}-{incompatible_duty[0]} "
                            f"and {destination_entry.brand_id}-{incompatible_duty[1]} on the same day."
                        ],
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
            source_coverage_loss = sum(
                max(0, s.before_scheduled - s.after_scheduled)
                for s in lost_source_processes
            )
            removed_changes = [
                {
                    "brand_id": e.brand_id,
                    "brand_name": next(
                        (b.name for b in input_data.brands if b.id == e.brand_id), e.brand_id
                    ),
                    "processes": list(e.processes),
                }
                for e in simulation["removed"]  # type: ignore[union-attr]
            ]
            added_changes = [
                {
                    "brand_id": e.brand_id,
                    "brand_name": next(
                        (b.name for b in input_data.brands if b.id == e.brand_id), e.brand_id
                    ),
                    "processes": list(e.processes),
                }
                for e in simulation["added"]  # type: ignore[union-attr]
            ]
            changed = len(removed_changes) + len(added_changes)
            weekly_off = 1 if get_weekday(date) in emp.weekly_off else 0
            additional = (
                1
                if eligibility.recovery_type == "same-pod-backup"
                or (
                    eligibility.allocation_type == "temporary-reassignment"
                    and not eligibility.destination_authorized
                )
                else 0
            )
            current_workload = sum(1 for entry in entries if entry.employee_id == employee_id)
            ranking_key = [
                changed,
                source_coverage_loss,
                source_processes_at_minimum,
                primary_disruption,
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
                    removed_assignments=removed_changes,
                    added_assignments=added_changes,
                    source_coverage_loss=source_coverage_loss,
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

        proposals.sort(key=lambda p: (tuple(p.ranking_key), p.employee_id))
        for index, proposal in enumerate(proposals):
            # Legacy field retained for API compatibility. Ordering is ranking_key.
            proposal.score = index
            proposal.ranking_explanation = (
                f"Rank {index + 1} (key {'/'.join(map(str, proposal.ranking_key))}): "
                f"{proposal.changed_assignments} assignment change(s), "
                f"{proposal.source_coverage_loss} source seat(s) lost, "
                f"{proposal.source_processes_at_minimum} source process(es) at minimum, "
                f"{proposal.primary_disruption} primary disruption(s), "
                f"{proposal.weekly_off_overrides} weekly-off override(s), "
                f"{proposal.additional_staffing} extra staffing, "
                f"workload {proposal.current_workload}."
            )
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
        if not isinstance(directive, dict):
            return failure("MALFORMED_DIRECTIVE", "Recovery directive is malformed or incomplete.")
        required_keys = ("date", "employee_id", "brand_id", "process_id", "type")
        if any(not isinstance(directive.get(key), str) or not directive.get(key) for key in required_keys):
            return failure("MALFORMED_DIRECTIVE", "Recovery directive is malformed or incomplete.")
        if str(directive["type"]) not in ("temporary-backup", "temporary-reassignment"):
            return failure("MALFORMED_DIRECTIVE", "Recovery directive has an unknown assignment type.")
        try:
            datetime.date.fromisoformat(str(directive["date"]))
        except ValueError:
            return failure("MALFORMED_DIRECTIVE", "Recovery directive has an invalid date.")
        source_brand, source_processes = _directive_source(directive)
        if source_brand is not None and not isinstance(source_brand, str):
            return failure("MALFORMED_DIRECTIVE", "Recovery directive has malformed source metadata.")
        if source_processes is not None and (
            not isinstance(source_processes, list)
            or not all(isinstance(process, str) for process in source_processes)
        ):
            return failure("MALFORMED_DIRECTIVE", "Recovery directive has malformed source metadata.")

        emp_id = str(directive["employee_id"])
        date = str(directive["date"])
        brand_id = str(directive["brand_id"])
        process_id = str(directive["process_id"])
        allocation_type = str(directive["type"])
        target_assignment = (
            candidate.target_assignment
            if isinstance(candidate.target_assignment, dict)
            else {}
        )
        if (
            candidate.employee_id != emp_id
            or candidate.allocation_type != allocation_type
            or target_assignment.get("brand_id") != brand_id
            or target_assignment.get("process_id") != process_id
        ):
            return failure(
                "MALFORMED_DIRECTIVE",
                "Candidate metadata does not match the recovery directive.",
                employee_id=emp_id,
            )
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

        baseline_current = [
            e for e in entries if e.date == date and e.employee_id == emp_id
        ]
        if len(baseline_current) > 1:
            return failure(
                "DOUBLE_BOOKED",
                f"{emp.name} already has {len(baseline_current)} assignments on {date}.",
                employee_id=emp_id,
            )
        from_brand, from_processes = _directive_source(directive)
        if allocation_type == "temporary-reassignment":
            current = baseline_current[0] if baseline_current else None
            if (
                len(baseline_current) != 1
                or current is None
                or from_brand != current.brand_id
                or not isinstance(from_processes, list)
                or not all(isinstance(p, str) for p in from_processes)
                or not _same_process_set(list(from_processes), current.processes)
            ):
                return failure(
                    "SOURCE_METADATA_MISMATCH",
                    "Directive source metadata does not match the baseline assignment.",
                    employee_id=emp_id,
                )
        elif from_brand is not None or (
            isinstance(from_processes, list) and len(from_processes) > 0
        ):
            return failure(
                "SOURCE_METADATA_MISMATCH",
                "A temporary backup must not claim a source assignment.",
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
        simulation = cls._simulate_detailed(input_data, entries, directive)
        simulated = simulation["entries"]  # type: ignore[assignment]
        removed = simulation["removed"]  # type: ignore[assignment]
        added = simulation["added"]  # type: ignore[assignment]
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
        simulation_failure_codes = {
            "INVALID_DIRECTIVE": "MALFORMED_DIRECTIVE",
            "UNKNOWN_EMPLOYEE": "UNKNOWN_EMPLOYEE",
            "UNKNOWN_TARGET": "UNKNOWN_TARGET",
            "TARGET_NOT_OPERATING": "TARGET_NOT_OPERATING",
            "EMPLOYEE_UNAVAILABLE": "ON_LEAVE_OR_COMP_OFF",
            "DUPLICATE_ASSIGNMENT": "DOUBLE_BOOKED",
            "ALREADY_ASSIGNED": "DOUBLE_BOOKED",
            "SOURCE_METADATA_MISMATCH": "SOURCE_METADATA_MISMATCH",
        }
        for issue in simulation["issues"]:  # type: ignore[union-attr]
            failures.append({
                "code": simulation_failure_codes.get(
                    str(issue.get("code")), "NEW_HARD_CONSTRAINT"
                ),
                "message": issue.get("message"),
                "employee_id": emp_id,
                "brand_id": brand_id,
                "process_id": process_id,
            })
        if allocations_before != allocations_after:
            failures.append({
                "code": "PERMANENT_ALLOCATION_MUTATED",
                "message": "Recovery simulation changed a permanent allocation.",
                "employee_id": emp_id,
            })

        if allocation_type == "temporary-reassignment":
            removed_matches = (
                len(removed) == len(baseline_current)
                and all(
                    any(_entry_signature(entry) == _entry_signature(base) for base in baseline_current)
                    for entry in removed
                )
            )
            if not removed_matches:
                failures.append({
                    "code": "SOURCE_METADATA_MISMATCH",
                    "message": "Simulation did not remove exactly the baseline source assignment(s).",
                    "employee_id": emp_id,
                })
        elif removed:
            failures.append({
                "code": "SOURCE_METADATA_MISMATCH",
                "message": "A temporary backup must not remove an existing assignment.",
                "employee_id": emp_id,
            })

        if (
            len(added) != 1
            or added[0].brand_id != brand_id
            or process_id not in added[0].processes
        ):
            failures.append({
                "code": "DESTINATION_ASSIGNMENT_MISSING",
                "message": "Simulation did not create the requested destination assignment.",
                "employee_id": emp_id,
                "brand_id": brand_id,
                "process_id": process_id,
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
        destination_entry = candidate_entries[0] if candidate_entries else None
        if (
            destination_entry is None
            or destination_entry.brand_id != brand_id
            or process_id not in destination_entry.processes
        ):
            failures.append({
                "code": "DESTINATION_ASSIGNMENT_MISSING",
                "message": f"{emp.name} is not assigned to {brand.name} {process_id} after the repair.",
                "employee_id": emp_id,
                "brand_id": brand_id,
                "process_id": process_id,
            })

        untouched_baseline = sorted(
            _entry_signature(e)
            for e in entries
            if not (e.date == date and e.employee_id == emp_id)
        )
        untouched_after = sorted(
            _entry_signature(e)
            for e in simulated
            if not (e.date == date and e.employee_id == emp_id)
        )
        if untouched_baseline != untouched_after:
            failures.append({
                "code": "UNRELATED_ENTRY_CHANGED",
                "message": "Recovery simulation changed an unrelated roster entry.",
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
        before_hard = {
            failure.identity(): failure
            for failure in before_report.hard_failure_records
        }
        new_hard_records = [
            failure
            for failure in after_report.hard_failure_records
            if failure.identity() not in before_hard
        ]
        # A temporary same-pod or explicitly authorized recovery assignment is
        # itself the date-specific authorization. The roster validator only
        # knows permanent allocations, so ignore its authorization record for
        # this candidate's destination slot. This is a structured comparison;
        # no human-readable message is parsed.
        new_hard_records = [
            failure
            for failure in new_hard_records
            if not (
                failure.code == "UNAUTHORIZED_ASSIGNMENT"
                and failure.date == date
                and failure.brand_id == brand_id
                and failure.process_id == process_id
                and failure.employee_id == emp.id
            )
        ]
        # A successfully repaired target gap disappears from the new-hard list,
        # so any genuinely new hard failure is an independent rejection reason.
        new_hard = [failure.message for failure in new_hard_records]
        for failure in new_hard_records:
            code = (
                "INCOMPATIBLE_DUTY"
                if failure.code == "INCOMPATIBLE_DUTY"
                else "NEW_HARD_CONSTRAINT"
            )
            failures.append({"code": code, "message": failure.message})

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
                        effect=_impact_effect(prior, slot),
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
            "new_conflict_records": [failure.to_dict() for failure in new_hard_records],
        }
