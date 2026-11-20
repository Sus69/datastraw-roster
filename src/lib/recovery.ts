// ---------------------------------------------------------------------------
// Roster Recovery Engine
//
// Find Backup used to return the first free, allocated employee. Recovery is a
// different problem: a safe repair may require moving an employee away from a
// different brand, and that move must not create a new coverage gap. This module
// evaluates each candidate against the *whole day's* roster, ranks only valid
// repairs, and keeps the repair as a date-specific instruction so permanent
// allocations are never rewritten by a temporary absence.
// ---------------------------------------------------------------------------

import {
  PROCESSES,
  type Brand,
  type ProcessId,
  type RecoveryAssignment,
} from '../data/seed';
import {
  isHardUnavailable,
  isOperatingDay,
  isWeeklyOff,
  recoveryProcesses,
  validateRoster,
  type Conflict,
  type DayCoverage,
  type RosterData,
  type RosterEntry,
  type RosterResult,
} from './engine';

export type RecoveryType =
  | 'direct-backup'
  | 'same-pod-backup'
  | 'same-brand-reassignment'
  | 'cross-brand-reassignment';

export type RecoveryRejectionCode =
  | 'ALREADY_ASSIGNED_TARGET'
  | 'ALREADY_ASSIGNED_OTHER_BRAND'
  | 'NO_COMPATIBLE_PROCESS_ALLOCATION'
  | 'ON_LEAVE_OR_COMP_OFF'
  | 'REASSIGNMENT_CAUSES_UNDERSTAFFING'
  | 'TARGET_NOT_COVERED'
  | 'OUTSIDE_PERMITTED_POOL'
  | 'NO_ELIGIBLE_EMPLOYEE';

export interface RecoveryImpact {
  brandId: string;
  brandName: string;
  processId: ProcessId;
  required: number;
  beforeScheduled: number;
  afterScheduled: number;
  beforeStatus: DayCoverage['status'];
  afterStatus: DayCoverage['status'];
}

export interface RecoveryCandidate {
  employeeId: string;
  name: string;
  currentAssignment: {
    brandId: string;
    brandName: string;
    processes: ProcessId[];
    isPrimary: boolean;
  } | null;
  targetAssignment: {
    brandId: string;
    brandName: string;
    processId: ProcessId;
    processName: string;
  };
  recoveryType: RecoveryType;
  allocationType: RecoveryAssignment['type'];
  changedAssignments: number;
  primaryDisruption: number;
  weeklyOffOverrides: number;
  additionalStaffing: number;
  coverageImpact: RecoveryImpact[];
  hardConstraintsSatisfied: boolean;
  valid: boolean;
  rejectionCode?: RecoveryRejectionCode;
  rejectionReason?: string;
  reasons: string[];
  score: number;
  directive?: RecoveryAssignment;
}

export interface RecoveryAnalysis {
  date: string;
  brandId: string;
  processId: ProcessId;
  proposals: RecoveryCandidate[];
  rejected: RecoveryCandidate[];
  poolSize: number;
  explanation: string;
}

const REJECTION_TEXT: Record<RecoveryRejectionCode, string> = {
  ALREADY_ASSIGNED_TARGET:
    'Already assigned to the target brand/process on this date; one employee cannot fill two seats.',
  ALREADY_ASSIGNED_OTHER_BRAND:
    'Already assigned to another brand on this date and cannot be moved without breaking coverage.',
  NO_COMPATIBLE_PROCESS_ALLOCATION:
    'No compatible process allocation for the target process.',
  ON_LEAVE_OR_COMP_OFF: 'On approved leave or comp-off on this date.',
  REASSIGNMENT_CAUSES_UNDERSTAFFING:
    'Reassignment would cause understaffing elsewhere (cascading coverage failure).',
  TARGET_NOT_COVERED: 'The move would not actually cover the target slot.',
  OUTSIDE_PERMITTED_POOL: 'Outside the permitted same-brand / same-pod / cross-brand pool.',
  NO_ELIGIBLE_EMPLOYEE: 'No eligible employee exists in the permitted pool.',
};

function processName(processId: ProcessId): string {
  return PROCESSES.find((p) => p.id === processId)?.label ?? processId;
}

function brandName(data: RosterData, brandId: string): string {
  return data.brands.find((b) => b.id === brandId)?.name ?? brandId;
}

function empName(data: RosterData, employeeId: string): string {
  return data.employees.find((e) => e.id === employeeId)?.name ?? employeeId;
}

/** Compute coverage for one date from any candidate roster entry list. */
export function computeDayCoverage(
  data: RosterData,
  entries: RosterEntry[],
  date: string,
): DayCoverage[] {
  const dayEntries = entries.filter((e) => e.date === date);
  const coverage: DayCoverage[] = [];
  for (const brand of data.brands) {
    for (const bp of brand.processes) {
      if (!isOperatingDay(bp.rule, date, data.holidays)) {
        coverage.push({
          date,
          brandId: brand.id,
          processId: bp.processId,
          operating: false,
          required: bp.minStaff,
          scheduled: [],
          overriddenOff: [],
          status: 'not-operating',
        });
        continue;
      }
      const matching = dayEntries.filter(
        (e) => e.brandId === brand.id && e.processes.includes(bp.processId),
      );
      const scheduled = matching.map((e) => e.employeeId);
      const status: DayCoverage['status'] =
        scheduled.length >= bp.minStaff
          ? 'covered'
          : scheduled.length === 0
            ? 'gap'
            : 'understaffed';
      coverage.push({
        date,
        brandId: brand.id,
        processId: bp.processId,
        operating: true,
        required: bp.minStaff,
        scheduled,
        overriddenOff: matching.filter((e) => e.overriddenOff).map((e) => e.employeeId),
        status,
      });
    }
  }
  return coverage;
}

/** Apply one recovery instruction to a roster entry list (pure, no mutation). */
export function simulateRecovery(
  data: RosterData,
  entries: RosterEntry[],
  directive: RecoveryAssignment,
): RosterEntry[] {
  const brand = data.brands.find((b) => b.id === directive.brandId);
  if (!brand) return entries.map((e) => ({ ...e, processes: [...e.processes] }));

  const next: RosterEntry[] = entries
    .filter((e) => !(e.employeeId === directive.employeeId && e.date === directive.date))
    .map((e) => ({ ...e, processes: [...e.processes] }));

  const emp = data.employees.find((e) => e.id === directive.employeeId);
  if (!emp || isHardUnavailable(emp, directive.date)) return next;

  next.push({
    date: directive.date,
    employeeId: directive.employeeId,
    brandId: directive.brandId,
    processes: recoveryProcesses(
      data,
      directive.employeeId,
      brand,
      directive.processId,
      directive.type,
      directive.date,
    ),
    overriddenOff: isWeeklyOff(emp, directive.date),
  });
  return next;
}

function baselineCoverage(data: RosterData, result: RosterResult, date: string): DayCoverage[] {
  const existing = result.coverage.filter((c) => c.date === date);
  return existing.length > 0 ? existing : computeDayCoverage(data, result.entries, date);
}

function rejection(
  data: RosterData,
  result: RosterResult,
  date: string,
  brandId: string,
  processId: ProcessId,
  employeeId: string,
  code: RecoveryRejectionCode,
  overrides: Partial<RecoveryCandidate> = {},
): RecoveryCandidate {
  const brand = data.brands.find((b) => b.id === brandId);
  const emp = data.employees.find((e) => e.id === employeeId);
  const current = result.entries.find((e) => e.date === date && e.employeeId === employeeId);
  const currentBrand = current ? data.brands.find((b) => b.id === current.brandId) : undefined;
  return {
    employeeId,
    name: emp?.name ?? employeeId,
    currentAssignment: current && currentBrand
      ? {
          brandId: current.brandId,
          brandName: currentBrand.name,
          processes: current.processes,
          isPrimary: data.allocations.some(
            (a) => a.employeeId === employeeId && a.brandId === current.brandId && a.role === 'primary',
          ),
        }
      : null,
    targetAssignment: {
      brandId,
      brandName: brand?.name ?? brandId,
      processId,
      processName: processName(processId),
    },
    recoveryType: current ? 'cross-brand-reassignment' : 'direct-backup',
    allocationType: current ? 'temporary-reassignment' : 'temporary-backup',
    changedAssignments: current ? 2 : 1,
    primaryDisruption: 0,
    weeklyOffOverrides: emp && isWeeklyOff(emp, date) ? 1 : 0,
    additionalStaffing: 0,
    coverageImpact: [],
    hardConstraintsSatisfied: false,
    valid: false,
    rejectionCode: code,
    rejectionReason: REJECTION_TEXT[code],
    reasons: [REJECTION_TEXT[code]],
    score: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

/**
 * Evaluate every candidate that could repair one uncovered slot. Valid repairs
 * are ranked lexicographically by changed assignments, primary-resource
 * disruption, weekly-off overrides, then additional staffing needs.
 */
export function findRecoveryOptions(
  data: RosterData,
  result: RosterResult,
  date: string,
  brandId: string,
  processId: ProcessId,
  excludeEmployeeId?: string,
): RecoveryAnalysis {
  const brand = data.brands.find((b) => b.id === brandId);
  const targetBp = brand?.processes.find((p) => p.processId === processId);
  if (!brand || !targetBp) {
    return {
      date,
      brandId,
      processId,
      proposals: [],
      rejected: [],
      poolSize: 0,
      explanation: 'Target brand/process does not exist in the roster model.',
    };
  }

  const baseCoverage = baselineCoverage(data, result, date);
  const beforeByKey = new Map(baseCoverage.map((c) => [`${c.brandId}|${c.processId}`, c]));
  const sameDayEntries = result.entries.filter((e) => e.date === date);
  const assignedOtherBrand = new Set(
    sameDayEntries.filter((e) => e.brandId !== brandId).map((e) => e.employeeId),
  );
  const sameBrandPool = new Set(
    data.allocations.filter((a) => a.brandId === brandId).map((a) => a.employeeId),
  );
  const samePodPool = new Set(
    data.employees.filter((e) => e.podId === brand.podId).map((e) => e.id),
  );
  const pool = new Set([...sameBrandPool, ...samePodPool, ...assignedOtherBrand]);
  pool.delete(excludeEmployeeId ?? '');

  const proposals: RecoveryCandidate[] = [];
  const rejected: RecoveryCandidate[] = [];

  for (const employeeId of pool) {
    const emp = data.employees.find((e) => e.id === employeeId);
    if (!emp) continue;

    const targetAllocation = data.allocations.some(
      (a) => a.employeeId === employeeId && a.brandId === brandId && a.processId === processId,
    );
    const processAllocationAny = data.allocations.some(
      (a) => a.employeeId === employeeId && a.processId === processId,
    );
    const samePod = emp.podId === brand.podId;
    const currentEntries = sameDayEntries.filter((e) => e.employeeId === employeeId);
    const current = currentEntries[0];
    const currentlyTarget = current?.brandId === brandId && current.processes.includes(processId);

    if (isHardUnavailable(emp, date)) {
      rejected.push(rejection(data, result, date, brandId, processId, employeeId, 'ON_LEAVE_OR_COMP_OFF'));
      continue;
    }
    if (currentlyTarget) {
      rejected.push(rejection(data, result, date, brandId, processId, employeeId, 'ALREADY_ASSIGNED_TARGET'));
      continue;
    }
    if (!targetAllocation && !processAllocationAny) {
      rejected.push(rejection(data, result, date, brandId, processId, employeeId, 'NO_COMPATIBLE_PROCESS_ALLOCATION'));
      continue;
    }
    if (!current && !targetAllocation && !(samePod && processAllocationAny)) {
      rejected.push(rejection(data, result, date, brandId, processId, employeeId, 'OUTSIDE_PERMITTED_POOL'));
      continue;
    }
    if (current && current.brandId !== brandId && !samePod && !processAllocationAny && !targetAllocation) {
      rejected.push(rejection(data, result, date, brandId, processId, employeeId, 'OUTSIDE_PERMITTED_POOL'));
      continue;
    }

    const recoveryType: RecoveryType = current
      ? current.brandId === brandId
        ? 'same-brand-reassignment'
        : 'cross-brand-reassignment'
      : targetAllocation
        ? 'direct-backup'
        : 'same-pod-backup';

    const directive: RecoveryAssignment = {
      date,
      employeeId,
      brandId,
      processId,
      type: current ? 'temporary-reassignment' : 'temporary-backup',
      fromBrandId: current?.brandId,
      fromProcesses: current?.processes,
      id: `recovery-${date}-${employeeId}-${brandId}-${processId}`,
    };

    const simulated = simulateRecovery(data, result.entries, directive);
    const afterCoverage = computeDayCoverage(data, simulated, date);
    const afterByKey = new Map(afterCoverage.map((c) => [`${c.brandId}|${c.processId}`, c]));

    const coverageImpact: RecoveryImpact[] = [];
    let cascadingFailure: DayCoverage | null = null;
    for (const after of afterCoverage) {
      if (!after.operating) continue;
      const before = beforeByKey.get(`${after.brandId}|${after.processId}`);
      if (!before) continue;
      const changed =
        before.status !== after.status ||
        before.scheduled.length !== after.scheduled.length ||
        (after.brandId === brandId && after.processId === processId);
      if (changed) {
        coverageImpact.push({
          brandId: after.brandId,
          brandName: brandName(data, after.brandId),
          processId: after.processId,
          required: after.required,
          beforeScheduled: before.scheduled.length,
          afterScheduled: after.scheduled.length,
          beforeStatus: before.status,
          afterStatus: after.status,
        });
      }
      if (after.scheduled.length < before.scheduled.length && after.scheduled.length < after.required) {
        cascadingFailure = after;
      }
    }

    const targetAfter = afterByKey.get(`${brandId}|${processId}`);
    const targetCovered = targetAfter !== undefined && targetAfter.status === 'covered';

    if (cascadingFailure) {
      rejected.push(
        rejection(data, result, date, brandId, processId, employeeId, 'REASSIGNMENT_CAUSES_UNDERSTAFFING', {
          recoveryType,
          allocationType: directive.type,
          coverageImpact,
          reasons: [
            `Moving ${emp.name} would leave ${brandName(data, cascadingFailure.brandId)} ` +
              `${cascadingFailure.processId} at ${cascadingFailure.scheduled.length}/${cascadingFailure.required}.`,
          ],
        }),
      );
      continue;
    }
    if (!targetCovered) {
      rejected.push(
        rejection(data, result, date, brandId, processId, employeeId, 'TARGET_NOT_COVERED', {
          recoveryType,
          allocationType: directive.type,
          coverageImpact,
        }),
      );
      continue;
    }

    const currentBrand = current ? data.brands.find((b) => b.id === current.brandId) : undefined;
    const isPrimary = current
      ? data.allocations.some(
          (a) => a.employeeId === employeeId && a.brandId === current.brandId && a.role === 'primary',
        )
      : false;

    const changedAssignments = current ? (current.brandId === brandId ? 1 : 2) : 1;
    const primaryDisruption = isPrimary ? 1 : 0;
    const weeklyOffOverrides = isWeeklyOff(emp, date) ? 1 : 0;
    const additionalStaffing = targetAllocation ? 0 : 1;
    // Final tie-breaker: prefer the least-loaded safe employee so recovery does
    // not repeatedly pull the same floater into every absence.
    const currentWorkload = result.entries.filter((e) => e.employeeId === employeeId).length;
    const score =
      changedAssignments * 100_000 +
      primaryDisruption * 10_000 +
      weeklyOffOverrides * 1_000 +
      additionalStaffing * 100 +
      currentWorkload;

    const reasons = [
      recoveryType === 'direct-backup'
        ? 'Free on this date and permanently allocated to the target process.'
        : recoveryType === 'same-pod-backup'
          ? 'Free on this date; same pod and has target-process experience.'
          : `Safe to move from ${currentBrand?.name ?? current?.brandId}: no other coverage falls below minimum.`,
    ];
    if (weeklyOffOverrides > 0) reasons.push('Would work a preferred weekly off (flagged as a warning).');
    if (additionalStaffing > 0) reasons.push('Needs a date-specific temporary authorization; no permanent allocation is changed.');

    proposals.push({
      employeeId,
      name: emp.name,
      currentAssignment: current && currentBrand
        ? {
            brandId: current.brandId,
            brandName: currentBrand.name,
            processes: current.processes,
            isPrimary,
          }
        : null,
      targetAssignment: {
        brandId,
        brandName: brand.name,
        processId,
        processName: processName(processId),
      },
      recoveryType,
      allocationType: directive.type,
      changedAssignments,
      primaryDisruption,
      weeklyOffOverrides,
      additionalStaffing,
      coverageImpact,
      hardConstraintsSatisfied: true,
      valid: true,
      reasons,
      score,
      directive,
    });
  }

  proposals.sort(
    (a, b) => a.score - b.score || a.name.localeCompare(b.name) || a.employeeId.localeCompare(b.employeeId),
  );
  rejected.sort((a, b) => a.name.localeCompare(b.name));

  let explanation = '';
  if (proposals.length === 0) {
    const counts = new Map<RecoveryRejectionCode, number>();
    for (const r of rejected) {
      if (r.rejectionCode) counts.set(r.rejectionCode, (counts.get(r.rejectionCode) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([code, n]) => `${REJECTION_TEXT[code]} (${n})`);
    explanation = parts.length > 0
      ? `No safe repair was found. ${parts.join(' ')}`
      : REJECTION_TEXT.NO_ELIGIBLE_EMPLOYEE;
  }

  return {
    date,
    brandId,
    processId,
    proposals,
    rejected,
    poolSize: pool.size,
    explanation,
  };
}

export interface RecoveryValidation {
  valid: boolean;
  hardConstraintsSatisfied: boolean;
  reason: string;
  coverageImpact: RecoveryImpact[];
  newConflicts: Conflict[];
}

/**
 * Independent validation of one proposed repair. This re-runs the coverage
 * calculation and conflict validator against the patched roster; the UI uses
 * it as a final gate before the manager confirms a repair.
 */
export function validateRecoveryProposal(
  data: RosterData,
  result: RosterResult,
  proposal: RecoveryCandidate,
): RecoveryValidation {
  if (!proposal.valid || !proposal.directive) {
    return {
      valid: false,
      hardConstraintsSatisfied: false,
      reason: proposal.rejectionReason ?? 'Proposal is not a valid repair.',
      coverageImpact: proposal.coverageImpact,
      newConflicts: [],
    };
  }
  const directive = proposal.directive;
  const brand = data.brands.find((b) => b.id === directive.brandId);
  const bp = brand?.processes.find((p) => p.processId === directive.processId);
  const emp = data.employees.find((e) => e.id === directive.employeeId);

  if (!emp || !brand || !bp) {
    return {
      valid: false,
      hardConstraintsSatisfied: false,
      reason: 'Unknown employee, brand, or process.',
      coverageImpact: proposal.coverageImpact,
      newConflicts: [],
    };
  }
  if (isHardUnavailable(emp, directive.date)) {
    return {
      valid: false,
      hardConstraintsSatisfied: false,
      reason: `${emp.name} is on approved leave or comp-off on ${directive.date}.`,
      coverageImpact: proposal.coverageImpact,
      newConflicts: [],
    };
  }
  if (!isOperatingDay(bp.rule, directive.date, data.holidays)) {
    return {
      valid: false,
      hardConstraintsSatisfied: false,
      reason: `${brand.name} ${bp.processId} is not operating on ${directive.date}.`,
      coverageImpact: proposal.coverageImpact,
      newConflicts: [],
    };
  }

  const before = baselineCoverage(data, result, directive.date);
  const beforeErrors = new Set(result.conflicts.filter((c) => c.severity === 'error').map((c) => c.id));
  const simulated = simulateRecovery(data, result.entries, directive);
  const after = computeDayCoverage(data, simulated, directive.date);
  const dayConflicts = validateRoster(data, simulated, after).filter((c) => c.date === directive.date);
  const target = after.find((c) => c.brandId === directive.brandId && c.processId === directive.processId);

  const regressions = after.filter((slot) => {
    if (!slot.operating) return false;
    const prior = before.find((c) => c.brandId === slot.brandId && c.processId === slot.processId);
    return prior !== undefined && slot.scheduled.length < prior.scheduled.length && slot.scheduled.length < slot.required;
  });

  const coverageImpact: RecoveryImpact[] = [];
  for (const slot of after) {
    if (!slot.operating) continue;
    const prior = before.find((c) => c.brandId === slot.brandId && c.processId === slot.processId);
    if (!prior) continue;
    if (
      prior.status !== slot.status ||
      prior.scheduled.length !== slot.scheduled.length ||
      slot.brandId === directive.brandId
    ) {
      coverageImpact.push({
        brandId: slot.brandId,
        brandName: brandName(data, slot.brandId),
        processId: slot.processId,
        required: slot.required,
        beforeScheduled: prior.scheduled.length,
        afterScheduled: slot.scheduled.length,
        beforeStatus: prior.status,
        afterStatus: slot.status,
      });
    }
  }

  // Ignore the target slot's pre-existing gap error: the repair is meant to fix it.
  const newConflicts = dayConflicts.filter((c) => {
    if (!c.brandId || !c.processId) return true;
    if (c.brandId === directive.brandId && c.processId === directive.processId) return false;
    return !beforeErrors.has(c.id);
  });
  const newHardFailures = newConflicts.filter((c) => c.severity === 'error');
  const valid =
    target !== undefined &&
    target.status === 'covered' &&
    regressions.length === 0 &&
    newHardFailures.length === 0;

  return {
    valid,
    hardConstraintsSatisfied: valid,
    reason: valid
      ? `All hard constraints remain satisfied. ${emp.name} is cleared to cover ${brand.name} ${bp.processId} on ${directive.date}.`
      : regressions.length > 0
        ? 'The repair would create a new coverage gap elsewhere.'
        : newHardFailures.length > 0
          ? newHardFailures[0].message
          : 'The target slot would still not be covered.',
    coverageImpact,
    newConflicts,
  };
}

/** Backwards-compatible helper: just the valid candidates, best first. */
export function findSafeBackups(
  data: RosterData,
  result: RosterResult,
  date: string,
  brandId: string,
  processId: ProcessId,
  excludeEmployeeId?: string,
): RecoveryCandidate[] {
  return findRecoveryOptions(data, result, date, brandId, processId, excludeEmployeeId).proposals;
}

export function recoveryTypeLabel(type: RecoveryType): string {
  switch (type) {
    case 'direct-backup':
      return 'Direct backup';
    case 'same-pod-backup':
      return 'Same-pod backup';
    case 'same-brand-reassignment':
      return 'Same-brand reassignment';
    case 'cross-brand-reassignment':
      return 'Cross-brand reassignment';
  }
}

export function employeeName(data: RosterData, employeeId: string | undefined): string {
  return employeeId ? empName(data, employeeId) : '';
}

export function brandDisplayName(data: RosterData, brandId: string | undefined): string {
  return brandId ? brandName(data, brandId) : '';
}

export function brandById(data: RosterData, brandId: string): Brand | undefined {
  return data.brands.find((b) => b.id === brandId);
}
