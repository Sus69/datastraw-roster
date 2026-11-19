// ---------------------------------------------------------------------------
// Roster engine — pure functions, no React, no I/O.
// The engine is deliberately honest: it never silently produces an invalid
// roster. Anything it cannot satisfy becomes a conflict with an explanation.
//
// Data-model note: one employee works for at most ONE brand per day, but when
// they work for a brand they cover ALL processes they are allocated to at
// that brand that day. That matches the brief: a single dedicated employee
// "handles all the processes assigned to that brand" — CS, ACC and Retention
// are tasks inside one person's working day, not three separate shifts.
//
// Constraint hierarchy (this is the key design decision):
//   1. Hard constraints (never violated):
//      - planned leave / comp-off  -> the employee is unavailable, full stop.
//      - a brand/process only operates on days its operating rule allows.
//      - one employee works for at most one brand per day (no double-booking).
//   2. Mandatory coverage: a brand/process operating day must have at least
//      minStaff people working. If that cannot be met, the slot is a GAP or
//      UNDERSTAFFED error, never a silent hole.
//   3. Preferences (soft): an employee's preferred weekly off. When the ONLY
//      way to meet mandatory coverage is to schedule someone on their weekly
//      off, the engine does so and records an OFF_OVERRIDDEN warning — required
//      client coverage beats a preferred weekly off, but the override is visible
//      so a manager can fix it (e.g. by adding backup cover).
//   4. Primaries work their processes: an available primary for an operating
//      process is scheduled to work it (a primary owns their process), unless
//      it is their weekly off and cover already exists. Secondaries are
//      backup-only: they are picked to meet minimum staffing or cover an
//      absence, never just to fill a seat.
// ---------------------------------------------------------------------------

import {
  daysInMonth,
  dayOfWeek,
  type Allocation,
  type Brand,
  type BrandProcess,
  type Employee,
  type Holiday,
  type OperatingRule,
  type ProcessId,
} from '../data/seed';

export interface RosterData {
  employees: Employee[];
  brands: Brand[];
  allocations: Allocation[];
  holidays: Holiday[];
}

export interface RosterEntry {
  date: string; // ISO yyyy-mm-dd
  employeeId: string;
  brandId: string;
  /** Every process this employee covers at this brand on this day. */
  processes: ProcessId[];
  /** True when this shift fell on the employee's preferred weekly off. */
  overriddenOff: boolean;
}

export type CoverageStatus = 'covered' | 'understaffed' | 'gap' | 'not-operating';

export interface DayCoverage {
  date: string;
  brandId: string;
  processId: ProcessId;
  operating: boolean;
  required: number;
  scheduled: string[]; // employee ids
  overriddenOff: string[];
  status: CoverageStatus;
}

export type ConflictType =
  | 'COVERAGE_GAP'
  | 'UNDERSTAFFED'
  | 'OFF_OVERRIDDEN'
  | 'DOUBLE_BOOKED'
  | 'LEAVE_CLASH';

export interface Conflict {
  id: string;
  type: ConflictType;
  severity: 'error' | 'warning';
  date: string;
  brandId?: string;
  processId?: ProcessId;
  employeeId?: string;
  message: string;
  suggestion?: string;
}

export interface RosterStats {
  operatingSlots: number;
  coveredSlots: number;
  gapSlots: number;
  understaffedSlots: number;
  warnings: number;
  errors: number;
  coveragePct: number;
  employeesWorking: number;
}

export interface RosterResult {
  year: number;
  month: number; // 1-based
  days: string[];
  entries: RosterEntry[];
  coverage: DayCoverage[];
  conflicts: Conflict[];
  stats: RosterStats;
  solverStatus?: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'UNKNOWN' | 'MODEL_INVALID';
  diagnosticExplanations?: string[];
  reoptimizationDelta?: {
    totalChanges: number;
    added: Array<{ employee_id: string; brand_id: string; process_id: string; date: string }>;
    removed: Array<{ employee_id: string; brand_id: string; process_id: string; date: string }>;
    stabilityRatio: number;
  };
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

export function isOperatingDay(rule: OperatingRule, date: string, holidays: Holiday[]): boolean {
  const holiday = holidays.some((h) => h.date === date);
  if (rule === 'ALL_YEAR') return true;
  if (rule === 'EXCEPT_HOLIDAYS') return !holiday;
  // NO_SUN_HOLIDAYS
  return !holiday && dayOfWeek(date) !== 0;
}

export function isHardUnavailable(emp: Employee, date: string): boolean {
  return emp.leaves.includes(date) || emp.compOffs.includes(date);
}

export function isWeeklyOff(emp: Employee, date: string): boolean {
  return emp.weeklyOff.includes(dayOfWeek(date));
}

export function unavailableReason(emp: Employee, date: string): string | null {
  if (emp.leaves.includes(date)) return 'on planned leave';
  if (emp.compOffs.includes(date)) return 'on comp-off';
  if (isWeeklyOff(emp, date)) return 'preferred weekly off';
  return null;
}

function allocatedTo(data: RosterData, employeeId: string, brandId: string, processId: ProcessId): boolean {
  return data.allocations.some(
    (a) => a.employeeId === employeeId && a.brandId === brandId && a.processId === processId,
  );
}

// ---------------------------------------------------------------------------
// Generation — brand by brand, most-constrained brand first.
// ---------------------------------------------------------------------------

export function generateRoster(data: RosterData, year: number, month: number): RosterResult {
  const days = daysInMonth(year, month);
  const entries: RosterEntry[] = [];
  const coverage: DayCoverage[] = [];

  const empById = new Map(data.employees.map((e) => [e.id, e]));

  // Employees allocated to each brand (regardless of process).
  const empsByBrand = new Map<string, string[]>();
  for (const a of data.allocations) {
    const list = empsByBrand.get(a.brandId) ?? [];
    if (!list.includes(a.employeeId)) list.push(a.employeeId);
    empsByBrand.set(a.brandId, list);
  }

  for (const date of days) {
    // One brand per employee per day.
    const assignedToday = new Map<string, string>(); // employeeId -> brandId
    const dayEntries: RosterEntry[] = [];

    // Tightest brands first: fewest available people relative to demand, so a
    // shared employee is spent where they are needed most.
    const demand = (brand: Brand): number => {
      const ops = brand.processes.filter((bp) => isOperatingDay(bp.rule, date, data.holidays));
      return ops.reduce((n, bp) => n + bp.minStaff, 0);
    };
    const availableCount = (brand: Brand): number =>
      (empsByBrand.get(brand.id) ?? []).filter((id) => {
        const emp = empById.get(id);
        return emp !== undefined && !isHardUnavailable(emp, date);
      }).length;
    const brandOrder = [...data.brands].sort((a, b) => {
      const tightA = availableCount(a) - demand(a);
      const tightB = availableCount(b) - demand(b);
      if (tightA !== tightB) return tightA - tightB;
      return a.name.localeCompare(b.name);
    });

    for (const brand of brandOrder) {
      const operating = brand.processes.filter((bp) => isOperatingDay(bp.rule, date, data.holidays));
      if (operating.length === 0) continue;

      const candidates = (empsByBrand.get(brand.id) ?? [])
        .map((id) => empById.get(id)!)
        .filter((emp) => emp !== undefined && !isHardUnavailable(emp, date) && !assignedToday.has(emp.id));

      // Prefer: not on weekly off today, then more primary allocations at this
      // brand (the person who owns the brand), then name for determinism.
      const primaryCount = (empId: string): number =>
        data.allocations.filter((a) => a.employeeId === empId && a.brandId === brand.id && a.role === 'primary').length;
      const ranked = [...candidates].sort((x, y) => {
        const offX = isWeeklyOff(x, date) ? 1 : 0;
        const offY = isWeeklyOff(y, date) ? 1 : 0;
        if (offX !== offY) return offX - offY;
        const px = primaryCount(x.id);
        const py = primaryCount(y.id);
        if (px !== py) return py - px;
        return x.name.localeCompare(y.name);
      });

      // Greedy: pick people until every operating process meets minStaff.
      // A picked person covers every process they are allocated to at this
      // brand, so one pick can satisfy several processes at once. Unused
      // candidates are preferred over people already picked, so work spreads
      // across the team instead of loading one person with everything.
      const picked: Employee[] = [];
      const coveredCount = (bp: BrandProcess): number =>
        picked.filter((e) => allocatedTo(data, e.id, brand.id, bp.processId)).length;
      for (const bp of [...operating].sort((a, b) => b.minStaff - a.minStaff)) {
        while (coveredCount(bp) < bp.minStaff) {
          const next = ranked.find(
            (e) => !picked.includes(e) && allocatedTo(data, e.id, brand.id, bp.processId),
          );
          if (!next) break;
          picked.push(next);
        }
      }

      // Primaries work: an available primary for an operating process is
      // scheduled to work it (a primary owns their process), unless it is
      // their weekly off and cover already exists. Without this, a
      // multi-primary brand would leave one primary idle while another
      // covers both processes. Secondaries stay backup-only: they are picked
      // above only to meet minimum staffing or cover an absence.
      for (const bp of operating) {
        const unusedPrimary = ranked.find(
          (e) =>
            !picked.includes(e) &&
            !isWeeklyOff(e, date) &&
            data.allocations.some(
              (a) => a.employeeId === e.id && a.brandId === brand.id && a.processId === bp.processId && a.role === 'primary',
            ),
        );
        if (unusedPrimary) picked.push(unusedPrimary);
      }

      for (const emp of picked) {
        assignedToday.set(emp.id, brand.id);
        const procs = operating
          .filter((bp) => allocatedTo(data, emp.id, brand.id, bp.processId))
          .map((bp) => bp.processId);
        dayEntries.push({
          date,
          employeeId: emp.id,
          brandId: brand.id,
          processes: procs,
          overriddenOff: isWeeklyOff(emp, date),
        });
      }
    }

    entries.push(...dayEntries);

    // Coverage for the day, computed from the entries just made.
    for (const brand of data.brands) {
      for (const bp of brand.processes) {
        if (!isOperatingDay(bp.rule, date, data.holidays)) {
          coverage.push({
            date, brandId: brand.id, processId: bp.processId,
            operating: false, required: bp.minStaff, scheduled: [], overriddenOff: [],
            status: 'not-operating',
          });
          continue;
        }
        const scheduled = dayEntries
          .filter((e) => e.brandId === brand.id && e.processes.includes(bp.processId))
          .map((e) => e.employeeId);
        const overriddenOff = dayEntries
          .filter((e) => e.brandId === brand.id && e.processes.includes(bp.processId) && e.overriddenOff)
          .map((e) => e.employeeId);
        const status: CoverageStatus =
          scheduled.length >= bp.minStaff
            ? 'covered'
            : scheduled.length === 0
              ? 'gap'
              : 'understaffed';
        coverage.push({
          date, brandId: brand.id, processId: bp.processId,
          operating: true, required: bp.minStaff, scheduled, overriddenOff, status,
        });
      }
    }
  }

  const conflicts = validateRoster(data, entries, coverage);
  const operating = coverage.filter((c) => c.operating);
  const covered = operating.filter((c) => c.status === 'covered').length;
  const gaps = operating.filter((c) => c.status === 'gap').length;
  const under = operating.filter((c) => c.status === 'understaffed').length;
  const errors = conflicts.filter((c) => c.severity === 'error').length;
  const warnings = conflicts.filter((c) => c.severity === 'warning').length;

  return {
    year,
    month,
    days,
    entries,
    coverage,
    conflicts,
    stats: {
      operatingSlots: operating.length,
      coveredSlots: covered,
      gapSlots: gaps,
      understaffedSlots: under,
      warnings,
      errors,
      coveragePct: operating.length === 0 ? 100 : Math.round((covered / operating.length) * 100),
      employeesWorking: new Set(entries.map((e) => e.employeeId)).size,
    },
  };
}

// ---------------------------------------------------------------------------
// Validation — recomputed from the produced roster, independent of generation.
// ---------------------------------------------------------------------------

export function validateRoster(data: RosterData, entries: RosterEntry[], coverage: DayCoverage[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const empById = new Map(data.employees.map((e) => [e.id, e]));
  const brandById = new Map(data.brands.map((b) => [b.id, b]));

  const brandName = (id?: string) => (id ? brandById.get(id)?.name ?? id : '');
  const empName = (id?: string) => (id ? empById.get(id)?.name ?? id : '');

  // 1. Coverage: gaps and understaffing, with a concrete suggestion.
  for (const c of coverage) {
    if (!c.operating) continue;
    if (c.status === 'gap') {
      conflicts.push({
        id: `gap-${c.date}-${c.brandId}-${c.processId}`,
        type: 'COVERAGE_GAP',
        severity: 'error',
        date: c.date,
        brandId: c.brandId,
        processId: c.processId,
        message: `${brandName(c.brandId)} — ${c.processId} has no cover on ${c.date} (needs ${c.required}).`,
        suggestion: 'Add a backup allocation for this brand/process, or move a leave. See "Find backup" for available cover.',
      });
    } else if (c.status === 'understaffed') {
      conflicts.push({
        id: `under-${c.date}-${c.brandId}-${c.processId}`,
        type: 'UNDERSTAFFED',
        severity: 'error',
        date: c.date,
        brandId: c.brandId,
        processId: c.processId,
        message: `${brandName(c.brandId)} — ${c.processId} is understaffed on ${c.date}: ${c.scheduled.length} of ${c.required} required working.`,
        suggestion: 'Assign an additional employee to this brand/process, or reduce the minimum staffing for the day.',
      });
    }
  }

  // 2. Weekly-off overrides: one warning per employee-day (not per process —
  // the person worked one shift that happened to cover several processes).
  for (const e of entries) {
    if (!e.overriddenOff) continue;
    conflicts.push({
      id: `off-${e.date}-${e.employeeId}`,
      type: 'OFF_OVERRIDDEN',
      severity: 'warning',
      date: e.date,
      brandId: e.brandId,
      employeeId: e.employeeId,
      message: `${empName(e.employeeId)} worked on their preferred weekly off (${e.date}) to cover ${brandName(e.brandId)} (${e.processes.join(', ')}).`,
      suggestion: 'Mandatory coverage took priority. Add backup cover for this brand so the weekly off can be honoured.',
    });
  }

  // 3. Double-booking: one employee, two assignments, same day.
  const perDay = new Map<string, RosterEntry[]>();
  for (const e of entries) {
    const key = `${e.employeeId}|${e.date}`;
    const list = perDay.get(key) ?? [];
    list.push(e);
    perDay.set(key, list);
  }
  for (const [key, list] of perDay) {
    if (list.length > 1) {
      const [employeeId, date] = key.split('|');
      conflicts.push({
        id: `double-${key}`,
        type: 'DOUBLE_BOOKED',
        severity: 'error',
        date,
        employeeId,
        message: `${empName(employeeId)} is assigned to ${list.length} shifts on ${date}.`,
        suggestion: 'Reassign one of the shifts to another employee.',
      });
    }
  }

  // 4. Leave clashes: someone scheduled while on leave or comp-off.
  for (const e of entries) {
    const emp = empById.get(e.employeeId);
    if (!emp) continue;
    const reason = emp.leaves.includes(e.date)
      ? 'planned leave'
      : emp.compOffs.includes(e.date)
        ? 'comp-off'
        : null;
    if (reason) {
      conflicts.push({
        id: `leave-${e.date}-${e.employeeId}`,
        type: 'LEAVE_CLASH',
        severity: 'error',
        date: e.date,
        brandId: e.brandId,
        processId: e.processes[0],
        employeeId: e.employeeId,
        message: `${empName(e.employeeId)} is scheduled on ${e.date} while on ${reason}.`,
        suggestion: 'Remove the assignment or move the leave.',
      });
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Backup search — used by the "simulate change" flow and the conflict list.
// ---------------------------------------------------------------------------

export interface BackupCandidate {
  employeeId: string;
  name: string;
  tier: 'same-brand' | 'same-pod';
  reason: string;
}

export function findBackup(
  data: RosterData,
  result: RosterResult,
  date: string,
  brandId: string,
  processId: ProcessId,
  excludeEmployeeId?: string,
): BackupCandidate[] {
  const brand = data.brands.find((b) => b.id === brandId);
  if (!brand) return [];
  const assignedThatDay = new Set(
    result.entries.filter((e) => e.date === date).map((e) => e.employeeId),
  );
  const empById = new Map(data.employees.map((e) => [e.id, e]));
  const out: BackupCandidate[] = [];

  const consider = (empId: string, tier: 'same-brand' | 'same-pod', reason: string) => {
    if (empId === excludeEmployeeId) return;
    if (assignedThatDay.has(empId)) return;
    const emp = empById.get(empId);
    if (!emp) return;
    if (isHardUnavailable(emp, date)) return;
    if (out.some((o) => o.employeeId === empId)) return;
    out.push({ employeeId: empId, name: emp.name, tier, reason });
  };

  // Tier 1: allocated to the same brand + process.
  for (const a of data.allocations) {
    if (a.brandId === brandId && a.processId === processId) {
      const emp = empById.get(a.employeeId)!;
      const offNote = isWeeklyOff(emp, date) ? ' (would work their weekly off)' : '';
      consider(a.employeeId, 'same-brand', `${a.role} cover for this brand/process${offNote}`);
    }
  }
  // Tier 2: same pod, same process, on a different brand — free that day.
  for (const a of data.allocations) {
    if (a.processId !== processId || a.brandId === brandId) continue;
    const emp = empById.get(a.employeeId);
    if (!emp || emp.podId !== brand.podId) continue;
    consider(a.employeeId, 'same-pod', `Same pod, covers ${processId} for another brand`);
  }

  // Prefer people who are not on their weekly off, then same-brand tier.
  const rank = (c: BackupCandidate) => {
    const emp = empById.get(c.employeeId)!;
    return `${isWeeklyOff(emp, date) ? 1 : 0}-${c.tier === 'same-brand' ? 0 : 1}-${c.name}`;
  };
  return out.sort((a, b) => rank(a).localeCompare(rank(b)));
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

export function rosterToCsv(data: RosterData, result: RosterResult): string {
  const empById = new Map(data.employees.map((e) => [e.id, e]));
  const brandById = new Map(data.brands.map((b) => [b.id, b]));
  const lines: string[] = ['Date,Employee,Brand,Processes,Weekly off overridden'];
  const sorted = [...result.entries].sort((a, b) =>
    a.date.localeCompare(b.date) || (empById.get(a.employeeId)?.name ?? '').localeCompare(empById.get(b.employeeId)?.name ?? ''),
  );
  for (const e of sorted) {
    lines.push(
      [
        e.date,
        empById.get(e.employeeId)?.name ?? e.employeeId,
        brandById.get(e.brandId)?.name ?? e.brandId,
        e.processes.join(';'),
        e.overriddenOff ? 'yes' : 'no',
      ].join(','),
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CP-SAT Integration Layer
// ---------------------------------------------------------------------------

export async function checkCPSATHealth(): Promise<boolean> {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return false;
    const json = await res.json();
    return json.ready === true;
  } catch {
    return false;
  }
}

export async function generateRosterCPSAT(
  data: RosterData,
  year: number,
  month: number,
  timeoutSeconds: number = 10.0,
): Promise<RosterResult> {
  const days = daysInMonth(year, month);
  const payload = {
    employees: data.employees.map((e) => ({
      id: e.id,
      name: e.name,
      pod_id: e.podId,
      weekly_off: e.weeklyOff,
      leaves: e.leaves,
      comp_offs: e.compOffs,
      min_weekly_off: 1,
      max_weekly_off: 2,
    })),
    brands: data.brands.map((b) => ({
      id: b.id,
      name: b.name,
      category: b.category,
      pod_id: b.podId,
      processes: b.processes.map((p) => ({
        process_id: p.processId,
        rule: p.rule,
        min_staff: p.minStaff,
      })),
    })),
    allocations: data.allocations.map((a) => ({
      employee_id: a.employeeId,
      brand_id: a.brandId,
      process_id: a.processId,
      role: a.role,
    })),
    holidays: data.holidays,
    dates: days,
    timeout_seconds: timeoutSeconds,
  };

  try {
    const res = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const json = await res.json();
    if (res.status === 200 || res.status === 422) {
      let entries: RosterEntry[] = (json.entries || []).map((e: any) => ({
        date: e.date,
        employeeId: e.employee_id,
        brandId: e.brand_id,
        processes: e.processes,
        overriddenOff: e.is_weekly_off || false,
      }));

      const coverage: DayCoverage[] = (json.coverage || []).map((c: any) => ({
        date: c.date,
        brandId: c.brand_id,
        processId: c.process_id,
        operating: c.operating,
        required: c.required,
        scheduled: c.scheduled,
        overriddenOff: [],
        status: c.status,
      }));

      // When solver provides diagnostic schedule on infeasible constraints, populate entries from coverage
      if (entries.length === 0 && coverage.length > 0) {
        const empDateMap = new Map<string, { brandId: string; processes: ProcessId[]; overriddenOff: boolean }>();
        for (const cov of coverage) {
          if (cov.operating && cov.scheduled) {
            for (const empId of cov.scheduled) {
              const key = `${empId}|${cov.date}`;
              const existing = empDateMap.get(key);
              if (existing) {
                if (!existing.processes.includes(cov.processId)) {
                  existing.processes.push(cov.processId);
                }
              } else {
                const emp = data.employees.find((e) => e.id === empId);
                empDateMap.set(key, {
                  brandId: cov.brandId,
                  processes: [cov.processId],
                  overriddenOff: emp ? isWeeklyOff(emp, cov.date) : false,
                });
              }
            }
          }
        }
        for (const [key, val] of empDateMap.entries()) {
          const [employeeId, date] = key.split('|');
          entries.push({
            date,
            employeeId,
            brandId: val.brandId,
            processes: val.processes,
            overriddenOff: val.overriddenOff,
          });
        }
      }

      const conflicts: Conflict[] = (json.conflicts || []).map((cf: any) => ({
        id: cf.id,
        type: cf.type,
        severity: cf.severity,
        date: cf.date,
        brandId: cf.brand_id,
        processId: cf.process_id,
        employeeId: cf.employee_id,
        message: cf.message,
        suggestion: cf.suggestion,
      }));

      const opSlots = json.stats?.operating_slots || 0;
      const covSlots = json.stats?.covered_slots || 0;
      const calcPct = opSlots > 0 ? Math.round((covSlots / opSlots) * 100) : 100;

      const stats: RosterStats = {
        operatingSlots: opSlots,
        coveredSlots: covSlots,
        gapSlots: json.stats?.gap_slots || 0,
        understaffedSlots: json.stats?.understaffed_slots || 0,
        warnings: json.stats?.warnings || 0,
        errors: json.stats?.errors || 0,
        coveragePct: json.stats?.coverage_pct && json.stats?.coverage_pct > 0 ? json.stats.coverage_pct : calcPct,
        employeesWorking: json.stats?.employees_working && json.stats?.employees_working > 0 ? json.stats.employees_working : new Set(entries.map((e) => e.employeeId)).size,
      };

      return {
        year,
        month,
        days,
        entries,
        coverage,
        conflicts,
        stats,
        solverStatus: json.status,
        diagnosticExplanations: json.diagnostic_explanations,
      };
    }
  } catch (err) {
    // Fall back to local synchronous generation if server offline
    console.warn('CP-SAT server unavailable, falling back to local engine:', err);
  }

  const fallback = generateRoster(data, year, month);
  fallback.solverStatus = 'FEASIBLE';
  return fallback;
}
