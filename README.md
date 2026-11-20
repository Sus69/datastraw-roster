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

It's React 19 + TypeScript + Vite. The app has no backend and needs no
network: the seed data ships with it and edits save in the browser
(localStorage). The whole scheduling engine is TypeScript in
`src/lib/engine.ts` — a deterministic greedy generator plus its own
independent validation pass — and the recovery engine is TypeScript too
(`src/lib/recovery.ts`). There used to be a Python/CP-SAT engine alongside
it; I removed it, so this repo is TypeScript-only now.

## Setup

```bash
npm install
npm run dev      # start the dev server (http://localhost:5173)
npm run build    # type-check + production build
npm run preview  # serve the production build locally
```

No environment variables are needed to run the app. `.env.example` says so
plainly — all the data is local seed data in `src/data/seed.ts` and there is
no backend.

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
- **Views:** a company-wide monthly grid, plus pod-wise, brand-wise (coverage
  per day), process-wise and employee-wise views (working days, offs,
  holidays, leaves).
- **Editing:** change weekly offs, add or remove leaves, change a
  brand/process operating rule or minimum staffing — the whole month
  re-generates and re-validates straight away. Edits save in localStorage;
  "Reset to seed data" puts the original dataset back.
- **Simulate a change:** mark any employee unavailable on any day, see the new
  conflicts it would create and the suggested backup, then apply it or throw
  it away.
- **Roster recovery:** "Find backup" isn't a guess — it's a constraint-aware
  recovery engine. It looks for unassigned same-brand and same-pod people
  plus employees on other brands who can safely move, simulates the whole
  day's coverage, throws out any move that would open another gap,
  independently validates the repair, ranks the valid ones
  lexicographically, and keeps every repair tied to one date. Permanent
  allocations and unrelated roster entries are never silently changed.
- **Extras:** CSV export of the roster, search/filter, and a backup
  suggestion on every conflict.
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
| A. Team / brand / process management (§3A) | `src/data/seed.ts` — 36 employees, 12 brands, 4 pods with leads, 72 allocations; edit weekly offs, leaves, operating rules and minimum staffing in the UI (no code change); new brands/employees are added in `seed.ts` — see Q7 |
| B. Client-specific working rules (§3B) | Three operating rules per brand/process: `ALL_YEAR` (365-day), `EXCEPT_HOLIDAYS`, `NO_SUN_HOLIDAYS`; minimum staffing per brand/process; brand calendar is separate from each employee's schedule |
| C. Monthly roster generation (§3C) | Month picker (default December 2026) in `src/lib/engine.ts`; most-constrained slots first; shows who works, who is off, and per-day coverage |
| D. Conflict detection & validation (§3D) | `validateRoster` independent pass + Conflicts view: gaps, understaffing, double-booking, leave clashes (errors) vs weekly-off overrides (warnings); mandatory coverage beats a preferred weekly off |
| E. Roster views & editing (§3E) | Company, pod, brand, process and employee views; edits re-generate and re-validate the whole month immediately |
| F. Handling changes (§3F) | "Simulate a change" on Overview (e.g. Aarav Mehta unavailable 14 Dec) + constraint-aware recovery engine (`src/lib/recovery.ts`) and Recovery Lab; repairs are date-specific and never edit permanent allocations |

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
  Mehta is on leave 8–10 Dec and the backup pool covers GlowKart (including
  recovery specialist e35 Isha Rao); both BookBarn employees are on leave
  21 Dec and e36 Naveen Kumar covers; TechTrove on 3 Dec is covered too
  (Farhan Khan working while Neha Joshi is on planned leave). A few
  weekly-off overrides still show up on single-resource brands, so the
  warning path stays visible.
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
fragile by design. Where I could, I gave those brands secondary/backup
allocations from shared employees and pod floaters — GlowKart's Customer
Support has a backup, its other processes don't. Multi-employee brands
cross-cover: AutoAce's two primaries split its processes, BookBarn's two
employees are each secondary on the other's process, and WellnessWave's three
split processes with cross-cover. The generator doesn't treat the two cases
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
the existing automated TypeScript recovery tests into a
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
tests/
  recovery_ts_smoke.ts TypeScript smoke tests for the recovery engine
  parity_scenarios.json Ranking scenarios asserted by the smoke tests
src/
  data/seed.ts      Types + seed data (employees, brands, pods, allocations, holidays)
  lib/engine.ts     Roster generation, validation, CSV export
  lib/recovery.ts   Recovery candidate discovery, simulation, ranking and validation
  lib/recoveryLab.ts Recovery Lab scenario/trace integration over the same engine
  components/recovery/ Recovery Lab roster board, execution timeline and impact views
  AppShell.tsx      UI: sidebar, month picker, 6 views, recovery review, editing
  App.tsx           Entry re-export for the application shell
  App.css           Plain CSS, dark sidebar + light content
```

## Scheduling engine (TypeScript only)

The whole engine is TypeScript in `src/lib/engine.ts`. There used to be a
Python/CP-SAT engine next to it (exact constraint programming with Google
OR-Tools); I removed it, so the greedy engine is the engine now. That was a
deliberate trade-off, and I want to be straight about it: the greedy generator
is deterministic and fast, and the independent validation pass checks its
output, but it doesn't prove optimality the way a solver does. For a 36-person
roster it covers everything the brief asks for; at a much bigger scale, a
solver would be the first thing I'd bring back (see Q7).

One rule runs through the whole engine: **one brand per employee per day,
covering every allocated process at that brand**. That is the business rule
the UI follows, and the validator checks rosters against it.

Recovery (`src/lib/recovery.ts`) uses the same eligibility, immutable
simulation, independent validation and lexicographical ranking rules
throughout. It requires explicit `CrossPodAuthorization` entries for
pod-boundary moves, validates directive source metadata against the baseline,
and compares new hard failures against the pre-existing baseline rather than
invalidating a repair for an unrelated old conflict. The validator exposes
structured hard-failure records (`code`, `date`, `brand_id`, `process_id`,
`employee_id`, related identity fields) and recovery compares those
identities, never human-readable message strings.

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

`simulateRecoveryDetailed()` clones the baseline roster, rejects malformed
directives, duplicate baseline assignments, unavailable employees,
closed/missing destination processes and forged source metadata, and records
exactly which assignments are removed and added. All preconditions, including
destination construction, run before any simulated removal is planned. A
failed simulation returns the untouched baseline with empty `removed` and
`added` lists. Coverage is recomputed for the destination, the source
brand/processes and every other affected slot.

`validateRecoveryProposal()` does not trust candidate flags, scores or
reasons. It reconstructs the directive against the baseline, re-checks
authorization and availability, verifies the destination entry, rejects new
source understaffing and new hard conflicts, allows unrelated pre-existing
conflicts, and proves that permanent allocations and unrelated roster entries
are unchanged.

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
show why it was selected and how alternatives compare. The smoke tests read
`tests/parity_scenarios.json` and assert the same proposal order and ranking
keys, and also assert the independent validator accepts every ranked proposal.

## Commands

```bash
# Run the test suite (TypeScript recovery smoke tests)
npm test

# Run just the TypeScript recovery smoke tests
npm run test:ts
```

## Submission checklist (from the brief, §7)

- [x] Working application URL — https://datastraw-roster.vercel.app
- [x] GitHub repository (source + README + `.env.example`) — https://github.com/Sus69/datastraw-roster
- [ ] Demo video (3–5 min: generation, brand schedules, conflict detection, handling a change) — recording pending; link will be added at the top of this README
- [x] Approach note — the Approach section above (§8 of the brief)
- [x] LinkedIn profile link — https://www.linkedin.com/in/mr-maple
- [ ] Email to ozair.shaikh@datastraw.in and aryan.jaiswal@datastraw.in, CC talent@datastraw.in,
      subject: `Smart Roster Management System Assignment - Manaal Maple` — to be sent once the video link is ready
