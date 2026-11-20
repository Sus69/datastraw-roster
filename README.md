# Smart Roster Management System — Datastraw Hiring Assignment

**Live app:** https://datastraw-roster.vercel.app
**Repository:** https://github.com/Sus69/datastraw-roster
**LinkedIn:** https://www.linkedin.com/in/mr-maple
**Demo video (3–5 min):** link to be added here once recorded — it will show roster generation, different brand schedules, conflict detection, and handling a change.

A browser-based roster management tool for an operations company that runs
support and operational processes for multiple D2C brands. It plans, generates,
validates and manages monthly rosters across brands, processes and pods, and
flags coverage conflicts instead of silently producing an invalid roster.

**December 2026 (default month, verified on the live app): 36 staff, 12 brands,
875 of 875 shifts covered, 0 coverage gaps, 0 understaffed days, 15 weekly-off
overrides.** The overrides are warnings, not errors — required client coverage
takes precedence over a preferred weekly off, and each override is flagged.

Built with React 19 + TypeScript + Vite. The browser app has no external
backend or network dependency: all seed data ships locally and edits persist in
the browser (localStorage). An optional Python/CP-SAT HTTP bridge can be started
on localhost for solver comparison and server-side validation; it is not
required to run the app. **Note:** the deployed Vercel build is a static site
with no `api/` backend, so the live app runs the deterministic greedy engine in
`src/lib/engine.ts` plus its independent validation pass; the CP-SAT bridge is
local-only (see "Constraint Programming (CP-SAT) Engine" below).

## Setup

```bash
npm install
npm run dev      # start the dev server (http://localhost:5173)
npm run build    # type-check + production build
npm run preview  # serve the production build locally
```

No environment variables are required to run the app — `.env.example`
documents that (all data is local seed data in `src/data/seed.ts`; there is no
backend). The CP-SAT bridge is the only optional local service
(`npm run engine:server`, port 8000; see Commands below).

## What it does

- **Data model:** 36 employees, 12 fictional D2C brands, 4 processes
  (Customer Support, Abandoned Cart Conversions, Retention, Non-Delivery
  Report), 4 operational pods each with a pod lead, and resource allocations
  (employee → brand + process, primary or secondary) — 72 allocations in
  total: 30 primary, 42 secondary/backup. **9 of 12 brands (75%) have one
  dedicated primary employee handling all of that brand's processes**
  (GlowKart, FitFuel, UrbanNest, TechTrove, PetPals, StyleSutra, SnackBox,
  BabyBliss, GreenLeaf), matching the brief's ~80% single-resource pattern;
  AutoAce and BookBarn have 2 primary employees each and WellnessWave has 3.
  The remaining employees are shared across brands or act as pod floaters
  (backup cover). Two additional recovery specialists (e35 Isha Rao, e36
  Naveen Kumar) strengthen GlowKart, BookBarn and TechTrove cover;
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
- **Recovery Lab:** a dedicated visualizer built on the same recovery engine.
  Mark an employee unavailable or pick an existing shortage, then run the real
  candidate evaluation, simulation, lexicographical ranking and independent
  validation. The Lab shows the assignment board before/after, a ten-stage
  execution pipeline, actual rejection reasons, coverage impact and animated assignment
  movement without mutating permanent allocations. Applying a repair is a
  separate, explicit confirmation: the Lab revalidates the directive first and
  then commits the date-specific instruction (and, for an absence scenario, the
  scenario leave) through the normal override path.

- **Fairness:** the generator keeps a month-to-date workload ledger and
  prefers the least-loaded eligible person (and fewest weekly-off overrides)
  when candidates tie, so the same backup people are not pulled into every
  gap. Recovery ranking also prefers lower current workload (rank key 7).

## How this meets the brief (§3)

| Brief requirement | Where it lives in this repo |
| --- | --- |
| A. Team / brand / process management (§3A) | `src/data/seed.ts` — 36 employees, 12 brands, 4 pods with leads, 72 allocations; edit weekly offs, leaves, operating rules and minimum staffing in the UI (no code change); new brands/employees are added in `seed.ts` — see Q7 |
| B. Client-specific working rules (§3B) | Three operating rules per brand/process: `ALL_YEAR` (365-day), `EXCEPT_HOLIDAYS`, `NO_SUN_HOLIDAYS`; minimum staffing per brand/process; brand calendar is separate from each employee's schedule |
| C. Monthly roster generation (§3C) | Month picker (default December 2026) in `src/lib/engine.ts`; most-constrained slots first; shows who works, who is off, and per-day coverage |
| D. Conflict detection & validation (§3D) | `validateRoster` independent pass + Conflicts view: gaps, understaffing, double-booking, leave clashes (errors) vs weekly-off overrides (warnings); mandatory coverage beats a preferred weekly off |
| E. Roster views & editing (§3E) | Company, pod, brand, process and employee views; edits re-generate and re-validate the whole month immediately |
| F. Handling changes (§3F) | "Simulate a change" on Overview (e.g. Aarav Mehta unavailable 14 Dec) + constraint-aware recovery engine (`src/lib/recovery.ts`, `engine/recovery.py`) and Recovery Lab; repairs are date-specific and never edit permanent allocations |

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
  behaviour: Aarav Mehta's leave 8–10 Dec is covered by the backup pool
  (incl. recovery specialist e35 Isha Rao), both BookBarn employees' leave
  on 21 Dec is covered by e36 Naveen Kumar, and TechTrove on 3 Dec is covered
  (Farhan Khan working while Neha Joshi is on planned leave).
  Several weekly-off overrides still appear on single-resource brands so the
  warning path remains visible.
- The approach note is the Approach section below (§8 of the brief); the demo
  video link at the top of this README is added once the video is recorded.

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
AutoAce's two primaries split its processes, BookBarn's two employees are each
secondary on the other's process, and WellnessWave's three split processes with
cross-cover. The generator treats both the same way — it just has more
candidates for multi-employee brands — so a single-resource brand naturally
produces more warnings/gaps, which is the honest signal that it needs backup
hiring.

### 4. What happens when an employee manages all processes for a brand but is unavailable on a required working day?

If the employee is on leave or comp-off, they are hard-unavailable. The
generator first tries the brand's secondary/backup allocations; if no backup
can cover it, the slot is left uncovered and the engine records a
coverage-gap (or understaffing) error for every operating process that day,
with a suggestion and a ranked "Find backup" recovery list: free
same-brand/same-pod people, then employees on other brands whose move has
been simulated against the whole day's coverage.
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
database (Supabase/PostgreSQL, which Datastraw already uses) with an API and
an admin UI so an operations manager can add brands, processes and employees
without editing code, add pagination/virtualisation to the grid (a
60-employee × 31-day table is still fine, but 200+ needs it), add
role-based access (pod leads edit only their pod), and add an approval
workflow so a generated roster is a draft until a manager publishes it.
Fairness is already handled by a workload ledger in the generator and a
workload key in recovery ranking (see Q8), so at double scale I would keep
that mechanism and extend the existing automated Python and TypeScript
recovery tests into a property-based scheduling suite rather than inventing a
new optimiser first.

### 8. If you had one additional week to work on this, what would you improve first?

Fairness and recovery were the first improvement, and they are now built:
the generator keeps a month-to-date fairness ledger (least-loaded eligible
person wins ties; overridden weekly offs are spread, not stacked on the same
people), recovery ranks repairs lexicographically with current workload as a
key, and the Recovery Lab visualises the whole repair. With one more week I
would build the roster approval workflow first (draft → pod-lead review →
published, per §6 of the brief), because right now a generated roster has no
publish state — anyone viewing the app sees the working draft. Second, an
admin UI to add brands, processes and employees without editing `seed.ts`
(the one §3A capability that still needs a code change). Third, automatic
roster-regeneration suggestions: when a leave is approved after publishing,
propose the smallest set of reassignments that restores coverage instead of
just flagging the gap. After that, Excel export of the coverage view.

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
  parity_scenarios.json Shared Python/TypeScript ranking and brand-semantics contract
src/
  data/seed.ts      Types + seed data (employees, brands, pods, allocations, holidays)
  lib/engine.ts     Roster generation, validation, CP-SAT bridge, CSV export
  lib/recovery.ts   Recovery candidate discovery, simulation, ranking and validation
  lib/recoveryLab.ts Recovery Lab scenario/trace integration over the same engine
  components/recovery/ Recovery Lab roster board, execution timeline and impact views
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
invalidating a repair for an unrelated old conflict. Both validators expose
structured hard-failure records (`code`, `date`, `brand_id`, `process_id`,
`employee_id`, related identity fields) and recovery compares those identities,
never human-readable message strings. Python keeps the legacy message list for
callers that only render text, while also returning `hard_failure_records` and
`new_conflict_records` for conflict comparison.

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

### Temporary backup versus temporary reassignment

- **Temporary backup** adds one date-specific assignment for a currently free
  employee. It must not claim source metadata and removes nothing.
- **Temporary reassignment** replaces the employee's existing date-specific
  assignment. The directive must match the baseline source brand and process
  set exactly, and the move is rejected if it would leave the source
  understaffed or create another hard conflict.

Both are temporary instructions layered over the permanent allocation model;
neither edits `data.allocations`.

### Simulation and validation

`simulateRecoveryDetailed()` / `_simulate_detailed()` clone the baseline roster,
reject malformed directives, duplicate baseline assignments, unavailable
employees, closed/missing destination processes and forged source metadata, and
record exactly which assignments are removed and added. All preconditions,
including destination construction, run before any simulated removal is
planned. A failed simulation returns the untouched baseline with empty
`removed` and `added` lists. Coverage is recomputed for the destination, the
source brand/processes and every other affected slot.

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
show why it was selected and how alternatives compare. Python and TypeScript
use the same key order; both suites read `tests/parity_scenarios.json` and
assert the same proposal order and ranking keys, and the TypeScript smoke suite
also asserts the independent validator accepts every ranked proposal.

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

## Submission checklist (from the brief, §7)

- [x] Working application URL — https://datastraw-roster.vercel.app
- [x] GitHub repository (source + README + `.env.example`) — https://github.com/Sus69/datastraw-roster
- [ ] Demo video (3–5 min: generation, brand schedules, conflict detection, handling a change) — recording pending; link will be added at the top of this README
- [x] Approach note — the Approach section above (§8 of the brief)
- [x] LinkedIn profile link — https://www.linkedin.com/in/mr-maple
- [ ] Email to ozair.shaikh@datastraw.in and aryan.jaiswal@datastraw.in, CC talent@datastraw.in,
      subject: `Smart Roster Management System Assignment - Manaal Maple` — to be sent once the video link is ready
