# Smart Roster Management System — Datastraw Hiring Assignment

A browser-based roster management tool for an operations company that runs
support and operational processes for multiple D2C brands. It plans, generates,
validates and manages monthly rosters across brands, processes and pods, and
flags coverage conflicts instead of silently producing an invalid roster.

Built with React 19 + TypeScript + Vite. No backend, no network calls — all data
is local seed data, and any edits are saved in the browser (localStorage).

## Setup

```bash
npm install
npm run dev      # start the dev server (http://localhost:5173)
npm run build    # type-check + production build
npm run preview  # serve the production build locally
```

## What it does

- **Data model:** 36 employees, 12 fictional D2C brands, 4 processes
  (Customer Support, Abandoned Cart Conversions, Retention, Non-Delivery
  Report), 4 operational pods each with a pod lead, and resource allocations
  (employee → brand + process, primary or secondary). ~83% of brands (10 of 12)
  have one dedicated employee handling all of that brand's processes; BookBarn
  has 2 employees and WellnessWave has 3. The remaining employees are shared
  across brands or act as pod floaters (backup cover). Two additional recovery
  specialists (e35, e36) strengthen GlowKart, BookBarn and TechTrove cover;
  e36's TechTrove cover is backed by an explicit cross-pod authorization.
- **Working rules per brand/process:** 365-day ops, daily except public
  holidays, or Sundays + public holidays off. Different processes in the same
  brand can have different rules. Minimum staffing is configurable per
  brand/process.
- **Roster generation:** pick a month (default December 2026). The engine
  respects operating calendars, availability, weekly offs, planned leaves,
  comp-offs and minimum staffing. Most-constrained slots are filled first.
- **Conflict detection & validation:** coverage gaps, understaffing, weekly-off
  overrides, double-booking and leave clashes — each with an explanation and a
  suggested fix. Mandatory constraints (coverage, leaves) are errors; weekly-off
  overrides are warnings.
- **Views:** company-wide monthly grid, pod-wise, brand-wise (coverage per day),
  process-wise, employee-wise (working days, offs, holidays, leaves).
- **Editing:** change weekly offs, add/remove leaves, change a brand/process
  operating rule or minimum staffing — the whole month re-generates and
  re-validates immediately. Edits persist in localStorage; "Reset to seed data"
  restores the original dataset.
- **Simulate a change:** mark any employee unavailable on any day, preview the
  new conflicts it creates and the suggested backup, then apply or discard.
- **Roster recovery:** "Find backup" is now a constraint-aware recovery engine.
  It discovers unassigned same-brand and same-pod employees plus safely
  reassignable employees on other brands, simulates the whole day's coverage,
  rejects moves that would create another gap, independently validates the
  resulting directive, ranks valid repairs lexicographically, and keeps every
  repair date-specific so permanent allocations and unrelated roster entries
  are never silently changed.
- **Extras:** CSV export of the roster, search/filter, backup suggestions on
  every conflict.

## Assumptions

- All brand and employee names are fictional. The public holidays listed are
  real India holidays for Nov 2026 – Feb 2027 (Guru Nanak Jayanti, Christmas,
  New Year's Day, Makar Sankranti, Republic Day, Shivaji Maharaj Jayanti).
- One employee works at most one brand per day. Under brand semantics, one
  shift covers every process the employee is allocated to at that brand.
  An employee allocated to several brands is scheduled to the most-constrained
  slot first.
- Weekly offs are **preferences**, not hard blocks: required client coverage
  beats a preferred weekly off, but the override is flagged as a warning.
  Planned leaves and comp-offs are **hard** unavailability — the engine never
  schedules someone on leave.
- The sample dataset is deliberately seeded so December 2026 shows real
  behaviour: Aarav Mehta's leave 8–10 Dec is absorbed by recovery specialist
  e35, both BookBarn employees' leave on 21 Dec is absorbed by e36, and
  TechTrove's 3 Dec understaffing is covered by the expanded backup pool.
  Several weekly-off overrides still appear on single-resource brands so the
  warning path remains visible.
- Demo video and approach note are part of the submission; this repository
  covers the working application and the written approach below.

## Approach

### 1. How did you model employees, brands, processes, pods, and their relationships?

Employees, brands, pods and allocations are separate entities in
`src/data/seed.ts`. A brand owns a list of processes, each with its own
operating rule and minimum staffing. An allocation links one employee to one
brand + one process with a role (`primary` or `secondary`). An employee can
hold several allocations (multi-brand or backup cover), and a pod groups
employees under a pod lead. Holidays are a separate list, and availability
(weekly off, leaves, comp-offs) lives on the employee. The engine
(`src/lib/engine.ts`) takes this whole structure as input, so any change to
the data re-generates the roster from scratch — there is no stored roster to
go stale.

### 2. How does your system generate a roster and determine whether it satisfies the required constraints?

For each day, the engine lists the brand/process slots that operate that day
(under their rule), ranks brands most-constrained first (fewest available
people relative to demand), and picks a working set per brand: preferring
people who are not on their weekly off, then primaries over secondaries. One
employee works for at most one brand per day, but covers every process they
are allocated to at that brand — a single dedicated employee handling all of
a brand's processes does them all inside one working day, not as separate
shifts. After generation, an independent validation pass recomputes coverage
from the produced roster and checks for gaps, understaffing, double-booking
and leave clashes, so a bug in generation cannot hide a bad roster. A slot
counts as covered only when scheduled headcount meets the minimum staffing.
Primaries work their processes: an available primary for an operating process
is scheduled unless it is their weekly off and cover already exists;
secondaries are backup-only, picked to meet minimum staffing or cover absence.

### 3. How did you handle the difference between single-resource brands and brands with multiple employees?

Single-resource brands depend on one person, so their coverage is fragile by
design: the engine gives them secondary/backup allocations from shared
employees and pod floaters where possible (e.g. GlowKart's Customer Support
has a backup, its other processes do not). Multi-employee brands cross-cover:
BookBarn's two employees are each secondary on the other's process, and
WellnessWave's three split processes with cross-cover. The generator treats
both the same way — it just has more candidates for multi-employee brands —
so a single-resource brand naturally produces more warnings/gaps, which is
the honest signal that it needs backup hiring.

### 4. What happens when an employee manages all processes for a brand but is unavailable on a required working day?

If the employee is on leave or comp-off, they are hard-unavailable and the
slot is left uncovered: the engine records a coverage-gap (or understaffing)
error for every operating process that day, with a suggestion and a ranked
"Find backup" recovery list: free same-brand/same-pod people, then employees on
other brands whose move has been simulated against the whole day's coverage.
Candidates that would create another gap are shown with a rejection reason. If instead
it is only their preferred weekly off, mandatory coverage wins: they are
scheduled anyway and the shift is flagged as a weekly-off override warning,
so the manager sees the cost and can fix it by adding backup cover.

### 5. How does your system handle conflicting requirements or insufficient staffing?

It never resolves a conflict silently. Conflicts are classified: errors for
mandatory failures (no cover, understaffed, double-booked, scheduled on
leave) and warnings for preference overrides. Every conflict carries a plain
explanation and a suggested action, and the conflict list can suggest a
backup employee (same brand/process first, then same pod/same process). The
"Simulate a change" panel shows the exact new conflicts a proposed change
would create before the manager commits to it.

### 6. Which parts of the process did you automate, and which did you leave under human control? Why?

Automated: roster generation, constraint checking, conflict flagging, backup
suggestions and CSV export — these are mechanical and error-prone by hand.
Human-controlled: approving a roster, resolving a flagged gap (add cover,
move a leave, accept the gap), changing operating rules and minimum staffing,
and applying a simulated change. A gap is a business decision (e.g. accepting
uncovered Retention for a day vs paying overtime), so the system surfaces it
instead of deciding it.

### 7. If the company doubled its team and brand count, what would you change about your solution?

The engine is already O(days × slots × candidates) with no per-employee
quadratic work, so generation would still be fast; the changes would be
around data, not the algorithm. I would move the seed data into a real
database (Supabase/PostgreSQL, which Datastraw already uses) with an API,
add pagination/virtualisation to the grid (a 60-employee × 31-day table is
still fine, but 200+ needs it), add role-based access (pod leads edit only
their pod), and add an approval workflow so a generated roster is a draft
until a manager publishes it. I would also expand the existing automated
Python and TypeScript recovery tests into a property-based scheduling suite,
and add a proper optimisation pass (e.g. fair distribution of weekly-off
overrides) once the team is large enough for fairness to matter.

### 8. If you had one additional week to work on this, what would you improve first?

Fairness and recovery. Right now the generator fills the most-constrained
slots first, which is correct for coverage but can load the same backup
people repeatedly and override the same weekly offs. I would add a
load-balancing pass (spread overridden offs and backup shifts evenly), then
automatic roster regeneration suggestions: when a leave is approved after
publishing, propose the smallest set of reassignments that restores coverage
instead of just flagging the gap. After that, roster approval workflow and
CSV/Excel export of the coverage view.

## Project structure

```
engine/
  domain.py         Domain dataclasses, normalized schemas, and serialization
  model.py          Core CP-SAT mathematical formulation and solver (Google OR-Tools)
  validator.py      Independent hard-constraint verifier
  conflict_analyzer.py Diagnostic slack model and infeasibility root-cause analyzer
  reoptimizer.py    Dynamic re-optimization engine (minimizing assignment churn)
  recovery.py       Constraint-aware roster recovery / safe reassignment engine
  cli.py            CLI interface (solve, validate, reoptimize, recover)
  server.py         Lightweight HTTP API bridge server
tests/
  generate_fixture.py Generator and independent validator for datastraw_self_test_fixture.json
  test_scheduling.py Scheduling / CP-SAT pytest suite
  test_recovery.py   Recovery, authorization, simulation, validation and seed scenarios
  recovery_ts_smoke.ts TypeScript parity smoke tests for the same recovery rules
src/
  data/seed.ts      Types + seed data (employees, brands, pods, allocations, holidays)
  lib/engine.ts     Roster generation, validation, CP-SAT bridge, CSV export
  lib/recovery.ts   Recovery candidate discovery, simulation, ranking and validation
  AppShell.tsx      UI: sidebar, month picker, 6 views, recovery review, editing, CP-SAT badge
  App.tsx           Entry re-export for the application shell
  App.css           Plain CSS, dark sidebar + light content
```

## Constraint Programming (CP-SAT) Engine

The scheduling model is formulated as an exact Constraint Programming problem solved with Google OR-Tools CP-SAT:

- Decision Variables:
  - $x_{eqd} \in \{0, 1\}$: Employee $e$ assigned to process $q$ on day $d$.
  - $w_{ed} \in \{0, 1\}$: Employee working status indicator.
  - $o_{ed} \in \{0, 1\}$: Weekly-off allocation indicator.
  - $n_{ed} \in \{0, 1\}$: Available but unassigned indicator.
  - $u_{ed} \in \{0, 1\}$: Fixed unavailability indicator (approved leaves, comp-offs).
- Hard Constraints:
  - State partition: $w_{ed} + o_{ed} + n_{ed} = 1 - u_{ed}$
  - Assignment eligibility: $x_{eqd} \le P_{eq} + B_{eq}$
  - Operating calendar: $x_{eqd} \le G_{qd}$
  - Availability: $x_{eqd} \le 1 - u_{ed}$
  - Working consistency: $x_{eqd} \le w_{ed}$ and $w_{ed} \le \sum_q x_{eqd}$
  - Weekly-off exclusivity: $w_{ed} + o_{ed} \le 1$
  - Weekly-off entitlement: $L_{ew}^{min} \le \sum_{d \in D_w} o_{ed} \le L_{ew}^{max}$
  - Minimum coverage: $\sum_e x_{eqd} \ge M_{qd}$
  - Incompatible assignments: $x_{eqd} + x_{erd} \le 1$ for all explicitly incompatible pairs $(q, r)$
- Objectives:
  - Re-optimization: $\min \sum_{e,q,d} \Delta_{eqd}$ where $\Delta_{eqd} \ge |x_{eqd} - x^0_{eqd}|$
  - Primary resource preference over backup
  - Preferred weekly off satisfaction
  - Minimization of excess staffing
- Diagnostic Slack Model:
  When hard constraints are infeasible, the engine minimizes diagnostic shortage slack $\min \sum s_{qd}$ to isolate exact dates, processes, and shortages without presenting invalid rosters.

### TypeScript / Python reconciliation

The browser engine uses the business rule **one brand per employee per day,
covering every allocated process at that brand**. The legacy CP-SAT model was
process-granular (one brand/process per day). `SchedulingInput.assignment_semantics`
now makes this explicit: `"process"` preserves the existing CP-SAT test contract,
while `"brand"` applies the UI business rule.

Recovery uses the same eligibility, immutable simulation, independent
validation and lexicographical ranking rules in `src/lib/recovery.ts` and
`engine/recovery.py`. Both require explicit `CrossPodAuthorization` entries for
pod-boundary moves, validate directive source metadata against the baseline,
and compare new hard failures against the pre-existing baseline rather than
invalidating a repair for an unrelated old conflict. The Python validator
exposes hard failures as messages, so recovery maps its known
incompatible-duty and authorization messages to the same structured decision
codes used by TypeScript.

## Recovery engine architecture

### Authorization policy

- **Direct backup:** employee is free, available, and explicitly authorized for
  the destination brand + process.
- **Same-pod backup:** employee is free, belongs to the destination pod, and has
  the required process allocation. Pod membership alone never grants process
  permission.
- **Same-brand reassignment:** employee has destination authorisation and the
  move preserves source coverage.
- **Cross-brand reassignment:** employee has explicit destination brand +
  process authorization (or an explicit brand/process cross-pod grant).
  Generic process experience is not enough.
- **Cross-pod move:** an explicit `CrossPodAuthorization` is required even when
  the employee already has a permanent destination allocation.

### Simulation and validation

`simulateRecoveryDetailed()` / `_simulate_detailed()` clone the baseline roster,
reject malformed directives, duplicate baseline assignments, unavailable
employees, closed/missing destination processes and forged source metadata, and
record exactly which assignments are removed and added. Coverage is recomputed
for the destination, the source brand/processes and every other affected slot.

`validateRecoveryProposal()` / `RosterRecoveryEngine.validate()` do not trust
candidate flags, scores or reasons. They reconstruct the directive against the
baseline, re-check authorization and availability, verify the destination entry,
reject new source understaffing and new hard conflicts, allow unrelated
pre-existing conflicts, and prove that permanent allocations and unrelated
roster entries are unchanged.

### Ranking

Valid repairs are ordered lexicographically, never by weights:

1. fewer assignment changes,
2. lower actual source coverage loss,
3. fewer source processes left exactly at minimum staffing,
4. lower primary-resource disruption,
5. no weekly-off override,
6. lower additional staffing burden,
7. lower current workload,
8. stable employee-ID tie-break.

Each candidate exposes its `rankingKey` and a `rankingExplanation` so the UI can
show why it was selected and how alternatives compare.

## Commands

```bash
# Run complete test suite (Python scheduling/recovery + TypeScript recovery parity)
npm test

# Run just the Python recovery/scheduling suite
python -m pytest tests -q

# Run just the TypeScript recovery parity smoke tests
npm run test:ts

# Run CP-SAT solver via CLI
npm run engine:solve -- --input datastraw_self_test_fixture.json --output roster.json

# Validate existing roster against hard constraints
npm run engine:validate -- --input datastraw_self_test_fixture.json --roster roster.json

# Re-optimize schedule after operational disruption
npm run engine:reoptimize -- --input datastraw_self_test_fixture.json --roster roster.json --emp E01 --date 2026-11-25

# Find and rank safe repairs for one uncovered process
python -m engine.cli recover --input src/data/seed_data.json --roster roster.json --date 2026-12-03 --brand b04 --process CS

# Start local CP-SAT API bridge server
npm run engine:server
```

## Submission checklist (from the brief)

- [ ] Working application URL (deploy this repo)
- [ ] GitHub repository (source + README + `.env.example`)
- [ ] Demo video (3–5 min: generation, brand schedules, conflict detection, handling a change)
- [ ] Approach note (this README's Approach section)
- [ ] LinkedIn profile link
- [ ] Email to ozair.shaikh@datastraw.in and aryan.jaiswal@datastraw.in, CC talent@datastraw.in,
      subject: `Smart Roster Management System Assignment - [Your Full Name]`
