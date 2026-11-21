# Smart Roster Management System — Datastraw Hiring Assignment

**Live app:** https://datastraw-roster.vercel.app
**Repository:** https://github.com/Sus69/datastraw-roster
**LinkedIn:** https://www.linkedin.com/in/mr-maple
**Demo video (3–5 min):** link to be added here once recorded — it will show roster generation, different brand schedules, conflict detection, and handling a change.

I built this for Datastraw's hiring assignment: a browser app that plans,
generates, validates and manages monthly rosters for an operations company
running support and operational processes for multiple D2C brands. The point
of it is the scheduling problem underneath, not the calendar on top — if a
roster can't cover a brand, the app says so instead of quietly printing a
broken one.

**December 2026 (the default month, checked on the live app): 36 staff,
12 brands, 875 of 875 shifts covered, 0 coverage gaps, 0 understaffed days,
15 weekly-off overrides.** Those overrides are warnings, not errors. When a
client needs coverage on someone's preferred weekly off, coverage wins — but
the app flags the shift so a manager can see the cost.

One clarification on that 875: it counts operating brand/process coverage
slots, one per brand, process and day — the app's unit of coverage, shown as
`x/y` on every process row and date. The same month holds 585 employee working
days, because one employee shift covers every process that person is allocated
to at that brand. 875 and 585 are different things, not a contradiction.

It's React 19 + TypeScript + Vite. The app has no backend and needs no
network: the seed data ships with it and edits save in the browser
(localStorage). There is an optional Python/CP-SAT bridge you can run on
localhost for solver comparison and server-side validation, but the app works
without it. One thing to be straight about: the deployed Vercel build is a
static site with no `api/` backend, so the live app runs the deterministic
greedy engine in `src/lib/engine.ts` plus its own independent validation pass.
The app still *tries* `POST /api/schedule` once per generation; with no bridge
deployed that request fails, the fallback to the local engine is silent apart
from a console warning, and nothing in the UI reports a CP-SAT status. The
CP-SAT bridge is local-only (more in "Constraint Programming (CP-SAT) Engine"
below).

## Setup

```bash
npm install
npm run dev      # start the dev server (http://localhost:5173)
npm run build    # type-check + production build
npm run preview  # serve the production build locally
```

No environment variables are needed to run the app. `.env.example` says so
plainly — all the data is local seed data in `src/data/seed.ts` and there is
no backend. The only optional local service is the CP-SAT bridge
(`npm run engine:server`, port 8000; see Commands below).

## What it does

- **Data model:** 36 employees, 12 made-up D2C brands, 4 processes
  (Customer Support, Abandoned Cart Conversions, Retention, Non-Delivery
  Report), 4 operational pods, each with a pod lead. Allocations link an
  employee to a brand + process as `primary` or `secondary` — 72 in total,
  30 primary and 42 secondary/backup. **9 of the 12 brands (75%) have a
  single dedicated primary employee doing all of that brand's processes**
  (GlowKart, FitFuel, UrbanNest, TechTrove, PetPals, StyleSutra, SnackBox,
  BabyBliss, GreenLeaf), which is close to the brief's ~80% single-resource
  pattern. AutoAce and BookBarn have 2 primary employees each, WellnessWave
  has 3. Everyone else is shared across brands or works as a pod floater
  (backup cover). Two extra recovery specialists (e35 Isha Rao, e36 Naveen
  Kumar) shore up GlowKart, BookBarn and TechTrove; e36's TechTrove cover is
  backed by an explicit cross-pod authorization.
- **Working rules, per brand/process:** 365-day ops, daily except public
  holidays, or Sundays + public holidays off. Two processes in the same brand
  can run on different rules, and minimum staffing is set per brand/process.
- **Roster generation:** pick a month (December 2026 by default). The engine
  works through operating calendars, availability, weekly offs, planned
  leaves, comp-offs and minimum staffing, filling the most-constrained slots
  first.
- **Conflict detection & validation:** coverage gaps, understaffing,
  weekly-off overrides, double-booking and leave clashes. Each one comes with
  a plain explanation and a suggested fix. Missing coverage or someone
  scheduled on leave is an error; a weekly-off override is a warning.
- **Views:** a company-wide monthly grid (map and detail grid), plus pod-wise,
  brand-wise (coverage per day, with editable rules and minimum staffing),
  process-wise and employee-wise views (working days, hours, capacity
  utilisation and weekly-off overrides). Offs, holidays and leaves are shown
  on the company grid and in the day inspector.
- **Editing:** change weekly offs, add a leave (mark any day unavailable),
  change a brand/process operating rule or minimum staffing — the whole month
  re-generates and re-validates straight away. Edits save in localStorage;
  "Reset to seed data" puts the original dataset back.
- **Simulate a change:** mark any employee unavailable on any day, see the
  capacity delta and the new conflicts it would create, then apply it or
  discard it. The default example is Aarav Mehta on 14 Dec 2026 — a day he is
  actually scheduled (GlowKart, all three processes), so the preview shows a
  real trade-off rather than an empty one.
- **Roster recovery:** "Find backup" isn't a guess — it's a constraint-aware
  recovery engine. It looks for unassigned same-brand and same-pod people
  plus employees on other brands who can safely move, simulates the whole
  day's coverage, throws out any move that would open another gap,
  independently validates the repair, ranks the valid ones
  lexicographically, and keeps every repair tied to one date. Permanent
  allocations and unrelated roster entries are never silently changed.
- **Extras:** CSV export of the roster, search/filter, and a `Find backup`
  action on every coverage conflict (gaps and understaffing).
- **Recovery Lab:** a visualizer built on the same recovery engine. Mark
  someone unavailable or pick an existing shortage, then run the real
  candidate check, simulation, ranking and validation. The Lab shows the
  assignment board before and after, a ten-stage execution pipeline, the
  actual rejection reasons, coverage impact and animated assignment movement —
  all without touching permanent allocations. Applying a repair is a separate,
  explicit step: the Lab revalidates the directive first, then commits the
  date-specific instruction (and, for an absence scenario, the scenario leave)
  through the normal override path.

- **Fairness:** the generator keeps a running tally of how much each person
  has already worked this month, and when two candidates tie it picks the
  least-loaded one (and the one with fewer overridden weekly offs). That way
  the same backup people don't get pulled into every gap. Recovery ranking
  does the same thing — lower current workload is rank key 7.

## How this meets the brief (§3)

| Brief requirement | Where it lives in this repo |
| --- | --- |
| A. Team / brand / process management (§3A) | `src/data/seed.ts` — 36 employees, 12 brands, 4 pods with leads, 72 allocations; edit weekly offs, add leaves, edit operating rules and minimum staffing in the UI (no code change); new brands/employees are added in `seed.ts` — see Q7 |
| B. Client-specific working rules (§3B) | Three operating rules per brand/process: `ALL_YEAR` (365-day), `EXCEPT_HOLIDAYS`, `NO_SUN_HOLIDAYS`; minimum staffing per brand/process; brand calendar is separate from each employee's schedule |
| C. Monthly roster generation (§3C) | Month picker (default December 2026) in `src/AppShell.tsx`, generation in `src/lib/engine.ts`; most-constrained slots first; shows who works, who is off, and per-day coverage |
| D. Conflict detection & validation (§3D) | `validateRoster` independent pass + Conflicts view: gaps, understaffing, double-booking, leave clashes (errors) vs weekly-off overrides (warnings); mandatory coverage beats a preferred weekly off |
| E. Roster views & editing (§3E) | Company, pod, brand, process and employee views; edits re-generate and re-validate the whole month immediately |
| F. Handling changes (§3F) | "Simulate a change" on Overview (e.g. Aarav Mehta unavailable 14 Dec) + constraint-aware recovery engine (`src/lib/recovery.ts`, `engine/recovery.py`) and Recovery Lab; repairs are date-specific and never edit permanent allocations |

## Assumptions

- Every brand and employee name is made up. The public holidays are real
  India holidays for Nov 2026 – Feb 2027 (Guru Nanak Jayanti, Christmas,
  New Year's Day, Makar Sankranti, Republic Day, Shivaji Maharaj Jayanti).
- One employee works at most one brand per day. One shift covers every
  process that employee is allocated to at that brand. Someone allocated to
  several brands gets scheduled to the most-constrained slot first.
- Weekly offs are **preferences**, not hard blocks: if a client needs coverage
  that day, coverage wins, but the override shows up as a warning. Planned
  leaves and comp-offs are **hard** unavailability — the engine never
  schedules someone on leave.
- I seeded the December 2026 data so it actually shows something: Aarav
  Mehta is on leave 8–10 Dec and three people cover GlowKart — Vikram Singh
  on Customer Support, Ananya Gupta on Abandoned Cart, and recovery
  specialist e35 Isha Rao on Retention plus Customer Support. Both BookBarn
  employees are on leave 21 Dec and e36 Naveen Kumar covers its CS and RET
  in one working day. On 3 Dec Neha Joshi (TechTrove's primary) is on planned
  leave, so Customer Support's minimum of 2 is met by Farhan Khan and Naveen
  Kumar, with Pooja Desai on Abandoned Cart and Ishita Bose on Non-Delivery
  Report. Weekly-off overrides still show up — on single-resource brands and
  on AutoAce, whose CS minimum of 2 is more than its one CS primary can
  cover — so the warning path stays visible.
- The other months in the picker (Nov 2026, Jan 2027, Feb 2027) share the same
  brands, allocations, weekly offs and holidays, but no leaves or comp-offs are
  seeded outside December. Those months therefore generate clean rosters with
  no gaps and only weekly-off overrides (15, 15 and 12 respectively), which is
  exactly what the app shows when you switch the month.
- The approach note is the Approach section below (§8 of the brief). The demo
  video link at the top of this README goes in once the video is recorded.

## Approach

### 1. How did you model employees, brands, processes, pods, and their relationships?

Employees, brands, pods and allocations are separate things in
`src/data/seed.ts` — I didn't want them tangled together in one big table.
A brand owns its list of processes, and each process carries its own
operating rule and minimum staffing. An allocation is just a link: one
employee → one brand + one process, marked `primary` or `secondary`. One
employee can hold several allocations, which is how multi-brand work and
backup cover are represented. A pod is a group of employees under a pod lead.
Holidays live in their own list, and availability (weekly off, leaves,
comp-offs) lives on the employee. The engine (`src/lib/engine.ts`) takes the
whole structure as input and builds the roster from scratch every time, so
there's no stored roster sitting around going stale when the data changes.

### 2. How does your system generate a roster and determine whether it satisfies the required constraints?

Day by day, the engine lists the brand/process slots that actually operate
that day (under their rule), then works through the brands most-constrained
first — fewest available people relative to demand. For each brand it picks a
working set, preferring people who aren't on their weekly off, then primaries
over secondaries. One employee works for at most one brand a day, but they
cover every process they're allocated to at that brand: a single dedicated
employee doing all of a brand's processes does them inside one working day,
not as separate shifts.

Then a separate validation pass checks the result. It recomputes coverage from
the roster the engine produced and looks for gaps, understaffing,
double-booking and leave clashes, so a bug in generation can't quietly hide a
bad roster. A slot only counts as covered when scheduled headcount meets the
minimum staffing. In practice: an available primary for an operating process
gets scheduled unless it's their weekly off and cover already exists;
secondaries are backup-only, pulled in to meet minimum staffing or cover an
absence.

### 3. How did you handle the difference between single-resource brands and brands with multiple employees?

A single-resource brand lives or dies by one person, so its coverage is
fragile by design. Each of the nine has at least one secondary allocation on
every one of its processes, drawn from shared employees and pod floaters — but
a name on an allocation is not the same as guaranteed cover, because those
backups have their own brands and their own weekly offs. GlowKart is the
clearest case: Ananya Gupta backs up Abandoned Cart and is also off on Sundays,
so GlowKart's Sunday ACC shift is what puts Aarav Mehta on a weekly-off
override four times in December. Multi-employee brands cross-cover: AutoAce's
two primaries split its processes, BookBarn's two employees are each secondary
on the other's process, and WellnessWave's three split processes with
cross-cover. The generator doesn't treat the two cases
differently — it just has more candidates to pick from on multi-employee
brands. So a single-resource brand naturally throws up more warnings and gaps,
which is the honest signal: it needs backup hiring.

### 4. What happens when an employee manages all processes for a brand but is unavailable on a required working day?

If they're on leave or comp-off, they're hard-unavailable — the engine will
not schedule them, full stop. The generator tries the brand's
secondary/backup allocations first; if nobody can cover it, the slot stays
uncovered and the engine logs a coverage-gap (or understaffing) error for
every operating process that day, along with a suggestion and a ranked
"Find backup" list: free same-brand/same-pod people first, then employees on
other brands whose move has been simulated against the whole day's coverage.
Anyone whose move would open another gap shows up with the reason why.
If it's only their preferred weekly off, it's the other way round: mandatory
coverage wins, they get scheduled anyway, and the shift is flagged as a
weekly-off override warning so the manager sees the cost and can fix it by
adding backup cover.

### 5. How does your system handle conflicting requirements or insufficient staffing?

It never papers over a conflict. Conflicts are split into two kinds: errors
for mandatory failures (no cover, understaffed, double-booked, scheduled on
leave) and warnings for preference overrides. Every conflict gets a plain
explanation and a suggested action, and the conflict list can suggest a backup
(same brand/process first, then same pod/same process). The "Simulate a
change" panel shows the exact new conflicts a proposed change would create
before the manager commits to it.

### 6. Which parts of the process did you automate, and which did you leave under human control? Why?

Automated: roster generation, constraint checking, conflict flagging, backup
suggestions and CSV export. Those are mechanical and easy to get wrong by
hand, so a computer should do them. Human-controlled: approving a roster,
resolving a flagged gap (add cover, move a leave, accept the gap), changing
operating rules and minimum staffing, and applying a simulated change. A gap
is a business decision — accepting uncovered Retention for a day versus paying
overtime, for example — so the system surfaces it instead of deciding it.

### 7. If the company doubled its team and brand count, what would you change about your solution?

The engine itself would hold up — it's O(days × slots × candidates) with no
per-employee quadratic work, so generating would still be fast. What would
have to change is everything around the data. I'd move the seed data into a
real database (Supabase/PostgreSQL, which Datastraw already uses) with an API
and an admin screen, so an operations manager can add brands, processes and
employees without touching code. I'd add pagination/virtualisation to the grid
(a 60-person × 31-day table is still fine, but 200+ isn't), role-based access
(pod leads edit only their own pod), and an approval workflow so a generated
roster stays a draft until a manager publishes it. Fairness is already handled
by the workload tally in the generator and a workload key in recovery ranking
(see Q8), so at double the size I'd keep that and put the effort into growing
the existing automated Python and TypeScript recovery tests into a
property-based scheduling suite, rather than building a new optimiser first.

### 8. If you had one additional week to work on this, what would you improve first?

Fairness and recovery were the first improvement, and they're done now: the
generator keeps a running tally of who has worked how much (least-loaded
eligible person wins ties, overridden weekly offs get spread around instead
of stacking on the same people), recovery ranks repairs with current workload
as a key, and the Recovery Lab shows the whole repair happening. With one
more week I'd build the roster approval workflow first — draft → pod-lead
review → published, per §6 of the brief — because right now a generated roster
has no publish state, so anyone opening the app just sees the working draft.
Second, an admin screen to add brands, processes and employees without
editing `seed.ts` (the one §3A thing that still needs a code change). Third,
automatic regeneration suggestions: when a leave gets approved after
publishing, propose the smallest set of reassignments that fixes coverage
instead of just flagging the gap. After that, Excel export of the coverage
view.

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
  AppShell.tsx      UI: sidebar, month picker, 7 views, recovery review, editing
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
while `"brand"` applies the UI business rule. The CLI exposes it as
`--semantics brand`; omit the flag and you get the legacy `process` contract the
test suite is written against.

The distinction is not cosmetic. Run against the December seed data, the legacy
`process` semantics cannot cover the month — one employee may then hold only one
brand/process per day — so it reports shortages. With `--semantics brand` the
same model solves to `OPTIMAL` with 875 of 875 coverage slots covered, 0 gaps,
0 understaffed slots and the same 15 weekly-off overrides the browser engine
produces. What the two engines do not share is the exact assignment: the greedy
roster is deterministic, while CP-SAT runs four search workers and can return a
different (equally `OPTIMAL`) assignment from run to run — sometimes leaving a
floater unassigned, which is why its totals move between 35 and 36 people
working, while the browser engine's December roster uses all 36.

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

# Run CP-SAT solver via CLI on the bundled self-test fixture
npm run engine:solve -- --input datastraw_self_test_fixture.json --output roster.json

# Validate that roster against hard constraints
npm run engine:validate -- --input datastraw_self_test_fixture.json --roster roster.json

# Solve the app's own December seed data with the browser business rule, then
# validate the roster the solver produced
npm run engine:solve -- --input src/data/seed_data.json --semantics brand --output seed-roster.json
npm run engine:validate -- --input src/data/seed_data.json --roster seed-roster.json --semantics brand

# Rank safe repairs for one brand/process slot in that seed roster
python -m engine.cli recover --input src/data/seed_data.json --roster seed-roster.json --date 2026-12-03 --brand b04 --process CS --semantics brand

# Re-optimize schedule after operational disruption
npm run engine:reoptimize -- --input datastraw_self_test_fixture.json --roster roster.json --emp E01 --date 2026-11-25

# Start local CP-SAT API bridge server
npm run engine:server
```

Omit `--semantics brand` and every command keeps the legacy `process`
granularity that the pytest suite is written against — that is why the flag is
explicit rather than a changed default.

## Submission checklist (from the brief, §7)

- [x] Working application URL — https://datastraw-roster.vercel.app
- [x] GitHub repository (source + README + `.env.example`) — https://github.com/Sus69/datastraw-roster
- [ ] Demo video (3–5 min: generation, brand schedules, conflict detection, handling a change) — recording pending; link will be added at the top of this README
- [x] Approach note — the Approach section above (§8 of the brief)
- [x] LinkedIn profile link — https://www.linkedin.com/in/mr-maple
- [ ] Email to ozair.shaikh@datastraw.in and aryan.jaiswal@datastraw.in, CC talent@datastraw.in,
      subject: `Smart Roster Management System Assignment - Manaal Maple` — to be sent once the video link is ready
