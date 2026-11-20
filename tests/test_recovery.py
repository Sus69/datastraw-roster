"""Tests for the constraint-aware Roster Recovery Engine.

The recovery engine is deliberately stricter than the old Find Backup helper:
a candidate must be free *or* safely reassignable, and the move must not create
a coverage gap at the candidate's old brand/process.
"""

from __future__ import annotations

import copy
import json
import os
import sys

import pytest

current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from engine.domain import RosterEntry, SchedulingInput, SolverStatus
from engine.model import SchedulingEngine
from engine.recovery import RecoveryCandidate, RosterRecoveryEngine
from engine.validator import RosterValidator


@pytest.fixture
def seed_data():
    with open(os.path.join(parent_dir, "src", "data", "seed_data.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def _brand_day_input(seed_data, date: str, clear_leave: bool = True) -> SchedulingInput:
    data = copy.deepcopy(seed_data)
    data["assignment_semantics"] = "brand"
    data["dates"] = [date]
    if clear_leave:
        for emp in data["employees"]:
            emp["leaves"] = []
            emp["comp_offs"] = []
    return SchedulingInput.from_dict(data)


def _day_entries(input_data: SchedulingInput) -> list[RosterEntry]:
    result = SchedulingEngine(input_data).solve()
    assert result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE)
    return result.entries


def test_brand_semantics_matches_typescript_business_rule(seed_data):
    """One brand per day, but all allocated processes at that brand are one shift."""
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = _day_entries(input_data)
    multi = next(e for e in entries if len(e.processes) > 1)
    assert len(multi.processes) > 1
    assert all(p in {"CS", "ACC", "RET", "NDR"} for p in multi.processes)
    report = RosterValidator.validate(input_data, entries)
    assert report.is_valid, report.hard_failures


def test_seed_dataset_has_36_employees(seed_data):
    assert len(seed_data["employees"]) == 36
    assert {"e35", "e36"}.issubset({e["id"] for e in seed_data["employees"]})
    # e36's permanent TechTrove allocation is also an explicit pod-boundary grant.
    assert {
        (a["employeeId"], a["brandId"], a["processId"])
        for a in seed_data.get("crossPodAuthorizations", [])
    } >= {("e36", "b04", "CS")}


def test_direct_backup(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    assert analysis.proposals
    direct = next(p for p in analysis.proposals if p.employee_id == "e15")
    assert direct.recovery_type == "direct-backup"
    assert direct.allocation_type == "temporary-backup"
    assert direct.current_assignment is None
    assert direct.removed_assignments == []
    assert direct.added_assignments[0]["brand_id"] == "b04"
    assert direct.hard_constraints_satisfied
    assert direct.directive is not None
    assert RosterRecoveryEngine.validate(input_data, entries, direct)["valid"]


def test_cross_brand_reassignment(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    # Put the only eligible backup on another brand; moving them is safe because
    # PetPals CS is also covered by its primary.
    entries.append(RosterEntry(date="2026-12-01", employee_id="e15", brand_id="b05", processes=["CS"]))
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    proposal = next(p for p in analysis.proposals if p.employee_id == "e15")
    assert proposal.recovery_type == "cross-brand-reassignment"
    assert proposal.allocation_type == "temporary-reassignment"
    assert proposal.current_assignment is not None
    assert proposal.current_assignment["brand_id"] == "b05"
    assert proposal.removed_assignments[0]["brand_id"] == "b05"
    assert proposal.added_assignments[0]["brand_id"] == "b04"
    assert proposal.changed_assignments == 2
    assert all(i.after_scheduled >= i.required for i in proposal.coverage_impact if i.brand_id == "b05")


def test_unavailable_employee_is_rejected(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    for emp in input_data.employees:
        if emp.id == "e15":
            emp.leaves.append("2026-12-01")
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    rejected = next(p for p in analysis.rejected if p.employee_id == "e15")
    assert rejected.rejection_code == "ON_LEAVE_OR_COMP_OFF"
    assert all(p.employee_id != "e15" for p in analysis.proposals)


def test_weekly_off_override_is_ranked_and_explained(seed_data):
    # 2026-12-06 is a Sunday; e15 prefers Sunday off but can provide cover.
    input_data = _brand_day_input(seed_data, "2026-12-06")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-06", "b04", "CS")
    proposal = next(p for p in analysis.proposals if p.employee_id == "e15")
    assert proposal.weekly_off_overrides == 1
    assert any("weekly off" in reason.lower() for reason in proposal.reasons)
    # A non-override candidate must rank ahead of the override when all else is equal.
    assert analysis.proposals[0].weekly_off_overrides <= proposal.weekly_off_overrides


def test_primary_assignment_disruption(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id not in ("e26", "e29", "e32")]
    # e32 owns AutoAce NDR but is authorized for SwiftCart CS. e26 remains on
    # AutoAce NDR, so the move is safe while still disrupting primary ownership.
    entries.extend([
        RosterEntry(date="2026-12-01", employee_id="e32", brand_id="b10", processes=["NDR"]),
        RosterEntry(date="2026-12-01", employee_id="e26", brand_id="b10", processes=["NDR"]),
    ])
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b12", "CS")
    primary = next(p for p in analysis.proposals if p.employee_id == "e32")
    assert primary.primary_disruption == 1
    assert primary.source_coverage_loss >= 1
    assert primary.source_impact[0].primary_owned_by_candidate is True
    assert primary.source_impact[0].covered_by_other_employees is True
    assert primary.recovery_type == "cross-brand-reassignment"


def test_cascading_coverage_failure_is_rejected(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    # e35 is authorized for GlowKart RET but currently the only cover on FitFuel
    # RET. Moving them is a valid authorization, but creates a source gap.
    entries = [RosterEntry(date="2026-12-01", employee_id="e35", brand_id="b02", processes=["RET"])]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b01", "RET")
    e35 = next(p for p in analysis.rejected if p.employee_id == "e35")
    assert e35.rejection_code == "REASSIGNMENT_CAUSES_UNDERSTAFFING"
    assert "FitFuel" in e35.reasons[0]
    assert e35.hard_constraints_satisfied is False


def test_same_pod_backup(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [
        e for e in _day_entries(input_data)
        if e.employee_id not in ("e12", "e15")
    ]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    proposal = next(p for p in analysis.proposals if p.employee_id == "e12")
    assert proposal.recovery_type == "same-pod-backup"
    assert proposal.allocation_type == "temporary-backup"
    assert proposal.current_assignment is None
    assert RosterRecoveryEngine.validate(input_data, entries, proposal)["valid"]


def test_unauthorized_cross_pod_candidate_is_rejected(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [RosterEntry(date="2026-12-01", employee_id="e24", brand_id="b09", processes=["RET"])]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b01", "RET")
    e24 = next(p for p in analysis.rejected if p.employee_id == "e24")
    assert e24.rejection_code == "NO_DESTINATION_AUTHORIZATION"
    assert all(p.employee_id != "e24" for p in analysis.proposals)


def test_explicit_cross_pod_authorization_allows_reassignment(seed_data):
    data = copy.deepcopy(seed_data)
    data["assignment_semantics"] = "brand"
    data["dates"] = ["2026-12-01"]
    for emp in data["employees"]:
        emp["leaves"] = []
        emp["comp_offs"] = []
    data["cross_pod_authorizations"] = [
        {"employee_id": "e24", "brand_id": "b01", "process_id": "RET"}
    ]
    input_data = SchedulingInput.from_dict(data)
    entries = [
        RosterEntry(date="2026-12-01", employee_id="e24", brand_id="b09", processes=["RET"]),
        RosterEntry(date="2026-12-01", employee_id="e20", brand_id="b09", processes=["RET"]),
    ]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b01", "RET")
    e24 = next(p for p in analysis.proposals if p.employee_id == "e24")
    assert e24.recovery_type == "cross-brand-reassignment"
    assert RosterRecoveryEngine.validate(input_data, entries, e24)["valid"]


def test_double_booking_is_prevented(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [
        RosterEntry(date="2026-12-01", employee_id="e15", brand_id="b05", processes=["CS"]),
        RosterEntry(date="2026-12-01", employee_id="e15", brand_id="b06", processes=["CS"]),
    ]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    e15 = next(p for p in analysis.rejected if p.employee_id == "e15")
    assert e15.rejection_code == "CANDIDATE_DOUBLE_BOOKED"


def test_validator_detects_duplicate_baseline_assignments(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    clean_entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    analysis = RosterRecoveryEngine.analyze(input_data, clean_entries, "2026-12-01", "b04", "CS")
    proposal = next(p for p in analysis.proposals if p.employee_id == "e15")
    duplicated = clean_entries + [
        RosterEntry(date="2026-12-01", employee_id="e15", brand_id="b05", processes=["CS"]),
        RosterEntry(date="2026-12-01", employee_id="e15", brand_id="b06", processes=["CS"]),
    ]
    result = RosterRecoveryEngine.validate(input_data, duplicated, proposal)
    assert result["valid"] is False
    assert any(f["code"] == "DOUBLE_BOOKED" for f in result["failures"])


def test_comp_off_is_rejected(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    for emp in input_data.employees:
        if emp.id == "e15":
            emp.comp_offs.append("2026-12-01")
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    e15 = next(p for p in analysis.rejected if p.employee_id == "e15")
    assert e15.rejection_code == "ON_LEAVE_OR_COMP_OFF"


def test_permanent_allocations_are_not_mutated(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    before = [a.to_dict() for a in input_data.allocations]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    proposal = next(p for p in analysis.proposals if p.employee_id == "e15")
    assert RosterRecoveryEngine.validate(input_data, entries, proposal)["valid"]
    assert [a.to_dict() for a in input_data.allocations] == before


def test_validator_rejects_invalid_proposal_without_trusting_flags(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [RosterEntry(date="2026-12-01", employee_id="e24", brand_id="b09", processes=["RET"])]
    directive = {
        "date": "2026-12-01",
        "employee_id": "e24",
        "brand_id": "b01",
        "process_id": "RET",
        "type": "temporary-reassignment",
        "from_brand_id": "b09",
        "from_processes": ["RET"],
    }
    candidate = RecoveryCandidate(
        employee_id="e24",
        name="Nisha Agarwal",
        current_assignment={"brand_id": "b09", "brand_name": "GreenLeaf", "processes": ["RET"]},
        target_assignment={"brand_id": "b01", "brand_name": "GlowKart", "process_id": "RET"},
        recovery_type="cross-brand-reassignment",
        allocation_type="temporary-reassignment",
        changed_assignments=2,
        primary_disruption=0,
        weekly_off_overrides=0,
        additional_staffing=0,
        hard_constraints_satisfied=True,
        valid=True,
        score=-999,
        directive=directive,
    )
    result = RosterRecoveryEngine.validate(input_data, entries, candidate)
    assert result["valid"] is False
    assert any(f["code"] == "NOT_ELIGIBLE" for f in result["failures"])


def test_cross_pod_backup_requires_explicit_cross_pod_authorization(seed_data):
    data = copy.deepcopy(seed_data)
    data["assignment_semantics"] = "brand"
    data["dates"] = ["2026-12-01"]
    data["cross_pod_authorizations"] = []
    for emp in data["employees"]:
        emp["leaves"] = []
        emp["comp_offs"] = []
    input_data = SchedulingInput.from_dict(data)
    # e36 has a permanent b04-CS allocation but belongs to Pod Delta; the
    # allocation alone must not be treated as pod-boundary permission.
    entries = [RosterEntry(date="2026-12-01", employee_id="e36", brand_id="b11", processes=["CS"])]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    e36 = next(p for p in analysis.rejected if p.employee_id == "e36")
    assert e36.rejection_code == "NO_CROSS_POD_AUTHORIZATION"


def test_explicit_cross_pod_authorization_allows_direct_backup(seed_data):
    data = copy.deepcopy(seed_data)
    data["assignment_semantics"] = "brand"
    data["dates"] = ["2026-12-01"]
    for emp in data["employees"]:
        emp["leaves"] = []
        emp["comp_offs"] = []
    input_data = SchedulingInput.from_dict(data)
    entries = [RosterEntry(date="2026-12-01", employee_id="e10", brand_id="b04", processes=["CS"])]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    e36 = next(p for p in analysis.proposals if p.employee_id == "e36")
    assert e36.recovery_type == "direct-backup"
    assert RosterRecoveryEngine.validate(input_data, entries, e36)["valid"]


def test_same_pod_membership_without_process_authorization_is_insufficient(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e16"]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    e16 = next(p for p in analysis.rejected if p.employee_id == "e16")
    assert e16.rejection_code == "NO_COMPATIBLE_PROCESS_ALLOCATION"


def test_forged_source_metadata_is_rejected(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    entries.append(RosterEntry(date="2026-12-01", employee_id="e15", brand_id="b05", processes=["CS"]))
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    proposal = next(p for p in analysis.proposals if p.employee_id == "e15")
    proposal.directive = copy.deepcopy(proposal.directive)
    proposal.directive["from_brand_id"] = "b06"
    result = RosterRecoveryEngine.validate(input_data, entries, proposal)
    assert result["valid"] is False
    assert any(f["code"] == "SOURCE_METADATA_MISMATCH" for f in result["failures"])


def test_forged_employee_and_target_identifiers_are_rejected(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    proposal = next(p for p in analysis.proposals if p.employee_id == "e15")

    forged_employee = copy.deepcopy(proposal)
    forged_employee.employee_id = "e99"
    forged_employee.directive["employee_id"] = "e99"
    result = RosterRecoveryEngine.validate(input_data, entries, forged_employee)
    assert result["valid"] is False
    assert any(f["code"] == "UNKNOWN_EMPLOYEE" for f in result["failures"])

    forged_target = copy.deepcopy(proposal)
    forged_target.target_assignment["brand_id"] = "b99"
    forged_target.directive["brand_id"] = "b99"
    result = RosterRecoveryEngine.validate(input_data, entries, forged_target)
    assert result["valid"] is False
    assert any(f["code"] == "UNKNOWN_TARGET" for f in result["failures"])


def test_candidate_metadata_mismatch_is_rejected(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    proposal = next(p for p in analysis.proposals if p.employee_id == "e15")
    proposal.target_assignment = dict(proposal.target_assignment)
    proposal.target_assignment["brand_id"] = "b06"
    result = RosterRecoveryEngine.validate(input_data, entries, proposal)
    assert result["valid"] is False
    assert any(f["code"] == "MALFORMED_DIRECTIVE" for f in result["failures"])


def test_preexisting_unrelated_gap_does_not_invalidate_repair(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [
        e for e in _day_entries(input_data)
        if e.employee_id not in ("e01", "e15")
    ]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    proposal = next(p for p in analysis.proposals if p.employee_id == "e15")
    result = RosterRecoveryEngine.validate(input_data, entries, proposal)
    assert result["valid"] is True, result["failures"]


def test_ranking_is_lexicographic_and_deterministic(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    first = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    second = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    assert [p.employee_id for p in first.proposals] == [p.employee_id for p in second.proposals]
    keys = [tuple(p.ranking_key) for p in first.proposals]
    assert keys == sorted(keys)
    for left, right in zip(first.proposals, first.proposals[1:]):
        if left.ranking_key == right.ranking_key:
            assert left.employee_id < right.employee_id


def test_bookbarn_december_21_recovery(seed_data):
    data = copy.deepcopy(seed_data)
    data["assignment_semantics"] = "brand"
    data["dates"] = ["2026-12-21"]
    input_data = SchedulingInput.from_dict(data)
    # Both BookBarn employees are on approved leave on this date. Recovery may
    # still find a same-pod float, but must never schedule either BookBarn employee.
    analysis = RosterRecoveryEngine.analyze(input_data, [], "2026-12-21", "b11", "CS")
    assert all(p.employee_id not in ("e27", "e28") for p in analysis.proposals)
    rejected_ids = {p.employee_id: p.rejection_code for p in analysis.rejected}
    assert rejected_ids.get("e27") == "ON_LEAVE_OR_COMP_OFF"
    assert rejected_ids.get("e28") == "ON_LEAVE_OR_COMP_OFF"
    # A same-pod CS resource exists, so this is now recoverable instead of a dead end.
    assert any(p.recovery_type in ("same-pod-backup", "cross-brand-reassignment") for p in analysis.proposals)
    for proposal in analysis.proposals:
        assert RosterRecoveryEngine.validate(input_data, [], proposal)["valid"]


def test_techtrove_december_3_recovery(seed_data):
    data = copy.deepcopy(seed_data)
    data["assignment_semantics"] = "brand"
    data["dates"] = ["2026-12-03"]
    for emp in data["employees"]:
        if emp["id"] != "e10":
            emp["leaves"] = []
            emp["comp_offs"] = []
    input_data = SchedulingInput.from_dict(data)
    baseline_input = _brand_day_input(seed_data, "2026-12-03")
    entries = [e for e in _day_entries(baseline_input) if e.employee_id != "e10"]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-03", "b04", "CS")
    assert analysis.date == "2026-12-03"
    assert analysis.process_id == "CS"
    # Neha Joshi is on leave and must not appear as a repair candidate.
    assert all(p.employee_id != "e10" for p in analysis.proposals)
    if analysis.proposals:
        for proposal in analysis.proposals:
            assert RosterRecoveryEngine.validate(input_data, entries, proposal)["valid"]
    else:
        assert "No safe repair" in analysis.explanation
        assert any(p.rejection_code for p in analysis.rejected)
