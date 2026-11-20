"""Lightweight HTTP API Server for integrating CP-SAT Scheduling Engine with Web UI.

Uses Python standard library http.server for zero-dependency local execution.
Endpoints:
    POST /api/schedule
    POST /api/reoptimize
    POST /api/validate
    GET  /api/fixture
    GET  /api/health
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict

# Ensure engine package is importable
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

from engine.domain import RosterEntry, SchedulingInput, SolverStatus
from engine.model import SchedulingEngine
from engine.reoptimizer import Reoptimizer
from engine.validator import RosterValidator


class SchedulingRequestHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def _read_json(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        body = self.rfile.read(length).decode("utf-8")
        return json.loads(body)

    def _write_json(self, status_code: int, data: Any):
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/api/health":
            self._write_json(200, {
                "status": "ok",
                "solver": "Google OR-Tools CP-SAT",
                "ready": True,
            })
        elif self.path == "/api/fixture":
            fixture_path = os.path.join(parent_dir, "datastraw_self_test_fixture.json")
            if not os.path.exists(fixture_path):
                fixture_path = os.path.join(os.path.dirname(parent_dir), "datastraw_self_test_fixture.json")
            if os.path.exists(fixture_path):
                with open(fixture_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                self._write_json(200, data)
            else:
                self._write_json(404, {"error": "datastraw_self_test_fixture.json not found"})
        else:
            self._write_json(404, {"error": f"Unknown endpoint {self.path}"})

    def do_POST(self):
        try:
            if self.path == "/api/schedule":
                data = self._read_json()
                sched_input = SchedulingInput.from_dict(data)
                engine = SchedulingEngine(sched_input)
                result = engine.solve()
                self._write_json(200, result.to_dict())

            elif self.path == "/api/reoptimize":
                data = self._read_json()
                base_data = data.get("input", {})
                current_entries_raw = data.get("entries", [])
                sched_input = SchedulingInput.from_dict(base_data)
                current_entries = [RosterEntry(**e) for e in current_entries_raw]

                result, delta = Reoptimizer.reoptimize(
                    sched_input,
                    current_entries,
                    unavailable_employee_id=data.get("unavailable_employee_id"),
                    unavailable_date=data.get("unavailable_date"),
                    approved_leaves=[tuple(x) for x in data.get("approved_leaves", [])],
                    weekly_off_changes=data.get("weekly_off_changes"),
                    timeout_seconds=float(data.get("timeout_seconds", 10.0)),
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
                status_code = 200 if result.status in (SolverStatus.OPTIMAL, SolverStatus.FEASIBLE) else 422
                self._write_json(status_code, out)

            elif self.path == "/api/validate":
                data = self._read_json()
                spec_data = data.get("input", {})
                entries_data = data.get("entries", [])
                sched_input = SchedulingInput.from_dict(spec_data)
                entries = [RosterEntry(**e) for e in entries_data]
                is_valid, violations = RosterValidator.validate(sched_input, entries)
                self._write_json(200, {
                    "is_valid": is_valid,
                    "violations": violations,
                })
            else:
                self._write_json(404, {"error": f"Unknown endpoint {self.path}"})
        except Exception as ex:
            self._write_json(500, {"error": str(ex)})

    def log_message(self, format, *args):
        # Quiet logger to keep terminal clean
        pass


def run_server(port: int = 8000):
    server = HTTPServer(("0.0.0.0", port), SchedulingRequestHandler)
    print(f"CP-SAT Scheduling Engine Server listening on port {port}...")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping server...")
    finally:
        server.server_close()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    run_server(port)
