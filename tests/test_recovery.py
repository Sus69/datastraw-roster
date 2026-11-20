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
from engine.recovery import RosterRecoveryEngine
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


def test_direct_backup(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    assert analysis.proposals
    direct = next(p for p in analysis.proposals if p.employee_id == "e15")
    assert direct.recovery_type == "direct-backup"
    assert direct.allocation_type == "temporary-backup"
    assert direct.current_assignment is None
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
    entries = [e for e in _day_entries(input_data) if e.employee_id not in ("e15", "e12", "e13", "e16", "e17")]
    # StyleSutra is fully cross-covered, so moving its primary is safe but costly.
    entries.extend([
        RosterEntry(date="2026-12-01", employee_id="e12", brand_id="b06", processes=["CS", "ACC", "RET"]),
        RosterEntry(date="2026-12-01", employee_id="e13", brand_id="b06", processes=["CS"]),
        RosterEntry(date="2026-12-01", employee_id="e16", brand_id="b06", processes=["ACC"]),
        RosterEntry(date="2026-12-01", employee_id="e17", brand_id="b06", processes=["RET"]),
    ])
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    primary = next(p for p in analysis.proposals if p.employee_id == "e12")
    assert primary.primary_disruption == 1
    assert primary.recovery_type == "cross-brand-reassignment"


def test_cascading_coverage_failure_is_rejected(seed_data):
    input_data = _brand_day_input(seed_data, "2026-12-01")
    entries = [e for e in _day_entries(input_data) if e.employee_id != "e15"]
    analysis = RosterRecoveryEngine.analyze(input_data, entries, "2026-12-01", "b04", "CS")
    e11 = next(p for p in analysis.rejected if p.employee_id == "e11")
    assert e11.rejection_code == "REASSIGNMENT_CAUSES_UNDERSTAFFING"
    assert "PetPals" in e11.reasons[0]
    assert e11.hard_constraints_satisfied is False


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
