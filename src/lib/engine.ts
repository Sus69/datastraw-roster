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
  type CrossPodAuthorization,
  type IncompatiblePair,
  type RecoveryAssignment,
} from '../data/seed';
import { findSafeBackups } from './recovery';

/** Optional working-hour capacity policy. Disabled unless explicitly enabled. */
export interface WorkloadRequirement {
  brandId: string;
  processId: ProcessId;
  date: string;
  demandHours: number;
}

export interface EmployeeCapacity {
  employeeId: string;
  date: string;
  maxDailyHours: number;
  /** Keys may be `brandId:processId` or a bare process id. */
  processCapacityHours: Record<string, number>;
}

export interface WorkloadPolicy {
  enabled: boolean;
  demands: WorkloadRequirement[];
  capacities: EmployeeCapacity[];
}

export interface RosterData {
  employees: Employee[];
  brands: Brand[];
  allocations: Allocation[];
  holidays: Holiday[];
  /**
   * Date-specific recovery instructions created by the Roster Recovery Engine.
   * They never mutate the permanent allocations above; the generator applies
   * them only for the named date.
   */
  recoveryAssignments?: RecoveryAssignment[];
  /** Optional explicit permission for a named employee to cover a named
   *  brand/process outside their own pod. General process experience is not
   *  enough to authorize a cross-pod move. */
  crossPodAuthorizations?: CrossPodAuthorization[];
  /** Explicit brand/process pairs that cannot be worked in the same day. */
  incompatiblePairs?: IncompatiblePair[];
  /** Optional daily demand/capacity limits, checked after generation. */
  workloadPolicy?: WorkloadPolicy;
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
  | 'LEAVE_CLASH'
  | 'INCOMPATIBLE_DUTY'
  | 'UNAUTHORIZED_ASSIGNMENT'
  | 'CALENDAR_VIOLATION'
  | 'UNKNOWN_EMPLOYEE'
  | 'WORKLOAD_SHORTAGE'
  | 'INVALID_INPUT';

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
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

export function isOperatingDay(
  rule: OperatingRule,
  date: string,
  holidays: Holiday[],
  customOperatingDates?: readonly string[],
): boolean {
  if (rule === 'CUSTOM') return (customOperatingDates ?? []).includes(date);
  const holiday = holidays.some((h) => h.date === date);
  if (rule === 'ALL_YEAR') return true;
  if (rule === 'EXCEPT_HOLIDAYS') return !holiday;
  // NO_SUN_HOLIDAYS
  return !holiday && dayOfWeek(date) !== 0;
}

function hasIncompatibleDuty(
  data: RosterData,
  brandId: string,
  processes: readonly ProcessId[],
): [ProcessId, ProcessId] | null {
  for (let i = 0; i < processes.length; i += 1) {
    for (let j = i + 1; j < processes.length; j += 1) {
      const first = processes[i];
      const second = processes[j];
      const incompatible = (data.incompatiblePairs ?? []).some((pair) => {
        const forward =
          pair.brandId1 === brandId && pair.processId1 === first &&
          pair.brandId2 === brandId && pair.processId2 === second;
        const reverse =
          pair.brandId1 === brandId && pair.processId1 === second &&
          pair.brandId2 === brandId && pair.processId2 === first;
        return forward || reverse;
      });
      if (incompatible) return [first, second];
    }
  }
  return null;
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

function authorizedFor(data: RosterData, employeeId: string, brandId: string, processId: ProcessId): boolean {
  if (allocatedTo(data, employeeId, brandId, processId)) return true;
  const emp = data.employees.find((e) => e.id === employeeId);
  const brand = data.brands.find((b) => b.id === brandId);
  if (!emp || !brand) return false;
  // Explicit pod-boundary authorization covers a cross-pod move.
  if ((data.crossPodAuthorizations ?? []).some(
    (c) => c.employeeId === employeeId && c.brandId === brandId && c.processId === processId,
  )) return true;
  // Same-pod recovery may use process experience even when the employee is not
  // permanently allocated to this particular brand.
  return emp.podId === brand.podId && data.allocations.some(
    (a) => a.employeeId === employeeId && a.processId === processId,
  );
}

/** Processes covered by a date-specific recovery instruction. */
export function recoveryProcesses(
  data: RosterData,
  employeeId: string,
  brand: Brand,
  targetProcess: ProcessId,
  type: RecoveryAssignment['type'],
  date: string,
): ProcessId[] {
  if (type === 'temporary-backup') return [targetProcess];
  const processes = brand.processes
    .filter((bp) => isOperatingDay(bp.rule, date, data.holidays, bp.customOperatingDates))
    .filter((bp) => allocatedTo(data, employeeId, brand.id, bp.processId))
    .map((bp) => bp.processId);
  if (!processes.includes(targetProcess)) processes.push(targetProcess);
  return processes;
}

// ---------------------------------------------------------------------------
// Input validation — fail with an explanation instead of producing nonsense.
// ---------------------------------------------------------------------------

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Returns human-readable input errors. An empty array means the input is usable. */
export function validateRosterInput(data: RosterData, year: number, month: number): string[] {
  if (!data || typeof data !== 'object') return ['Roster data is missing or malformed.'];
  const errors: string[] = [];
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    errors.push(`Invalid scheduling year: ${String(year)}.`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    errors.push(`Invalid scheduling month: ${String(month)}. Use 1-12.`);
  }
  if (!Array.isArray(data.employees) || data.employees.length === 0) {
    errors.push('At least one employee is required.');
  }
  if (!Array.isArray(data.brands) || data.brands.length === 0) {
    errors.push('At least one brand is required.');
  }
  if (!Array.isArray(data.allocations)) errors.push('Allocations must be an array.');
  if (!Array.isArray(data.holidays)) errors.push('Holidays must be an array.');

  const employeeIds = new Set<string>();
  for (const emp of data.employees ?? []) {
    if (!emp.id || employeeIds.has(emp.id)) {
      errors.push(`Duplicate or empty employee id: ${String(emp.id)}.`);
    }
    employeeIds.add(emp.id);
    if (!emp.name) errors.push(`Employee ${emp.id} has no name.`);
    if (!Array.isArray(emp.weeklyOff) || emp.weeklyOff.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      errors.push(`Employee ${emp.id} has invalid weekly-off days.`);
    }
    for (const date of [...(emp.leaves ?? []), ...(emp.compOffs ?? [])]) {
      if (!isIsoDate(date)) errors.push(`Employee ${emp.id} has an invalid leave/comp-off date: ${date}.`);
    }
  }

  const brandById = new Map<string, Brand>();
  for (const brand of data.brands ?? []) {
    if (!brand.id || brandById.has(brand.id)) {
      errors.push(`Duplicate or empty brand id: ${String(brand.id)}.`);
    }
    brandById.set(brand.id, brand);
    if (!brand.name) errors.push(`Brand ${brand.id} has no name.`);
    const processIds = new Set<string>();
    for (const process of brand.processes ?? []) {
      if (!process.processId || processIds.has(process.processId)) {
        errors.push(`Brand ${brand.id} has a duplicate or empty process id: ${String(process.processId)}.`);
      }
      processIds.add(process.processId);
      if (!Number.isInteger(process.minStaff) || process.minStaff < 0) {
        errors.push(`Brand ${brand.id} ${process.processId} has an invalid minimum staffing: ${String(process.minStaff)}.`);
      }
      if (!['ALL_YEAR', 'EXCEPT_HOLIDAYS', 'NO_SUN_HOLIDAYS', 'CUSTOM'].includes(process.rule)) {
        errors.push(`Brand ${brand.id} ${process.processId} has an unknown operating rule: ${String(process.rule)}.`);
      }
      if (process.rule === 'CUSTOM' && (process.customOperatingDates ?? []).some((date) => !isIsoDate(date))) {
        errors.push(`Brand ${brand.id} ${process.processId} has an invalid custom operating date.`);
      }
    }
  }

  for (const allocation of data.allocations ?? []) {
    const brand = brandById.get(allocation.brandId);
    if (!employeeIds.has(allocation.employeeId)) {
      errors.push(`Allocation references unknown employee ${allocation.employeeId}.`);
    }
    if (!brand) {
      errors.push(`Allocation references unknown brand ${allocation.brandId}.`);
    } else if (!brand.processes.some((p) => p.processId === allocation.processId)) {
      errors.push(`Allocation references unknown process ${allocation.brandId}-${allocation.processId}.`);
    }
    if (allocation.role !== 'primary' && allocation.role !== 'secondary') {
      errors.push(`Allocation for ${allocation.employeeId} has an invalid role: ${String(allocation.role)}.`);
    }
  }

  for (const holiday of data.holidays ?? []) {
    if (!isIsoDate(holiday.date)) errors.push(`Invalid holiday date: ${holiday.date}.`);
  }
  for (const authorization of data.crossPodAuthorizations ?? []) {
    const brand = brandById.get(authorization.brandId);
    if (!employeeIds.has(authorization.employeeId) || !brand ||
      !brand.processes.some((p) => p.processId === authorization.processId)) {
      errors.push(`Cross-pod authorization references an unknown employee, brand or process.`);
    }
  }
  for (const pair of data.incompatiblePairs ?? []) {
    for (const [brandId, processId] of [[pair.brandId1, pair.processId1], [pair.brandId2, pair.processId2]]) {
      const brand = brandById.get(brandId);
      if (!brand || !brand.processes.some((p) => p.processId === processId)) {
        errors.push(`Incompatible pair references unknown process ${brandId}-${processId}.`);
      }
    }
  }
  if (data.workloadPolicy?.enabled) {
    for (const demand of data.workloadPolicy.demands) {
      if (!isIsoDate(demand.date)) errors.push(`Workload demand has an invalid date: ${demand.date}.`);
      if (!brandById.get(demand.brandId)?.processes.some((p) => p.processId === demand.processId)) {
        errors.push(`Workload demand references unknown process ${demand.brandId}-${demand.processId}.`);
      }
      if (!Number.isFinite(demand.demandHours) || demand.demandHours < 0) {
        errors.push(`Workload demand for ${demand.brandId}-${demand.processId} on ${demand.date} is invalid.`);
      }
    }
    for (const capacity of data.workloadPolicy.capacities) {
      if (!employeeIds.has(capacity.employeeId)) {
        errors.push(`Workload capacity references unknown employee ${capacity.employeeId}.`);
      }
      if (!isIsoDate(capacity.date)) errors.push(`Workload capacity has an invalid date: ${capacity.date}.`);
      if (!Number.isFinite(capacity.maxDailyHours) || capacity.maxDailyHours < 0) {
        errors.push(`Workload capacity for ${capacity.employeeId} on ${capacity.date} is invalid.`);
      }
    }
  }

  return errors;
}

function invalidInputResult(year: number, month: number, errors: string[]): RosterResult {
  return {
    year,
    month,
    days: [],
    entries: [],
    coverage: [],
    conflicts: errors.map((message, index) => ({
      id: `input-${index}`,
      type: 'INVALID_INPUT' as const,
      severity: 'error' as const,
      date: '',
      message,
      suggestion: 'Correct the roster data and generate again.',
    })),
    stats: {
      operatingSlots: 0,
      coveredSlots: 0,
      gapSlots: 0,
      understaffedSlots: 0,
      warnings: 0,
      errors: errors.length,
      coveragePct: 0,
      employeesWorking: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Generation — brand by brand, most-constrained brand first.
// ---------------------------------------------------------------------------

export function generateRoster(data: RosterData, year: number, month: number): RosterResult {
  const inputErrors = validateRosterInput(data, year, month);
  if (inputErrors.length > 0) return invalidInputResult(year, month, inputErrors);
  const days = daysInMonth(year, month);
  const entries: RosterEntry[] = [];
  const coverage: DayCoverage[] = [];

  const empById = new Map(data.employees.map((e) => [e.id, e]));

  // Fairness ledger: how often each employee has already been used this month.
  // Shared backups are chosen from the least-loaded eligible people so the same
  // floater is not repeatedly pulled into every gap.
  const workload = new Map<string, number>();
  const overrideWorkload = new Map<string, number>();
  const loadOf = (employeeId: string): number => workload.get(employeeId) ?? 0;
  const overridesOf = (employeeId: string): number => overrideWorkload.get(employeeId) ?? 0;

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

    // Apply date-specific recovery instructions before normal generation.
    // A reassignment pins the employee to the destination brand for this date
    // (so the generator cannot also send them to their permanent brand), while
    // a temporary backup adds one process without changing allocations.
    const directives = (data.recoveryAssignments ?? []).filter((r) => r.date === date);
    for (const directive of directives) {
      const emp = empById.get(directive.employeeId);
      const targetBrand = data.brands.find((b) => b.id === directive.brandId);
      const targetProcess = targetBrand?.processes.find((p) => p.processId === directive.processId);
      if (!emp || !targetBrand || !targetProcess) continue;
      if (isHardUnavailable(emp, date)) continue;
      if (!isOperatingDay(targetProcess.rule, date, data.holidays, targetProcess.customOperatingDates)) continue;

      const existingBrand = assignedToday.get(emp.id);
      const isReassignment = directive.type === 'temporary-reassignment';
      if (existingBrand && existingBrand !== targetBrand.id && !isReassignment) continue;

      // A reassignment replaces any earlier recovery entry for the employee.
      if (isReassignment) {
        for (let i = dayEntries.length - 1; i >= 0; i--) {
          if (dayEntries[i].employeeId === emp.id) dayEntries.splice(i, 1);
        }
      }

      const processes = recoveryProcesses(data, emp.id, targetBrand, directive.processId, directive.type, date);
      if (hasIncompatibleDuty(data, targetBrand.id, processes)) continue;
      const existingEntry = dayEntries.find(
        (e) => e.employeeId === emp.id && e.brandId === targetBrand.id,
      );
      if (existingEntry) {
        for (const p of processes) if (!existingEntry.processes.includes(p)) existingEntry.processes.push(p);
        existingEntry.overriddenOff = existingEntry.overriddenOff || isWeeklyOff(emp, date);
      } else {
        dayEntries.push({
          date,
          employeeId: emp.id,
          brandId: targetBrand.id,
          processes,
          overriddenOff: isWeeklyOff(emp, date),
        });
      }
      assignedToday.set(emp.id, targetBrand.id);
    }

    // Tightest brands first: fewest available people relative to demand, so a
    // shared employee is spent where they are needed most.
    const demand = (brand: Brand): number => {
      const ops = brand.processes.filter((bp) => isOperatingDay(bp.rule, date, data.holidays, bp.customOperatingDates));
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
      const operating = brand.processes.filter((bp) => isOperatingDay(bp.rule, date, data.holidays, bp.customOperatingDates));
      if (operating.length === 0) continue;

      const processesAtBrand = (emp: Employee): ProcessId[] => operating
        .filter((bp) => allocatedTo(data, emp.id, brand.id, bp.processId))
        .map((bp) => bp.processId);
      const candidates = (empsByBrand.get(brand.id) ?? [])
        .map((id) => empById.get(id)!)
        .filter((emp) =>
          emp !== undefined &&
          !isHardUnavailable(emp, date) &&
          !assignedToday.has(emp.id) &&
          hasIncompatibleDuty(data, brand.id, processesAtBrand(emp)) === null,
        );

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
        // Fairness tie-breaker: spread work and weekly-off overrides evenly.
        const loadX = loadOf(x.id);
        const loadY = loadOf(y.id);
        if (loadX !== loadY) return loadX - loadY;
        const overrideX = overridesOf(x.id);
        const overrideY = overridesOf(y.id);
        if (overrideX !== overrideY) return overrideX - overrideY;
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
        const procs = processesAtBrand(emp);
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

    // Record the month-to-date workload after the day is finalized. Directives
    // count too, so a recovery repair immediately affects later fairness.
    for (const entry of dayEntries) {
      workload.set(entry.employeeId, loadOf(entry.employeeId) + 1);
      if (entry.overriddenOff) overrideWorkload.set(entry.employeeId, overridesOf(entry.employeeId) + 1);
    }

    // Coverage for the day, computed from the entries just made.
    for (const brand of data.brands) {
      for (const bp of brand.processes) {
        if (!isOperatingDay(bp.rule, date, data.holidays, bp.customOperatingDates)) {
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

  // 0. Entry-level hard constraints. Generation is not trusted to have got
  // these right; a manual or recovery entry is checked independently.
  for (const entry of entries) {
    const emp = empById.get(entry.employeeId);
    const brand = brandById.get(entry.brandId);
    if (!emp) {
      conflicts.push({
        id: `unknown-${entry.date}-${entry.employeeId}`,
        type: 'UNKNOWN_EMPLOYEE',
        severity: 'error',
        date: entry.date,
        brandId: entry.brandId,
        employeeId: entry.employeeId,
        message: `Unknown employee ${entry.employeeId} appears in the roster on ${entry.date}.`,
        suggestion: 'Remove the assignment or add the employee to the roster data.',
      });
      continue;
    }
    if (!brand) {
      conflicts.push({
        id: `unknown-brand-${entry.date}-${entry.employeeId}`,
        type: 'CALENDAR_VIOLATION',
        severity: 'error',
        date: entry.date,
        brandId: entry.brandId,
        employeeId: entry.employeeId,
        message: `Unknown brand ${entry.brandId} appears in the roster on ${entry.date}.`,
        suggestion: 'Remove the assignment or add the brand to the roster data.',
      });
      continue;
    }

    for (const processId of entry.processes) {
      const bp = brand.processes.find((p) => p.processId === processId);
      if (!bp) {
        conflicts.push({
          id: `unknown-process-${entry.date}-${entry.employeeId}-${processId}`,
          type: 'CALENDAR_VIOLATION',
          severity: 'error',
          date: entry.date,
          brandId: entry.brandId,
          processId,
          employeeId: entry.employeeId,
          message: `Unknown process ${entry.brandId}-${processId} appears on ${entry.date}.`,
          suggestion: 'Remove the assignment or add the process to the brand.',
        });
        continue;
      }
      if (!isOperatingDay(bp.rule, entry.date, data.holidays, bp.customOperatingDates)) {
        conflicts.push({
          id: `closed-${entry.date}-${entry.employeeId}-${brand.id}-${processId}`,
          type: 'CALENDAR_VIOLATION',
          severity: 'error',
          date: entry.date,
          brandId: brand.id,
          processId,
          employeeId: entry.employeeId,
          message: `${emp.name} is assigned to ${brand.name} ${processId} on ${entry.date}, but that process is closed.`,
          suggestion: 'Remove the assignment or change the process operating rule.',
        });
      }
      if (!authorizedFor(data, entry.employeeId, brand.id, processId)) {
        conflicts.push({
          id: `unauthorized-${entry.date}-${entry.employeeId}-${brand.id}-${processId}`,
          type: 'UNAUTHORIZED_ASSIGNMENT',
          severity: 'error',
          date: entry.date,
          brandId: brand.id,
          processId,
          employeeId: entry.employeeId,
          message: `${emp.name} is assigned to ${brand.name} ${processId} on ${entry.date} without an allocation or cross-pod authorization.`,
          suggestion: 'Add an allocation or explicit cross-pod authorization, or remove the assignment.',
        });
      }
    }

    const incompatible = hasIncompatibleDuty(data, brand.id, entry.processes);
    if (incompatible) {
      conflicts.push({
        id: `incompatible-${entry.date}-${entry.employeeId}-${brand.id}-${incompatible[0]}-${incompatible[1]}`,
        type: 'INCOMPATIBLE_DUTY',
        severity: 'error',
        date: entry.date,
        brandId: brand.id,
        processId: incompatible[0],
        employeeId: entry.employeeId,
        message: `${emp.name} is assigned incompatible duties ${incompatible[0]} and ${incompatible[1]} at ${brand.name} on ${entry.date}.`,
        suggestion: 'Split the incompatible processes between different employees.',
      });
    }
  }

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

  // 5. Optional working-hour demand/capacity policy.
  conflicts.push(...validateWorkloadPolicy(data, entries));

  return conflicts;
}

/** Deterministic max-flow check for the optional workload policy. */
function validateWorkloadPolicy(data: RosterData, entries: RosterEntry[]): Conflict[] {
  const policy = data.workloadPolicy;
  if (!policy?.enabled || policy.demands.length === 0 || policy.capacities.length === 0) return [];

  const conflicts: Conflict[] = [];
  const dates = [...new Set(policy.demands.map((d) => d.date))].sort();
  for (const date of dates) {
    const dayEntries = entries.filter((e) => e.date === date);
    const employees = [...new Set(dayEntries.map((e) => e.employeeId))].sort();
    const demands: WorkloadRequirement[] = policy.demands.filter(
      (demand) => demand.date === date && demand.demandHours > 0,
    );
    if (demands.length === 0) continue;

    const capFor = (employeeId: string): number => {
      const cap = policy.capacities.find((c) => c.employeeId === employeeId && c.date === date);
      return Math.max(0, Math.round((cap?.maxDailyHours ?? 8) * 10));
    };
    const processCapFor = (employeeId: string, brandId: string, processId: ProcessId): number => {
      const cap = policy.capacities.find((c) => c.employeeId === employeeId && c.date === date);
      const key = `${brandId}:${processId}`;
      const hours = cap?.processCapacityHours[key] ?? cap?.processCapacityHours[processId];
      return Math.max(0, Math.round((hours ?? cap?.maxDailyHours ?? 8) * 10));
    };

    // Nodes: source (0), employees, demands, sink.
    const employeeOffset = 1;
    const demandOffset = employeeOffset + employees.length;
    const sink = demandOffset + demands.length;
    interface FlowEdge { to: number; cap: number; flow: number; rev: number }
    const graph: FlowEdge[][] = Array.from({ length: sink + 1 }, () => []);
    const addEdge = (from: number, to: number, cap: number): FlowEdge => {
      const forward: FlowEdge = { to, cap, flow: 0, rev: graph[to].length };
      const reverse: FlowEdge = { to: from, cap: 0, flow: 0, rev: graph[from].length };
      graph[from].push(forward);
      graph[to].push(reverse);
      return forward;
    };

    employees.forEach((employeeId, index) => addEdge(0, employeeOffset + index, capFor(employeeId)));
    const demandEdges: FlowEdge[] = [];
    demands.forEach((demand, index) => {
      demandEdges.push(addEdge(demandOffset + index, sink, Math.round(demand.demandHours * 10)));
    });

    employees.forEach((employeeId, employeeIndex) => {
      const employeeEntries = dayEntries.filter((e) => e.employeeId === employeeId);
      demands.forEach((demand, demandIndex) => {
        const assigned = employeeEntries.some(
          (e) => e.brandId === demand.brandId && e.processes.includes(demand.processId),
        );
        if (!assigned) return;
        addEdge(
          employeeOffset + employeeIndex,
          demandOffset + demandIndex,
          Math.min(capFor(employeeId), processCapFor(employeeId, demand.brandId, demand.processId)),
        );
      });
    });

    // Edmonds-Karp. The graphs are tiny (tens of nodes), so clarity wins.
    while (true) {
      const parent = new Array<{ node: number; edge: number } | null>(graph.length).fill(null);
      const queue = [0];
      parent[0] = { node: -1, edge: -1 };
      for (let head = 0; head < queue.length && parent[sink] === null; head += 1) {
        const node = queue[head];
        for (let edgeIndex = 0; edgeIndex < graph[node].length; edgeIndex += 1) {
          const edge = graph[node][edgeIndex];
          if (edge.cap - edge.flow <= 0 || parent[edge.to] !== null) continue;
          parent[edge.to] = { node, edge: edgeIndex };
          queue.push(edge.to);
        }
      }
      if (parent[sink] === null) break;
      let bottleneck = Number.POSITIVE_INFINITY;
      for (let node = sink; node !== 0;) {
        const step = parent[node]!;
        bottleneck = Math.min(bottleneck, graph[step.node][step.edge].cap - graph[step.node][step.edge].flow);
        node = step.node;
      }
      for (let node = sink; node !== 0;) {
        const step = parent[node]!;
        const edge = graph[step.node][step.edge];
        edge.flow += bottleneck;
        graph[node][edge.rev].flow -= bottleneck;
        node = step.node;
      }
    }

    demands.forEach((demand, index) => {
      const edge = demandEdges[index];
      const supplied = edge.flow;
      const required = Math.round(demand.demandHours * 10);
      if (supplied < required) {
        const brand = data.brands.find((b) => b.id === demand.brandId);
        conflicts.push({
          id: `workload-${date}-${demand.brandId}-${demand.processId}`,
          type: 'WORKLOAD_SHORTAGE',
          severity: 'error',
          date,
          brandId: demand.brandId,
          processId: demand.processId,
          message: `${brand?.name ?? demand.brandId} ${demand.processId} needs ${(required / 10).toFixed(1)}h on ${date}, but only ${(Math.max(0, supplied) / 10).toFixed(1)}h of scheduled capacity can cover it.`,
          suggestion: 'Add scheduled capacity for this process or reduce the daily demand.',
        });
      }
    });
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
  // Keep the historical API, but route it through the recovery evaluator so it
  // can no longer recommend a candidate whose move creates another gap.
  return findSafeBackups(data, result, date, brandId, processId, excludeEmployeeId).map((p) => ({
    employeeId: p.employeeId,
    name: p.name,
    tier: p.recoveryType === 'same-pod-backup' ? 'same-pod' : 'same-brand',
    reason: p.reasons[0] ?? p.recoveryType,
  }));
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

