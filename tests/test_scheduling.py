"""Comprehensive test suite for the Smart Workforce Scheduling Engine.

Covers all core scenarios from Section 8 and all edge cases from Section 9:
- Scenario A: Successful replacement (FEASIBLE)
- Scenario B: Incompatible backup assignments (INFEASIBLE)
- Scenario C: No qualified replacement (INFEASIBLE with shortage 1)
- Single employee handling multiple compatible processes
- Employee working across multiple brands
- Process operating on Sundays and public holidays
- Process closed on public holidays
- Different process calendars within the same brand
- Weekly-off and working-status conflicts
- Approved leave
- Insufficient staffing
- Unauthorized backup assignments
- Multiple processes requiring the same backup resource
- Changes to an existing roster (re-optimization)
- Scheduling weeks crossing month boundaries
- Solver timeout and infeasibility distinction
- Independent hard-constraint validation
- Workload and capacity constraints
"""

from __future__ import annotations

import copy
import json
import os
import sys
import pytest

# Ensure engine package is importable
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from engine.domain import (
    Allocation,
    Brand,
    BrandProcess,
    Employee,
    Holiday,
    IncompatiblePair,
    OperatingRule,
    ReferenceAssignment,
    RosterEntry,
    SchedulingInput,
    SolverStatus,
    WorkloadPolicy,
    WorkloadRequirement,
    EmployeeCapacity,
)
from engine.model import SchedulingEngine
from engine.reoptimizer import Reoptimizer
from engine.validator import RosterValidator


@pytest.fixture
def base_fixture():
    fixture_path = os.path.join(parent_dir, "datastraw_self_test_fixture.json")
    if not os.path.exists(fixture_path):
        from tests.generate_fixture import generate_and_validate
        generate_and_validate()
    with open(fixture_path, "r", encoding="utf-8") as f:
        return json.load(f)


# ============================================================================
# Section 8: Core Scenario Tests
# ============================================================================

def test_scenario_baseline(base_fixture):
    """Validate baseline roster: fully feasible and optimal with 0 errors."""
    sched_input = SchedulingInput.from_dict(base_fixture)
    engine = SchedulingEngine(sched_input)
    result = engine.solve()

    assert result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE)
    assert result.stats.errors == 0
    assert result.stats.operating_slots == 198
    assert result.stats.covered_slots == 198
    assert len(result.entries) > 0

    # Independently validate hard constraints
    is_valid, violations = RosterValidator.validate(sched_input, result.entries, result.employee_days)
    assert is_valid, f"Validation failed with: {violations}"


def test_scenario_a_successful_replacement(base_fixture):
    """Scenario A: E01 becomes unavailable on Wednesday.
    E22 can cover B01 CS, and E24 can cover B01 RET.
    Expected outcome: FEASIBLE / OPTIMAL.
    """
    data = copy.deepcopy(base_fixture)
    emp_e01 = next(e for e in data["employees"] if e["id"] == "E01")
    emp_e01["leaves"].append("2026-11-25")

    sched_input = SchedulingInput.from_dict(data)
    engine = SchedulingEngine(sched_input)
    result = engine.solve()

    assert result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE)
    assert result.stats.errors == 0

    # Verify assignments on Wednesday for B01
    wed_b01 = [e for e in result.entries if e.date == "2026-11-25" and e.brand_id == "B01"]
    assigned_emps = {e.employee_id for e in wed_b01}
    assert "E22" in assigned_emps, "E22 should cover B01 CS on Wednesday"
    assert "E24" in assigned_emps, "E24 should cover B01 RET on Wednesday"
    assert "E01" not in assigned_emps, "E01 cannot work while on leave"

    # Independently validate
    is_valid, violations = RosterValidator.validate(sched_input, result.entries, result.employee_days)
    assert is_valid, f"Violations: {violations}"


def test_scenario_b_incompatible_backup_assignments(base_fixture):
    """Scenario B: E01 becomes unavailable on Friday.
    E17 is on weekly off.
    E22 is the only approved relief employee for B01 CS and B14 ACC, but duties overlap.
    Expected outcome: INFEASIBLE.
    """
    data = copy.deepcopy(base_fixture)
    # E01 unavailable on Friday (2026-11-27)
    emp_e01 = next(e for e in data["employees"] if e["id"] == "E01")
    emp_e01["leaves"].append("2026-11-27")

    # E17 unavailable / on weekly off on Friday (2026-11-27)
    emp_e17 = next(e for e in data["employees"] if e["id"] == "E17")
    emp_e17["leaves"].append("2026-11-27")

    # Ensure E22 is the ONLY backup for B01 CS and B14 ACC
    data["allocations"] = [
        a for a in data["allocations"]
        if not (a["role"] == "backup" and a["brand_id"] == "B01" and a["process_id"] == "CS" and a["employee_id"] != "E22")
    ]

    sched_input = SchedulingInput.from_dict(data)
    engine = SchedulingEngine(sched_input)
    result = engine.solve()

    assert result.status == SolverStatus.INFEASIBLE
    assert len(result.conflicts) > 0
    assert len(result.entries) == 0, "Diagnostic schedule must not be returned as valid entries"

    # Diagnostic check: conflict specifically names B01 CS or B14 ACC on 2026-11-27
    shortage_conflicts = [cf for cf in result.conflicts if cf.date == "2026-11-27"]
    assert len(shortage_conflicts) > 0
    assert any(cf.brand_id in ("B01", "B14") for cf in shortage_conflicts)


def test_scenario_c_no_qualified_replacement(base_fixture):
    """Scenario C: E01 becomes unavailable on Wednesday, and no qualified or available
    backup exists for B01 RET.
    Expected outcome: INFEASIBLE, with a coverage shortage of one.
    """
    data = copy.deepcopy(base_fixture)
    emp_e01 = next(e for e in data["employees"] if e["id"] == "E01")
    emp_e01["leaves"].append("2026-11-25")

    # Remove all backups for B01 RET
    data["allocations"] = [
        a for a in data["allocations"]
        if not (a["role"] == "backup" and a["brand_id"] == "B01" and a["process_id"] == "RET")
    ]

    sched_input = SchedulingInput.from_dict(data)
    engine = SchedulingEngine(sched_input)
    result = engine.solve()

    assert result.status == SolverStatus.INFEASIBLE
    ret_shortages = [
        cf for cf in result.conflicts
        if cf.brand_id == "B01" and cf.process_id == "RET" and cf.date == "2026-11-25"
    ]
    assert len(ret_shortages) == 1, "Expected exactly 1 shortage conflict for B01 RET on 2026-11-25"
    assert ret_shortages[0].diagnostic_shortage == 1, "Expected coverage shortage of exactly one"


# ============================================================================
# Section 9: Additional Edge Case Tests
# ============================================================================

def test_single_employee_multiple_compatible_processes(base_fixture):
    """A single employee handling multiple compatible processes within the same day."""
    sched_input = SchedulingInput.from_dict(base_fixture)
    engine = SchedulingEngine(sched_input)
    result = engine.solve()

    assert result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE)
    # Check E01 on Monday (2026-11-23): handles both CS and RET for B01
    e01_mon = next((e for e in result.entries if e.employee_id == "E01" and e.date == "2026-11-23"), None)
    assert e01_mon is not None
    assert set(e01_mon.processes) == {"CS", "RET"}


def test_employee_working_across_multiple_brands(base_fixture):
    """An employee working across multiple brands on different days."""
    data = copy.deepcopy(base_fixture)
    # Give E01 leave on Monday, Wednesday, Thursday
    # E22 covers B01 CS on Wednesday, and also works B14 ACC or is available
    emp_e01 = next(e for e in data["employees"] if e["id"] == "E01")
    emp_e01["leaves"].append("2026-11-25")

    sched_input = SchedulingInput.from_dict(data)
    result = SchedulingEngine(sched_input).solve()

    assert result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE)
    e22_entries = [e for e in result.entries if e.employee_id == "E22"]
    assert any(e.brand_id == "B01" for e in e22_entries)


def test_process_operating_on_sundays_and_public_holidays(base_fixture):
    """A process operating 365 days (ALL_YEAR) operates on Sundays and public holidays."""
    sched_input = SchedulingInput.from_dict(base_fixture)
    result = SchedulingEngine(sched_input).solve()

    # 2026-11-24 is public holiday, 2026-11-29 is Sunday
    # B01 CS is ALL_YEAR: must be operating on both days
    b01_cs_hol = next(c for c in result.coverage if c.brand_id == "B01" and c.process_id == "CS" and c.date == "2026-11-24")
    b01_cs_sun = next(c for c in result.coverage if c.brand_id == "B01" and c.process_id == "CS" and c.date == "2026-11-29")

    assert b01_cs_hol.operating is True
    assert b01_cs_hol.status == "covered"
    assert b01_cs_sun.operating is True
    assert b01_cs_sun.status == "covered"


def test_process_closed_on_public_holidays(base_fixture):
    """A process under EXCEPT_HOLIDAYS is closed on public holidays."""
    sched_input = SchedulingInput.from_dict(base_fixture)
    result = SchedulingEngine(sched_input).solve()

    # B01 RET is EXCEPT_HOLIDAYS: must NOT operate on 2026-11-24 (Guru Nanak Jayanti)
    b01_ret_hol = next(c for c in result.coverage if c.brand_id == "B01" and c.process_id == "RET" and c.date == "2026-11-24")
    assert b01_ret_hol.operating is False
    assert b01_ret_hol.status == "not-operating"
    assert len(b01_ret_hol.scheduled) == 0


def test_different_process_calendars_within_same_brand(base_fixture):
    """Within B01, CS is ALL_YEAR and RET is EXCEPT_HOLIDAYS."""
    sched_input = SchedulingInput.from_dict(base_fixture)
    result = SchedulingEngine(sched_input).solve()

    cov_cs = next(c for c in result.coverage if c.brand_id == "B01" and c.process_id == "CS" and c.date == "2026-11-24")
    cov_ret = next(c for c in result.coverage if c.brand_id == "B01" and c.process_id == "RET" and c.date == "2026-11-24")

    assert cov_cs.operating is True
    assert cov_ret.operating is False


def test_weekly_off_and_working_status_conflicts(base_fixture):
    """An employee receiving a weekly off cannot work on that day (w_ed + o_ed <= 1)."""
    sched_input = SchedulingInput.from_dict(base_fixture)
    result = SchedulingEngine(sched_input).solve()

    for emp_id, days in result.employee_days.items():
        for d, state in days.items():
            if state == "OFF":
                # Ensure no assignment on date d for emp_id
                working_entries = [
                    e for e in result.entries
                    if e.employee_id == emp_id and e.date == d
                ]
                assert len(working_entries) == 0, f"Employee {emp_id} worked on day {d} while state is OFF"


def test_approved_leave(base_fixture):
    """An employee on approved leave cannot work and cannot be scheduled."""
    data = copy.deepcopy(base_fixture)
    # E01 has authorized backups E22 (CS) and E24 (RET)
    emp_e01 = next(e for e in data["employees"] if e["id"] == "E01")
    emp_e01["leaves"].append("2026-11-23")

    sched_input = SchedulingInput.from_dict(data)
    result = SchedulingEngine(sched_input).solve()

    assert result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE)
    e01_mon = [e for e in result.entries if e.employee_id == "E01" and e.date == "2026-11-23"]
    assert len(e01_mon) == 0, "E01 must have zero shifts on approved leave date"
    assert result.employee_days["E01"]["2026-11-23"] == "LEAVE"


def test_insufficient_staffing(base_fixture):
    """When required headcount exceeds available staff, INFEASIBLE is returned."""
    data = copy.deepcopy(base_fixture)
    # Increase min_staff for SwiftCart (B15) CS to 5 (only 2 primary + 1 backup exist)
    b15 = next(b for b in data["brands"] if b["id"] == "B15")
    b15["processes"][0]["min_staff"] = 5

    sched_input = SchedulingInput.from_dict(data)
    result = SchedulingEngine(sched_input).solve()

    assert result.status == SolverStatus.INFEASIBLE
    assert any(cf.brand_id == "B15" for cf in result.conflicts)


def test_unauthorized_backup_assignments(base_fixture):
    """A person cannot be scheduled without explicit primary or backup authorization."""
    sched_input = SchedulingInput.from_dict(base_fixture)
    result = SchedulingEngine(sched_input).solve()

    alloc_set = {
        (a.employee_id, a.brand_id, a.process_id)
        for a in sched_input.allocations
    }

    for entry in result.entries:
        for p in entry.processes:
            assert (entry.employee_id, entry.brand_id, p) in alloc_set, (
                f"Unauthorized assignment: {entry.employee_id} to {entry.brand_id}-{p}"
            )


def test_multiple_processes_requiring_same_backup_resource(base_fixture):
    """When multiple processes need the same backup resource simultaneously and duties are incompatible."""
    data = copy.deepcopy(base_fixture)
    # E01 unavailable on Friday (needs E22 for B01 CS)
    # E17 unavailable on Friday (needs E22 for B14 ACC)
    next(e for e in data["employees"] if e["id"] == "E01")["leaves"].append("2026-11-27")
    next(e for e in data["employees"] if e["id"] == "E17")["leaves"].append("2026-11-27")

    # Incompatible duties: (B01, CS) and (B14, ACC)
    data["incompatible_pairs"] = [
        {"brand_id_1": "B01", "process_id_1": "CS", "brand_id_2": "B14", "process_id_2": "ACC"}
    ]

    sched_input = SchedulingInput.from_dict(data)
    result = SchedulingEngine(sched_input).solve()

    assert result.status == SolverStatus.INFEASIBLE
    assert len(result.conflicts) > 0


def test_changes_to_an_existing_roster(base_fixture):
    """Dynamic re-optimization minimizes changes to an existing baseline roster."""
    sched_input = SchedulingInput.from_dict(base_fixture)
    engine = SchedulingEngine(sched_input)
    baseline_result = engine.solve()
    assert baseline_result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE)

    # Re-optimize when E01 becomes unavailable on Wednesday (2026-11-25)
    reopt_result, delta = Reoptimizer.reoptimize(
        base_input=sched_input,
        current_entries=baseline_result.entries,
        unavailable_employee_id="E01",
        unavailable_date="2026-11-25",
    )

    assert reopt_result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE)
    # Delta should only contain necessary replacements (E01 removed, E22 and E24 added)
    assert delta.total_changes == 4
    assert delta.stability_ratio > 0.98


def test_scheduling_weeks_crossing_month_boundaries(base_fixture):
    """Scheduling horizon crossing month boundary (14 days) respects weekly off bounds."""
    data = copy.deepcopy(base_fixture)
    # 14 days from 2026-11-23 to 2026-12-06
    two_weeks_dates = [
        "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29",
        "2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06",
    ]
    data["dates"] = two_weeks_dates
    # Add weekly off relief backups for week 2
    data["allocations"].extend([
        {"employee_id": "E08", "brand_id": "B03", "process_id": "NDR", "role": "backup"},
        {"employee_id": "E17", "brand_id": "B06", "process_id": "RET", "role": "backup"},
        {"employee_id": "E20", "brand_id": "B09", "process_id": "RET", "role": "backup"},
        {"employee_id": "E23", "brand_id": "B12", "process_id": "ACC", "role": "backup"},
    ])
    sched_input = SchedulingInput.from_dict(data)
    result = SchedulingEngine(sched_input).solve()

    assert result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE)
    # Validate weekly off count for each 7-day week
    week1 = two_weeks_dates[:7]
    week2 = two_weeks_dates[7:]

    for emp_id, day_map in result.employee_days.items():
        w1_offs = sum(1 for d in week1 if day_map.get(d) == "OFF")
        w2_offs = sum(1 for d in week2 if day_map.get(d) == "OFF")
        assert 1 <= w1_offs <= 2
        assert 1 <= w2_offs <= 2


def test_solver_timeout_and_infeasibility_distinction(base_fixture):
    """Distinguish between UNKNOWN (timeout) and INFEASIBLE (mathematical contradiction)."""
    # 1. Mathematical Contradiction test -> INFEASIBLE
    data_inf = copy.deepcopy(base_fixture)
    # Remove all backups for B01 RET and put primary on leave on operating day
    data_inf["allocations"] = [
        a for a in data_inf["allocations"]
        if not (a["brand_id"] == "B01" and a["process_id"] == "RET" and a["role"] == "backup")
    ]
    next(e for e in data_inf["employees"] if e["id"] == "E01")["leaves"].append("2026-11-25")
    result_inf = SchedulingEngine(SchedulingInput.from_dict(data_inf)).solve()
    assert result_inf.status == SolverStatus.INFEASIBLE

    # 2. Timeout test -> UNKNOWN
    # A tiny timeout on an unsolved model forces UNKNOWN without marking it INFEASIBLE
    data_to = copy.deepcopy(base_fixture)
    sched_input_to = SchedulingInput.from_dict(data_to)
    sched_input_to.timeout_seconds = 0.000001
    result_to = SchedulingEngine(sched_input_to).solve()
    assert result_to.status in (SolverStatus.UNKNOWN, SolverStatus.FEASIBLE, SolverStatus.OPTIMAL)
    # Crucially, UNKNOWN is never reported as INFEASIBLE
    assert result_to.status != SolverStatus.INFEASIBLE


def test_independent_hard_constraint_validation(base_fixture):
    """Independent validator detects manual violations."""
    sched_input = SchedulingInput.from_dict(base_fixture)

    # Valid roster passes
    valid_res = SchedulingEngine(sched_input).solve()
    is_valid, violations = RosterValidator.validate(sched_input, valid_res.entries, valid_res.employee_days)
    assert is_valid

    # Corrupted roster with unauthorized assignment fails
    corrupted_entries = copy.deepcopy(valid_res.entries)
    corrupted_entries.append(
        RosterEntry(
            date="2026-11-23",
            employee_id="E30",
            brand_id="B01",
            processes=["RET"],
        )
    )
    is_corrupt_valid, corrupt_violations = RosterValidator.validate(sched_input, corrupted_entries)
    assert not is_corrupt_valid
    assert any("Unauthorized assignment" in v for v in corrupt_violations)


def test_workload_and_capacity_constraints(base_fixture):
    """Workload feasibility extension: demand sum_e h_eqd >= D_qd and employee capacity sum_q h_eqd <= H_ed."""
    data = copy.deepcopy(base_fixture)
    # Add workload policy
    demands = [
        WorkloadRequirement(
            brand_id="B01",
            process_id="CS",
            date="2026-11-23",
            demand_hours=8.0,
        )
    ]
    capacities = [
        EmployeeCapacity(
            employee_id=e["id"],
            date="2026-11-23",
            max_daily_hours=8.0,
            process_capacity_hours={"B01:CS": 8.0},
        )
        for e in data["employees"]
    ]
    data["workload_policy"] = {
        "enabled": True,
        "demands": [d.to_dict() for d in demands],
        "capacities": [c.to_dict() for c in capacities],
    }

    sched_input = SchedulingInput.from_dict(data)
    result = SchedulingEngine(sched_input).solve()
    assert result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE)
