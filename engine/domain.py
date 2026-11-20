"""Domain models and data schemas for the workforce scheduling engine.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple


class SolverStatus(str, Enum):
    OPTIMAL = "OPTIMAL"
    FEASIBLE = "FEASIBLE"
    INFEASIBLE = "INFEASIBLE"
    UNKNOWN = "UNKNOWN"
    MODEL_INVALID = "MODEL_INVALID"


class OperatingRule(str, Enum):
    ALL_YEAR = "ALL_YEAR"
    EXCEPT_HOLIDAYS = "EXCEPT_HOLIDAYS"
    NO_SUN_HOLIDAYS = "NO_SUN_HOLIDAYS"
    CUSTOM = "CUSTOM"


ProcessId = str


@dataclass
class BrandProcess:
    process_id: ProcessId
    rule: OperatingRule
    min_staff: int = 1
    custom_operating_dates: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> BrandProcess:
        rule_str = data.get("rule", "ALL_YEAR")
        try:
            rule = OperatingRule(rule_str)
        except ValueError:
            rule = OperatingRule.CUSTOM
        return cls(
            process_id=data.get("process_id") or data.get("processId", ""),
            rule=rule,
            min_staff=int(data.get("min_staff", data.get("minStaff", 1))),
            custom_operating_dates=data.get("custom_operating_dates", data.get("customOperatingDates", [])),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "process_id": self.process_id,
            "rule": self.rule.value,
            "min_staff": self.min_staff,
            "custom_operating_dates": self.custom_operating_dates,
        }


@dataclass
class Brand:
    id: str
    name: str
    category: str
    pod_id: str
    processes: List[BrandProcess] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Brand:
        procs = [
            BrandProcess.from_dict(p)
            for p in data.get("processes", [])
        ]
        return cls(
            id=data.get("id", ""),
            name=data.get("name", ""),
            category=data.get("category", ""),
            pod_id=data.get("pod_id") or data.get("podId", ""),
            processes=procs,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "pod_id": self.pod_id,
            "processes": [p.to_dict() for p in self.processes],
        }


@dataclass
class Pod:
    id: str
    name: str
    lead_id: str

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Pod:
        return cls(
            id=data.get("id", ""),
            name=data.get("name", ""),
            lead_id=data.get("lead_id") or data.get("leadId", ""),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {"id": self.id, "name": self.name, "lead_id": self.lead_id}


@dataclass
class Employee:
    id: str
    name: str
    pod_id: str
    weekly_off: List[int] = field(default_factory=list)  # Preferred weekly off days (0=Sun, 1=Mon, ..., 6=Sat)
    leaves: List[str] = field(default_factory=list)        # ISO dates YYYY-MM-DD (approved leave)
    comp_offs: List[str] = field(default_factory=list)     # ISO dates YYYY-MM-DD
    min_weekly_off: int = 1                               # L_min weekly-off entitlement per 7 days
    max_weekly_off: int = 2                               # L_max weekly-off entitlement per 7 days
    preferences: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Employee:
        return cls(
            id=data.get("id", ""),
            name=data.get("name", ""),
            pod_id=data.get("pod_id") or data.get("podId", ""),
            weekly_off=list(data.get("weekly_off") or data.get("weeklyOff", [])),
            leaves=list(data.get("leaves", [])),
            comp_offs=list(data.get("comp_offs") or data.get("compOffs", [])),
            min_weekly_off=int(data.get("min_weekly_off", data.get("minWeeklyOff", 1))),
            max_weekly_off=int(data.get("max_weekly_off", data.get("maxWeeklyOff", 2))),
            preferences=dict(data.get("preferences", {})),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "pod_id": self.pod_id,
            "weekly_off": self.weekly_off,
            "leaves": self.leaves,
            "comp_offs": self.comp_offs,
            "min_weekly_off": self.min_weekly_off,
            "max_weekly_off": self.max_weekly_off,
            "preferences": self.preferences,
        }


@dataclass
class Allocation:
    employee_id: str
    brand_id: str
    process_id: ProcessId
    role: str  # 'primary' | 'backup' / 'secondary'

    @property
    def is_primary(self) -> bool:
        return self.role.lower() == "primary"

    @property
    def is_backup(self) -> bool:
        return self.role.lower() in ("backup", "secondary")

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Allocation:
        return cls(
            employee_id=data.get("employee_id") or data.get("employeeId", ""),
            brand_id=data.get("brand_id") or data.get("brandId", ""),
            process_id=data.get("process_id") or data.get("processId", ""),
            role=data.get("role", "primary"),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "employee_id": self.employee_id,
            "brand_id": self.brand_id,
            "process_id": self.process_id,
            "role": self.role,
        }


@dataclass
class CrossPodAuthorization:
    """Explicit permission for an employee to cover a brand/process outside
    their own pod. Process experience alone is not an authorization."""
    employee_id: str
    brand_id: str
    process_id: ProcessId

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> CrossPodAuthorization:
        return cls(
            employee_id=data.get("employee_id") or data.get("employeeId", ""),
            brand_id=data.get("brand_id") or data.get("brandId", ""),
            process_id=data.get("process_id") or data.get("processId", ""),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "employee_id": self.employee_id,
            "brand_id": self.brand_id,
            "process_id": self.process_id,
        }


@dataclass
class Holiday:
    date: str
    name: str

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> Holiday:
        return cls(date=data.get("date", ""), name=data.get("name", ""))

    def to_dict(self) -> Dict[str, Any]:
        return {"date": self.date, "name": self.name}


@dataclass
class IncompatiblePair:
    """Pair of process keys (brand_id, process_id) that cannot be simultaneously
    assigned to the same employee on the same date."""
    brand_id_1: str
    process_id_1: ProcessId
    brand_id_2: str
    process_id_2: ProcessId

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> IncompatiblePair:
        return cls(
            brand_id_1=data.get("brand_id_1") or data.get("brandId1", ""),
            process_id_1=data.get("process_id_1") or data.get("processId1", ""),
            brand_id_2=data.get("brand_id_2") or data.get("brandId2", ""),
            process_id_2=data.get("process_id_2") or data.get("processId2", ""),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "brand_id_1": self.brand_id_1,
            "process_id_1": self.process_id_1,
            "brand_id_2": self.brand_id_2,
            "process_id_2": self.process_id_2,
        }


@dataclass
class WorkloadRequirement:
    brand_id: str
    process_id: ProcessId
    date: str
    demand_hours: float

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> WorkloadRequirement:
        return cls(
            brand_id=data.get("brand_id", ""),
            process_id=data.get("process_id", ""),
            date=data.get("date", ""),
            demand_hours=float(data.get("demand_hours", 0.0)),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "brand_id": self.brand_id,
            "process_id": self.process_id,
            "date": self.date,
            "demand_hours": self.demand_hours,
        }


@dataclass
class EmployeeCapacity:
    employee_id: str
    date: str
    max_daily_hours: float
    process_capacity_hours: Dict[str, float] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> EmployeeCapacity:
        return cls(
            employee_id=data.get("employee_id", ""),
            date=data.get("date", ""),
            max_daily_hours=float(data.get("max_daily_hours", 8.0)),
            process_capacity_hours=dict(data.get("process_capacity_hours", {})),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "employee_id": self.employee_id,
            "date": self.date,
            "max_daily_hours": self.max_daily_hours,
            "process_capacity_hours": self.process_capacity_hours,
        }


@dataclass
class WorkloadPolicy:
    enabled: bool = False
    demands: List[WorkloadRequirement] = field(default_factory=list)
    capacities: List[EmployeeCapacity] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> WorkloadPolicy:
        if not data:
            return cls(enabled=False)
        return cls(
            enabled=bool(data.get("enabled", False)),
            demands=[WorkloadRequirement.from_dict(d) for d in data.get("demands", [])],
            capacities=[EmployeeCapacity.from_dict(c) for c in data.get("capacities", [])],
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "demands": [d.to_dict() for d in self.demands],
            "capacities": [c.to_dict() for c in self.capacities],
        }


@dataclass
class ReferenceAssignment:
    employee_id: str
    brand_id: str
    process_id: ProcessId
    date: str

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> ReferenceAssignment:
        return cls(
            employee_id=data.get("employee_id") or data.get("employeeId", ""),
            brand_id=data.get("brand_id") or data.get("brandId", ""),
            process_id=data.get("process_id") or data.get("processId", ""),
            date=data.get("date", ""),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "employee_id": self.employee_id,
            "brand_id": self.brand_id,
            "process_id": self.process_id,
            "date": self.date,
        }


@dataclass
class RosterEntry:
    date: str
    employee_id: str
    brand_id: str
    processes: List[ProcessId]
    is_weekly_off: bool = False
    is_backup: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "date": self.date,
            "employee_id": self.employee_id,
            "brand_id": self.brand_id,
            "processes": self.processes,
            "is_weekly_off": self.is_weekly_off,
            "is_backup": self.is_backup,
        }


@dataclass
class DayCoverage:
    date: str
    brand_id: str
    process_id: ProcessId
    operating: bool
    required: int
    scheduled: List[str]
    shortage: int = 0
    status: str = "covered"  # 'covered' | 'understaffed' | 'gap' | 'not-operating'

    def to_dict(self) -> Dict[str, Any]:
        return {
            "date": self.date,
            "brand_id": self.brand_id,
            "process_id": self.process_id,
            "operating": self.operating,
            "required": self.required,
            "scheduled": self.scheduled,
            "shortage": self.shortage,
            "status": self.status,
        }


@dataclass
class Conflict:
    id: str
    type: str  # 'COVERAGE_GAP' | 'UNDERSTAFFED' | 'OFF_OVERRIDDEN' | 'INCOMPATIBLE_DUTY' | 'LEAVE_CLASH' | 'UNAUTHORIZED_ASSIGNMENT'
    severity: str  # 'error' | 'warning'
    date: str
    message: str
    brand_id: Optional[str] = None
    process_id: Optional[ProcessId] = None
    employee_id: Optional[str] = None
    suggestion: Optional[str] = None
    diagnostic_shortage: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "severity": self.severity,
            "date": self.date,
            "brand_id": self.brand_id,
            "process_id": self.process_id,
            "employee_id": self.employee_id,
            "message": self.message,
            "suggestion": self.suggestion,
            "diagnostic_shortage": self.diagnostic_shortage,
        }


@dataclass
class RosterStats:
    operating_slots: int = 0
    covered_slots: int = 0
    gap_slots: int = 0
    understaffed_slots: int = 0
    warnings: int = 0
    errors: int = 0
    coverage_pct: float = 0.0
    employees_working: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "operating_slots": self.operating_slots,
            "covered_slots": self.covered_slots,
            "gap_slots": self.gap_slots,
            "understaffed_slots": self.understaffed_slots,
            "warnings": self.warnings,
            "errors": self.errors,
            "coverage_pct": self.coverage_pct,
            "employees_working": self.employees_working,
        }


@dataclass
class SchedulingInput:
    employees: List[Employee]
    brands: List[Brand]
    allocations: List[Allocation]
    holidays: List[Holiday] = field(default_factory=list)
    dates: List[str] = field(default_factory=list)
    incompatible_pairs: List[IncompatiblePair] = field(default_factory=list)
    workload_policy: WorkloadPolicy = field(default_factory=WorkloadPolicy)
    reference_roster: List[ReferenceAssignment] = field(default_factory=list)
    cross_pod_authorizations: List[CrossPodAuthorization] = field(default_factory=list)
    # Reconciliation note: the TypeScript browser engine and the original Python
    # CP-SAT model use different assignment granularity. "process" keeps the
    # legacy exact model (one brand/process per employee per day); "brand" uses
    # the application's business rule (one brand per employee per day, covering
    # every allocated process at that brand).
    assignment_semantics: str = "process"
    min_weekly_off_default: int = 1
    max_weekly_off_default: int = 2
    timeout_seconds: float = 10.0
    enable_reoptimization: bool = False

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> SchedulingInput:
        return cls(
            employees=[Employee.from_dict(e) for e in data.get("employees", [])],
            brands=[Brand.from_dict(b) for b in data.get("brands", [])],
            allocations=[Allocation.from_dict(a) for a in data.get("allocations", [])],
            holidays=[Holiday.from_dict(h) for h in data.get("holidays", [])],
            dates=list(data.get("dates", [])),
            incompatible_pairs=[
                IncompatiblePair.from_dict(ip)
                for ip in data.get("incompatible_pairs", data.get("incompatiblePairs", []))
            ],
            workload_policy=WorkloadPolicy.from_dict(data.get("workload_policy", data.get("workloadPolicy", {}))),
            reference_roster=[
                ReferenceAssignment.from_dict(ra)
                for ra in data.get("reference_roster", data.get("referenceRoster", []))
            ],
            cross_pod_authorizations=[
                CrossPodAuthorization.from_dict(cpa)
                for cpa in data.get("cross_pod_authorizations", data.get("crossPodAuthorizations", []))
            ],
            assignment_semantics=str(data.get("assignment_semantics", data.get("assignmentSemantics", "process"))).lower(),
            min_weekly_off_default=int(data.get("min_weekly_off_default", 1)),
            max_weekly_off_default=int(data.get("max_weekly_off_default", 2)),
            timeout_seconds=float(data.get("timeout_seconds", 10.0)),
            enable_reoptimization=bool(data.get("enable_reoptimization", False)),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "employees": [e.to_dict() for e in self.employees],
            "brands": [b.to_dict() for b in self.brands],
            "allocations": [a.to_dict() for a in self.allocations],
            "holidays": [h.to_dict() for h in self.holidays],
            "dates": self.dates,
            "incompatible_pairs": [ip.to_dict() for ip in self.incompatible_pairs],
            "workload_policy": self.workload_policy.to_dict(),
            "reference_roster": [ra.to_dict() for ra in self.reference_roster],
            "cross_pod_authorizations": [cpa.to_dict() for cpa in self.cross_pod_authorizations],
            "assignment_semantics": self.assignment_semantics,
            "min_weekly_off_default": self.min_weekly_off_default,
            "max_weekly_off_default": self.max_weekly_off_default,
            "timeout_seconds": self.timeout_seconds,
            "enable_reoptimization": self.enable_reoptimization,
        }


@dataclass(frozen=True)
class ValidationFailure:
    """Structured hard-constraint failure.

    ``identity`` is the stable business-rule key used to compare two validation
    reports. Human-readable messages remain available for diagnostics, but
    conflict comparison never depends on them.
    """

    code: str
    message: str
    date: Optional[str] = None
    brand_id: Optional[str] = None
    process_id: Optional[str] = None
    employee_id: Optional[str] = None
    related_brand_id: Optional[str] = None
    related_process_id: Optional[str] = None

    def identity(self) -> tuple:
        return (
            self.code,
            self.date or "",
            self.brand_id or "",
            self.process_id or "",
            self.employee_id or "",
            self.related_brand_id or "",
            self.related_process_id or "",
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "date": self.date,
            "brand_id": self.brand_id,
            "process_id": self.process_id,
            "employee_id": self.employee_id,
            "related_brand_id": self.related_brand_id,
            "related_process_id": self.related_process_id,
        }


@dataclass
class ValidationReport:
    is_valid: bool
    hard_failures: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    informational: List[str] = field(default_factory=list)
    hard_failure_records: List[ValidationFailure] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "is_valid": self.is_valid,
            "hard_failures": self.hard_failures,
            "hard_failure_records": [f.to_dict() for f in self.hard_failure_records],
            "warnings": self.warnings,
            "informational": self.informational,
        }


@dataclass
class SchedulingResult:
    status: SolverStatus
    solve_time_seconds: float
    entries: List[RosterEntry] = field(default_factory=list)
    coverage: List[DayCoverage] = field(default_factory=list)
    conflicts: List[Conflict] = field(default_factory=list)
    stats: RosterStats = field(default_factory=RosterStats)
    diagnostic_explanations: List[str] = field(default_factory=list)
    employee_days: Dict[str, Dict[str, str]] = field(default_factory=dict)  # emp_id -> date -> status
    validation_report: Optional[ValidationReport] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status.value,
            "solve_time_seconds": self.solve_time_seconds,
            "entries": [e.to_dict() for e in self.entries],
            "coverage": [c.to_dict() for c in self.coverage],
            "conflicts": [cf.to_dict() for cf in self.conflicts],
            "stats": self.stats.to_dict(),
            "diagnostic_explanations": self.diagnostic_explanations,
            "employee_days": self.employee_days,
            "validation_report": self.validation_report.to_dict() if self.validation_report else None,
        }
