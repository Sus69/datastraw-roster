"""Command-line interface for the workforce scheduling engine.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .domain import RosterEntry, SchedulingInput, SolverStatus
from .model import SchedulingEngine
from .reoptimizer import Reoptimizer
from .validator import RosterValidator


def main():
    parser = argparse.ArgumentParser(description="Smart Workforce Scheduling Engine (CP-SAT)")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Solve command
    solve_parser = subparsers.add_parser("solve", help="Generate or optimize a workforce roster")
    solve_parser.add_argument("--input", "-i", required=True, help="Path to input JSON file")
    solve_parser.add_argument("--output", "-o", help="Path to save result JSON file")
    solve_parser.add_argument("--timeout", type=float, default=10.0, help="Solver timeout in seconds")

    # Validate command
    val_parser = subparsers.add_parser("validate", help="Validate an existing roster against hard constraints")
    val_parser.add_argument("--input", "-i", required=True, help="Path to input JSON specification")
    val_parser.add_argument("--roster", "-r", required=True, help="Path to roster entries JSON file")

    # Re-optimize command
    reopt_parser = subparsers.add_parser("reoptimize", help="Dynamically re-optimize an existing roster")
    reopt_parser.add_argument("--input", "-i", required=True, help="Path to input JSON specification")
    reopt_parser.add_argument("--roster", "-r", required=True, help="Path to current roster entries JSON")
    reopt_parser.add_argument("--emp", help="Employee ID becoming unavailable")
    reopt_parser.add_argument("--date", help="Date of unavailability (YYYY-MM-DD)")
    reopt_parser.add_argument("--output", "-o", help="Path to save re-optimized result JSON")

    args = parser.parse_args()

    if args.command == "solve":
        with open(args.input, "r", encoding="utf-8") as f:
            data = json.load(f)
        sched_input = SchedulingInput.from_dict(data)
        sched_input.timeout_seconds = args.timeout

        engine = SchedulingEngine(sched_input)
        result = engine.solve()

        output_dict = result.to_dict()
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(output_dict, f, indent=2)
            print(f"Result saved to {args.output}")
        else:
            print(json.dumps(output_dict, indent=2))

        sys.exit(0 if result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE) else 1)

    elif args.command == "validate":
        with open(args.input, "r", encoding="utf-8") as f:
            spec_data = json.load(f)
        with open(args.roster, "r", encoding="utf-8") as f:
            roster_data = json.load(f)

        sched_input = SchedulingInput.from_dict(spec_data)
        if isinstance(roster_data, dict) and "entries" in roster_data:
            entries = [RosterEntry(**e) for e in roster_data["entries"]]
        elif isinstance(roster_data, list):
            entries = [RosterEntry(**e) for e in roster_data]
        else:
            print("Invalid roster JSON format. Expected list of entries or dict with 'entries'.")
            sys.exit(2)

        is_valid, violations = RosterValidator.validate(sched_input, entries)
        if is_valid:
            print("ROSTER VALIDATION SUCCESSFUL: All hard constraints satisfied.")
            sys.exit(0)
        else:
            print(f"ROSTER VALIDATION FAILED: {len(violations)} constraint violations found:")
            for v in violations:
                print(f"  - {v}")
            sys.exit(1)

    elif args.command == "reoptimize":
        with open(args.input, "r", encoding="utf-8") as f:
            spec_data = json.load(f)
        with open(args.roster, "r", encoding="utf-8") as f:
            roster_data = json.load(f)

        sched_input = SchedulingInput.from_dict(spec_data)
        if isinstance(roster_data, dict) and "entries" in roster_data:
            entries = [RosterEntry(**e) for e in roster_data["entries"]]
        else:
            entries = [RosterEntry(**e) for e in roster_data]

        result, delta = Reoptimizer.reoptimize(
            sched_input,
            entries,
            unavailable_employee_id=args.emp,
            unavailable_date=args.date,
        )

        out = {
            "result": result.to_dict(),
            "delta": {
                "total_changes": delta.total_changes,
                "added_assignments": delta.added_assignments,
                "removed_assignments": delta.removed_assignments,
                "unaffected_assignments_count": delta.unaffected_assignments_count,
                "stability_ratio": delta.stability_ratio,
            },
        }

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(out, f, indent=2)
            print(f"Re-optimization result saved to {args.output}")
        else:
            print(json.dumps(out, indent=2))

        sys.exit(0 if result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE) else 1)


if __name__ == "__main__":
    main()
