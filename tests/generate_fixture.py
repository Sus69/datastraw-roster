"""Generate and independently validate datastraw_self_test_fixture.json.

Matches every specification in Section 8:
- 30 employees (E01 to E30)
- 3 pods (POD1, POD2, POD3)
- 15 brands (B01 to B15: 12 single-primary-resource brands, 3 multi-resource brands)
- 31 brand-process combinations
- 7-day scheduling period (2026-11-23 to 2026-11-29)
- Different operating calendars (ALL_YEAR, EXCEPT_HOLIDAYS, NO_SUN_HOLIDAYS)
- Approved backup resources (including E22 and E24)
- A reference baseline roster (optimal solution computed by CP-SAT)
"""

from __future__ import annotations

import json
import os
import sys

# Ensure engine is on path
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
    Pod,
    SchedulingInput,
    SolverStatus,
)
from engine.model import SchedulingEngine
from engine.validator import RosterValidator


def build_fixture_data() -> dict:
    # 7-day period: 2026-11-23 (Mon) to 2026-11-29 (Sun)
    # 2026-11-24 is Tuesday (Guru Nanak Jayanti public holiday)
    # 2026-11-29 is Sunday
    dates = [
        "2026-11-23",  # Mon
        "2026-11-24",  # Tue - Holiday
        "2026-11-25",  # Wed
        "2026-11-26",  # Thu
        "2026-11-27",  # Fri
        "2026-11-28",  # Sat
        "2026-11-29",  # Sun
    ]

    holidays = [
        {"date": "2026-11-24", "name": "Guru Nanak Jayanti"}
    ]

    pods = [
        {"id": "POD1", "name": "Pod Alpha", "lead_id": "E01"},
        {"id": "POD2", "name": "Pod Beta", "lead_id": "E11"},
        {"id": "POD3", "name": "Pod Gamma", "lead_id": "E21"},
    ]

    # 30 Employees: E01 to E30
    # Pod 1: E01 - E10
    # Pod 2: E11 - E20
    # Pod 3: E21 - E30
    # weekly_off: preferred day (0=Sun, 1=Mon, ..., 6=Sat)
    # 2026-11-23 is Mon (1), 2026-11-24 Tue (2), 2026-11-25 Wed (3),
    # 2026-11-26 Thu (4), 2026-11-27 Fri (5), 2026-11-28 Sat (6), 2026-11-29 Sun (0)
    employees = []
    # E01 prefers Sunday (0)
    employees.append({"id": "E01", "name": "Aarav Mehta", "pod_id": "POD1", "weekly_off": [0], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E02", "name": "Priya Sharma", "pod_id": "POD1", "weekly_off": [1], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E03", "name": "Rohan Iyer", "pod_id": "POD1", "weekly_off": [2], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E04", "name": "Kavya Nair", "pod_id": "POD1", "weekly_off": [3], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E05", "name": "Arjun Patel", "pod_id": "POD1", "weekly_off": [4], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E06", "name": "Sneha Kulkarni", "pod_id": "POD1", "weekly_off": [5], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E07", "name": "Vikram Singh", "pod_id": "POD1", "weekly_off": [6], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E08", "name": "Ananya Gupta", "pod_id": "POD1", "weekly_off": [0], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E09", "name": "Dev Malhotra", "pod_id": "POD1", "weekly_off": [1], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E10", "name": "Pooja Hegde", "pod_id": "POD1", "weekly_off": [2], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})

    employees.append({"id": "E11", "name": "Neha Joshi", "pod_id": "POD2", "weekly_off": [2], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E12", "name": "Kabir Shah", "pod_id": "POD2", "weekly_off": [3], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E13", "name": "Riya Kapoor", "pod_id": "POD2", "weekly_off": [4], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E14", "name": "Manish Verma", "pod_id": "POD2", "weekly_off": [5], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E15", "name": "Pooja Desai", "pod_id": "POD2", "weekly_off": [6], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E16", "name": "Farhan Khan", "pod_id": "POD2", "weekly_off": [0], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    # E17 prefers Friday (5)
    employees.append({"id": "E17", "name": "Ishita Bose", "pod_id": "POD2", "weekly_off": [5], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E18", "name": "Sahil Ahmed", "pod_id": "POD2", "weekly_off": [2], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E19", "name": "Aditi Roy", "pod_id": "POD2", "weekly_off": [3], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E20", "name": "Tarun Gill", "pod_id": "POD2", "weekly_off": [4], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})

    employees.append({"id": "E21", "name": "Divya Reddy", "pod_id": "POD3", "weekly_off": [3], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    # E22 and E24: key backups in Scenarios A & B
    employees.append({"id": "E22", "name": "Shreya Menon", "pod_id": "POD3", "weekly_off": [0], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E23", "name": "Varun Chopra", "pod_id": "POD3", "weekly_off": [1], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E24", "name": "Nisha Agarwal", "pod_id": "POD3", "weekly_off": [2], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E25", "name": "Karan Bhatia", "pod_id": "POD3", "weekly_off": [3], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E26", "name": "Rahul Khanna", "pod_id": "POD3", "weekly_off": [4], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E27", "name": "Meera Pillai", "pod_id": "POD3", "weekly_off": [5], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E28", "name": "Sanjay Yadav", "pod_id": "POD3", "weekly_off": [6], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E29", "name": "Tara Singh", "pod_id": "POD3", "weekly_off": [0], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})
    employees.append({"id": "E30", "name": "Yash Thakur", "pod_id": "POD3", "weekly_off": [1], "leaves": [], "comp_offs": [], "min_weekly_off": 1, "max_weekly_off": 2})

    # 15 Brands:
    # 12 Single-primary resource brands: B01 to B12
    # 3 Multi-resource brands: B13 to B15
    # Total brand-process combinations: 31
    brands = [
        # B01: GlowKart (Pod 1, Primary: E01) - 2 processes
        {
            "id": "B01", "name": "GlowKart", "category": "Beauty", "pod_id": "POD1",
            "processes": [
                {"process_id": "CS", "rule": "ALL_YEAR", "min_staff": 1},
                {"process_id": "RET", "rule": "EXCEPT_HOLIDAYS", "min_staff": 1},
            ]
        },
        # B02: FitFuel (Pod 1, Primary: E02) - 2 processes
        {
            "id": "B02", "name": "FitFuel", "category": "Nutrition", "pod_id": "POD1",
            "processes": [
                {"process_id": "CS", "rule": "ALL_YEAR", "min_staff": 1},
                {"process_id": "RET", "rule": "NO_SUN_HOLIDAYS", "min_staff": 1},
            ]
        },
        # B03: UrbanNest (Pod 1, Primary: E03) - 2 processes
        {
            "id": "B03", "name": "UrbanNest", "category": "Home Decor", "pod_id": "POD1",
            "processes": [
                {"process_id": "CS", "rule": "NO_SUN_HOLIDAYS", "min_staff": 1},
                {"process_id": "NDR", "rule": "EXCEPT_HOLIDAYS", "min_staff": 1},
            ]
        },
        # B04: TechTrove (Pod 1, Primary: E04) - 3 processes
        {
            "id": "B04", "name": "TechTrove", "category": "Electronics", "pod_id": "POD1",
            "processes": [
                {"process_id": "CS", "rule": "ALL_YEAR", "min_staff": 1},
                {"process_id": "ACC", "rule": "ALL_YEAR", "min_staff": 1},
                {"process_id": "NDR", "rule": "EXCEPT_HOLIDAYS", "min_staff": 1},
            ]
        },
        # B05: PetPals (Pod 1, Primary: E05) - 2 processes
        {
            "id": "B05", "name": "PetPals", "category": "Pet Care", "pod_id": "POD1",
            "processes": [
                {"process_id": "CS", "rule": "EXCEPT_HOLIDAYS", "min_staff": 1},
                {"process_id": "RET", "rule": "NO_SUN_HOLIDAYS", "min_staff": 1},
            ]
        },
        # B06: StyleSutra (Pod 2, Primary: E11) - 3 processes
        {
            "id": "B06", "name": "StyleSutra", "category": "Fashion", "pod_id": "POD2",
            "processes": [
                {"process_id": "CS", "rule": "ALL_YEAR", "min_staff": 1},
                {"process_id": "ACC", "rule": "NO_SUN_HOLIDAYS", "min_staff": 1},
                {"process_id": "RET", "rule": "EXCEPT_HOLIDAYS", "min_staff": 1},
            ]
        },
        # B07: SnackBox (Pod 2, Primary: E12) - 2 processes
        {
            "id": "B07", "name": "SnackBox", "category": "Gourmet", "pod_id": "POD2",
            "processes": [
                {"process_id": "CS", "rule": "ALL_YEAR", "min_staff": 1},
                {"process_id": "ACC", "rule": "ALL_YEAR", "min_staff": 1},
            ]
        },
        # B08: BabyBliss (Pod 2, Primary: E13) - 2 processes
        {
            "id": "B08", "name": "BabyBliss", "category": "Baby Care", "pod_id": "POD2",
            "processes": [
                {"process_id": "CS", "rule": "EXCEPT_HOLIDAYS", "min_staff": 1},
                {"process_id": "NDR", "rule": "NO_SUN_HOLIDAYS", "min_staff": 1},
            ]
        },
        # B09: GreenLeaf (Pod 2, Primary: E14) - 3 processes
        {
            "id": "B09", "name": "GreenLeaf", "category": "Organic", "pod_id": "POD2",
            "processes": [
                {"process_id": "CS", "rule": "NO_SUN_HOLIDAYS", "min_staff": 1},
                {"process_id": "RET", "rule": "EXCEPT_HOLIDAYS", "min_staff": 1},
                {"process_id": "ACC", "rule": "NO_SUN_HOLIDAYS", "min_staff": 1},
            ]
        },
        # B10: AutoAce (Pod 2, Primary: E15) - 2 processes
        {
            "id": "B10", "name": "AutoAce", "category": "Automotive", "pod_id": "POD2",
            "processes": [
                {"process_id": "CS", "rule": "ALL_YEAR", "min_staff": 1},
                {"process_id": "NDR", "rule": "ALL_YEAR", "min_staff": 1},
            ]
        },
        # B11: BookBarn (Pod 3, Primary: E25) - 2 processes
        {
            "id": "B11", "name": "BookBarn", "category": "Books", "pod_id": "POD3",
            "processes": [
                {"process_id": "CS", "rule": "NO_SUN_HOLIDAYS", "min_staff": 1},
                {"process_id": "RET", "rule": "NO_SUN_HOLIDAYS", "min_staff": 1},
            ]
        },
        # B12: PureDrop (Pod 3, Primary: E26) - 2 processes
        {
            "id": "B12", "name": "PureDrop", "category": "Beverages", "pod_id": "POD3",
            "processes": [
                {"process_id": "CS", "rule": "ALL_YEAR", "min_staff": 1},
                {"process_id": "ACC", "rule": "EXCEPT_HOLIDAYS", "min_staff": 1},
            ]
        },
        # B13: WellnessWave (Multi-resource: Pod 3, Primary CS: E27, Primary RET: E28) - 2 processes
        {
            "id": "B13", "name": "WellnessWave", "category": "Fitness", "pod_id": "POD3",
            "processes": [
                {"process_id": "CS", "rule": "ALL_YEAR", "min_staff": 1},
                {"process_id": "RET", "rule": "ALL_YEAR", "min_staff": 1},
            ]
        },
        # B14: AuraGlow (Multi-resource: Pod 2, Primary CS: E16, Primary ACC: E17) - 2 processes
        {
            "id": "B14", "name": "AuraGlow", "category": "Cosmetics", "pod_id": "POD2",
            "processes": [
                {"process_id": "CS", "rule": "ALL_YEAR", "min_staff": 1},
                {"process_id": "ACC", "rule": "ALL_YEAR", "min_staff": 1},
            ]
        },
        # B15: SwiftCart (Multi-resource: Pod 3, Primary CS: E29, E30 with min_staff 2) - 1 process
        {
            "id": "B15", "name": "SwiftCart", "category": "Logistics", "pod_id": "POD3",
            "processes": [
                {"process_id": "CS", "rule": "ALL_YEAR", "min_staff": 2},
            ]
        },
    ]
    # Check total brand-process combinations:
    # 2+2+2+3+2+3+2+2+3+2+2+2+2+2+1 = 31 processes!

    # Allocations
    allocations = [
        # Dedicated Primaries for B01 to B12
        {"employee_id": "E01", "brand_id": "B01", "process_id": "CS", "role": "primary"},
        {"employee_id": "E01", "brand_id": "B01", "process_id": "RET", "role": "primary"},

        {"employee_id": "E02", "brand_id": "B02", "process_id": "CS", "role": "primary"},
        {"employee_id": "E02", "brand_id": "B02", "process_id": "RET", "role": "primary"},

        {"employee_id": "E03", "brand_id": "B03", "process_id": "CS", "role": "primary"},
        {"employee_id": "E03", "brand_id": "B03", "process_id": "NDR", "role": "primary"},

        {"employee_id": "E04", "brand_id": "B04", "process_id": "CS", "role": "primary"},
        {"employee_id": "E04", "brand_id": "B04", "process_id": "ACC", "role": "primary"},
        {"employee_id": "E04", "brand_id": "B04", "process_id": "NDR", "role": "primary"},

        {"employee_id": "E05", "brand_id": "B05", "process_id": "CS", "role": "primary"},
        {"employee_id": "E05", "brand_id": "B05", "process_id": "RET", "role": "primary"},

        {"employee_id": "E11", "brand_id": "B06", "process_id": "CS", "role": "primary"},
        {"employee_id": "E11", "brand_id": "B06", "process_id": "ACC", "role": "primary"},
        {"employee_id": "E11", "brand_id": "B06", "process_id": "RET", "role": "primary"},

        {"employee_id": "E12", "brand_id": "B07", "process_id": "CS", "role": "primary"},
        {"employee_id": "E12", "brand_id": "B07", "process_id": "ACC", "role": "primary"},

        {"employee_id": "E13", "brand_id": "B08", "process_id": "CS", "role": "primary"},
        {"employee_id": "E13", "brand_id": "B08", "process_id": "NDR", "role": "primary"},

        {"employee_id": "E14", "brand_id": "B09", "process_id": "CS", "role": "primary"},
        {"employee_id": "E14", "brand_id": "B09", "process_id": "RET", "role": "primary"},
        {"employee_id": "E14", "brand_id": "B09", "process_id": "ACC", "role": "primary"},

        {"employee_id": "E15", "brand_id": "B10", "process_id": "CS", "role": "primary"},
        {"employee_id": "E15", "brand_id": "B10", "process_id": "NDR", "role": "primary"},

        {"employee_id": "E25", "brand_id": "B11", "process_id": "CS", "role": "primary"},
        {"employee_id": "E25", "brand_id": "B11", "process_id": "RET", "role": "primary"},

        {"employee_id": "E26", "brand_id": "B12", "process_id": "CS", "role": "primary"},
        {"employee_id": "E26", "brand_id": "B12", "process_id": "ACC", "role": "primary"},

        # Multi-resource brand primaries
        {"employee_id": "E27", "brand_id": "B13", "process_id": "CS", "role": "primary"},
        {"employee_id": "E28", "brand_id": "B13", "process_id": "RET", "role": "primary"},

        {"employee_id": "E16", "brand_id": "B14", "process_id": "CS", "role": "primary"},
        {"employee_id": "E17", "brand_id": "B14", "process_id": "ACC", "role": "primary"},

        {"employee_id": "E29", "brand_id": "B15", "process_id": "CS", "role": "primary"},
        {"employee_id": "E30", "brand_id": "B15", "process_id": "CS", "role": "primary"},

        # Authorized Backup Resources
        # E22 covers B01 CS and B14 ACC as backup
        {"employee_id": "E22", "brand_id": "B01", "process_id": "CS", "role": "backup"},
        {"employee_id": "E22", "brand_id": "B14", "process_id": "ACC", "role": "backup"},

        # E24 covers B01 RET as backup
        {"employee_id": "E24", "brand_id": "B01", "process_id": "RET", "role": "backup"},

        # Float / Cross-cover backups for weekly off relief
        {"employee_id": "E07", "brand_id": "B02", "process_id": "CS", "role": "backup"},
        {"employee_id": "E08", "brand_id": "B03", "process_id": "CS", "role": "backup"},
        {"employee_id": "E09", "brand_id": "B04", "process_id": "CS", "role": "backup"},
        {"employee_id": "E10", "brand_id": "B04", "process_id": "ACC", "role": "backup"},
        {"employee_id": "E09", "brand_id": "B04", "process_id": "NDR", "role": "backup"},
        {"employee_id": "E10", "brand_id": "B05", "process_id": "CS", "role": "backup"},

        {"employee_id": "E18", "brand_id": "B06", "process_id": "CS", "role": "backup"},
        {"employee_id": "E19", "brand_id": "B07", "process_id": "CS", "role": "backup"},
        {"employee_id": "E20", "brand_id": "B07", "process_id": "ACC", "role": "backup"},
        {"employee_id": "E20", "brand_id": "B08", "process_id": "CS", "role": "backup"},
        {"employee_id": "E18", "brand_id": "B10", "process_id": "CS", "role": "backup"},
        {"employee_id": "E20", "brand_id": "B10", "process_id": "NDR", "role": "backup"},
        {"employee_id": "E18", "brand_id": "B14", "process_id": "CS", "role": "backup"},

        {"employee_id": "E21", "brand_id": "B11", "process_id": "CS", "role": "backup"},
        {"employee_id": "E23", "brand_id": "B12", "process_id": "CS", "role": "backup"},
        {"employee_id": "E21", "brand_id": "B13", "process_id": "CS", "role": "backup"},
        {"employee_id": "E23", "brand_id": "B13", "process_id": "RET", "role": "backup"},
        {"employee_id": "E24", "brand_id": "B15", "process_id": "CS", "role": "backup"},
    ]

    return {
        "metadata": {
            "title": "DataStraw Smart Workforce Scheduling Self-Test Fixture",
            "employees_count": len(employees),
            "pods_count": len(pods),
            "brands_count": len(brands),
            "single_primary_brands_count": 12,
            "multi_resource_brands_count": 3,
            "processes_count": sum(len(b["processes"]) for b in brands),
            "horizon_days": len(dates),
            "start_date": dates[0],
            "end_date": dates[-1],
        },
        "dates": dates,
        "holidays": holidays,
        "pods": pods,
        "employees": employees,
        "brands": brands,
        "allocations": allocations,
        "incompatible_pairs": [
            {
                "brand_id_1": "B01", "process_id_1": "CS",
                "brand_id_2": "B14", "process_id_2": "ACC",
            }
        ],
        "workload_policy": {"enabled": False, "demands": [], "capacities": []},
        "reference_roster": [],
    }


def generate_and_validate():
    fixture = build_fixture_data()

    # Step 1: Solve baseline roster
    sched_input = SchedulingInput.from_dict(fixture)
    engine = SchedulingEngine(sched_input)
    baseline_result = engine.solve(lexicographic=True)

    print("Baseline Solve Status:", baseline_result.status.value)
    print("Baseline Operating Slots:", baseline_result.stats.operating_slots)
    print("Baseline Covered Slots:", baseline_result.stats.covered_slots)
    print("Baseline Errors:", baseline_result.stats.errors)

    if baseline_result.status not in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE):
        raise RuntimeError("Baseline roster generation failed!")

    # Populate reference_roster in fixture
    ref_roster = []
    for entry in baseline_result.entries:
        for p in entry.processes:
            ref_roster.append({
                "employee_id": entry.employee_id,
                "brand_id": entry.brand_id,
                "process_id": p,
                "date": entry.date,
            })
    fixture["reference_roster"] = ref_roster

    # Save to JSON
    target_path = os.path.join(parent_dir, "datastraw_self_test_fixture.json")
    workspace_root_path = os.path.join(os.path.dirname(parent_dir), "datastraw_self_test_fixture.json")

    with open(target_path, "w", encoding="utf-8") as f:
        json.dump(fixture, f, indent=2)
    print("Saved fixture to", target_path)

    try:
        with open(workspace_root_path, "w", encoding="utf-8") as f:
            json.dump(fixture, f, indent=2)
        print("Saved fixture copy to", workspace_root_path)
    except Exception as e:
        print("Could not copy to workspace root:", e)

    # Step 2: Validate Scenario A
    # E01 becomes unavailable on Wednesday (2026-11-25)
    # E22 can cover B01 CS, E24 can cover B01 RET
    # Expected outcome: FEASIBLE
    data_a = json.loads(json.dumps(fixture))
    emp_e01 = next(e for e in data_a["employees"] if e["id"] == "E01")
    emp_e01["leaves"].append("2026-11-25")
    input_a = SchedulingInput.from_dict(data_a)
    result_a = SchedulingEngine(input_a).solve()
    print("Scenario A Status:", result_a.status.value)
    assert result_a.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE), f"Expected FEASIBLE, got {result_a.status}"

    # Verify E22 and E24 cover B01 on Wednesday
    wed_b01 = [e for e in result_a.entries if e.date == "2026-11-25" and e.brand_id == "B01"]
    wed_b01_emps = {e.employee_id for e in wed_b01}
    print("Scenario A Wednesday B01 scheduled:", wed_b01_emps)
    assert "E22" in wed_b01_emps, "E22 should cover B01 CS on Wednesday"
    assert "E24" in wed_b01_emps, "E24 should cover B01 RET on Wednesday"

    # Step 3: Validate Scenario B
    # E01 unavailable on Friday (2026-11-27).
    # E17 is on weekly off on Friday (preferred off = 5).
    # E22 is the ONLY approved relief employee for B01 CS and B14 ACC, but duties overlap.
    # Incompatible: (B01, CS) and (B14, ACC).
    # Expected outcome: INFEASIBLE.
    data_b = json.loads(json.dumps(fixture))
    emp_e01_b = next(e for e in data_b["employees"] if e["id"] == "E01")
    emp_e01_b["leaves"].append("2026-11-27")
    # Make E17 unavailable or enforce weekly off Friday
    emp_e17_b = next(e for e in data_b["employees"] if e["id"] == "E17")
    emp_e17_b["leaves"].append("2026-11-27") # E17 takes leave/off on Friday

    # In B, ensure E22 is the ONLY backup for B01 CS and B14 ACC
    data_b["allocations"] = [
        a for a in data_b["allocations"]
        if not (a["role"] == "backup" and a["brand_id"] == "B01" and a["process_id"] == "CS" and a["employee_id"] != "E22")
    ]
    # Incompatible rule is already in incompatible_pairs
    input_b = SchedulingInput.from_dict(data_b)
    result_b = SchedulingEngine(input_b).solve()
    print("Scenario B Status:", result_b.status.value)
    assert result_b.status == SolverStatus.INFEASIBLE, f"Expected INFEASIBLE, got {result_b.status}"
    print("Scenario B Diagnostic Conflicts:", len(result_b.conflicts))
    for cf in result_b.conflicts:
        print("  -", cf.message)

    # Step 4: Validate Scenario C
    # E01 unavailable on Wednesday (2026-11-25)
    # No qualified or available backup for B01 RET.
    # Expected outcome: INFEASIBLE, shortage of 1.
    data_c = json.loads(json.dumps(fixture))
    emp_e01_c = next(e for e in data_c["employees"] if e["id"] == "E01")
    emp_e01_c["leaves"].append("2026-11-25")
    # Remove all backups for B01 RET
    data_c["allocations"] = [
        a for a in data_c["allocations"]
        if not (a["role"] == "backup" and a["brand_id"] == "B01" and a["process_id"] == "RET")
    ]
    input_c = SchedulingInput.from_dict(data_c)
    result_c = SchedulingEngine(input_c).solve()
    print("Scenario C Status:", result_c.status.value)
    assert result_c.status == SolverStatus.INFEASIBLE, f"Expected INFEASIBLE, got {result_c.status}"
    ret_conflicts = [cf for cf in result_c.conflicts if cf.brand_id == "B01" and cf.process_id == "RET" and cf.date == "2026-11-25"]
    print("Scenario C RET conflicts count:", len(ret_conflicts))
    assert len(ret_conflicts) > 0, "Expected shortage conflict for B01 RET on 2026-11-25"
    print("Scenario C shortage:", ret_conflicts[0].diagnostic_shortage)
    assert ret_conflicts[0].diagnostic_shortage == 1, "Expected shortage of 1"

    print("\nALL SCENARIOS VERIFIED SUCCESSFULLY!")


if __name__ == "__main__":
    generate_and_validate()
