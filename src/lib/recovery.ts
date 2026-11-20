// ---------------------------------------------------------------------------
// Roster Recovery Engine
//
// Find Backup used to return the first free, allocated employee. Recovery is a
// different problem: a safe repair may require moving an employee away from a
// different brand, and that move must not create a new coverage gap. This module
// evaluates each candidate against the *whole day's* roster, ranks only valid
// repairs, and keeps the repair as a date-specific instruction so permanent
// allocations are never rewritten by a temporary absence.
//
// Recovery is split into three independent stages:
//   1. evaluateRecoveryEligibility — one centralized hard-rule evaluator.
//   2. simulateRecovery + coverage comparison — operational impact and ranking.
//   3. validateRecoveryProposal — rebuilds the roster and re-checks every hard
//      rule without trusting the candidate's own `valid` flag.
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
  | 'UNKNOWN_EMPLOYEE'
  | 'UNKNOWN_TARGET'
  | 'TARGET_NOT_OPERATING'
  | 'ON_LEAVE_OR_COMP_OFF'
  | 'ALREADY_ASSIGNED_TARGET'
  | 'CANDIDATE_DOUBLE_BOOKED'
  | 'NO_COMPATIBLE_PROCESS_ALLOCATION'
  | 'NO_DESTINATION_AUTHORIZATION'
  | 'NO_CROSS_POD_AUTHORIZATION'
  | 'REASSIGNMENT_CAUSES_UNDERSTAFFING'
  | 'TARGET_NOT_COVERED'
  | 'INCOMPATIBLE_DUTY'
  | 'SIMULATION_INVALID'
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
  /** Whether the repair resolved, introduced, or merely changed a slot. */
  effect: 'resolved' | 'introduced' | 'changed';
}

/** Coverage left behind at the candidate's source brand. */
export interface RecoverySourceImpact {
  brandId: string;
  brandName: string;
  processId: ProcessId;
  required: number;
  beforeScheduled: number;
  afterScheduled: number;
  remainingSlack: number;
  remainsCovered: boolean;
  primaryOwnedByCandidate: boolean;
  candidateStillCovers: boolean;
  coveredByOtherEmployees: boolean;
}

export interface RecoveryEligibility {
  employeeId: string;
  employeeName: string;
  eligible: boolean;
  recoveryType?: RecoveryType;
  allocationType?: RecoveryAssignment['type'];
  currentAssignment: RecoveryCandidate['currentAssignment'];
  targetAuthorized: boolean;
  processAuthorized: boolean;
  destinationAuthorized: boolean;
  samePod: boolean;
  crossPodRequired: boolean;
  crossPodAuthorized: boolean;
  rejectionCode?: RecoveryRejectionCode;
  rejectionReason?: string;
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
  removedAssignments: RecoveryAssignmentChange[];
  addedAssignments: RecoveryAssignmentChange[];
  /** Total scheduled source seats lost by moving the candidate. */
  sourceCoverageLoss: number;
  /** Number of source processes whose primary ownership actually moves. */
  primaryDisruption: number;
  weeklyOffOverrides: number;
  additionalStaffing: number;
  sourceImpact: RecoverySourceImpact[];
  sourceProcessesAtMinimum: number;
  /** Existing number of dated roster entries for this employee. */
  currentWorkload: number;
  coverageImpact: RecoveryImpact[];
  hardConstraintsSatisfied: boolean;
  valid: boolean;
  rejectionCode?: RecoveryRejectionCode;
  rejectionReason?: string;
  reasons: string[];
  /** Lexicographic ordering key; lower is better. Not arithmetic weights. */
  rankingKey: number[];
  /** Human-readable explanation of the candidate's lexicographic position. */
  rankingExplanation: string;
  /** Legacy display value: final best-first index after sorting. */
  score: number;
  directive?: RecoveryAssignment;
}

export interface RecoveryAssignmentChange {
  brandId: string;
  brandName: string;
  processes: ProcessId[];
}

export interface RecoverySimulation {
  entries: RosterEntry[];
  removed: RosterEntry[];
  added: RosterEntry[];
  issues: RecoverySimulationIssue[];
  valid: boolean;
}

export type RecoverySimulationIssueCode =
  | 'INVALID_DIRECTIVE'
  | 'UNKNOWN_EMPLOYEE'
  | 'UNKNOWN_TARGET'
  | 'TARGET_NOT_OPERATING'
  | 'EMPLOYEE_UNAVAILABLE'
  | 'DUPLICATE_ASSIGNMENT'
  | 'ALREADY_ASSIGNED'
  | 'SOURCE_METADATA_MISMATCH';

export interface RecoverySimulationIssue {
  code: RecoverySimulationIssueCode;
  message: string;
}

export class RecoverySimulationError extends Error {
  readonly issues: RecoverySimulationIssue[];

  constructor(issues: RecoverySimulationIssue[]) {
    super(issues.map((issue) => issue.message).join(' '));
    this.name = 'RecoverySimulationError';
    this.issues = issues;
  }
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
  UNKNOWN_EMPLOYEE: 'Employee does not exist in the roster model.',
  UNKNOWN_TARGET: 'Target brand or process does not exist in the roster model.',
  TARGET_NOT_OPERATING: 'Target process is not operating on this date.',
  ON_LEAVE_OR_COMP_OFF: 'On approved leave or comp-off on this date.',
  ALREADY_ASSIGNED_TARGET:
    'Already assigned to the target brand/process on this date; one employee cannot fill two seats.',
  CANDIDATE_DOUBLE_BOOKED: 'Candidate already has multiple assignments on this date.',
  NO_COMPATIBLE_PROCESS_ALLOCATION: 'No allocation for the required process.',
  NO_DESTINATION_AUTHORIZATION:
    'No explicit destination brand/process authorization; process experience alone is not enough.',
  NO_CROSS_POD_AUTHORIZATION:
    'Destination is outside the employee pod and no explicit cross-pod authorization exists.',
  REASSIGNMENT_CAUSES_UNDERSTAFFING:
    'Reassignment would cause understaffing elsewhere (cascading coverage failure).',
  TARGET_NOT_COVERED: 'The move would not actually cover the target slot.',
  INCOMPATIBLE_DUTY: 'The destination processes are explicitly incompatible.',
  SIMULATION_INVALID: 'The recovery directive could not be simulated safely.',
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

function targetAllocation(
  data: RosterData,
  employeeId: string,
  brandId: string,
  processId: ProcessId,
): boolean {
  return data.allocations.some(
    (a) => a.employeeId === employeeId && a.brandId === brandId && a.processId === processId,
  );
}

function processAllocation(data: RosterData, employeeId: string, processId: ProcessId): boolean {
  return data.allocations.some(
    (a) => a.employeeId === employeeId && a.processId === processId,
  );
}

function crossPodAuthorization(
  data: RosterData,
  employeeId: string,
  brandId: string,
  processId: ProcessId,
): boolean {
  return (data.crossPodAuthorizations ?? []).some(
    (c) => c.employeeId === employeeId && c.brandId === brandId && c.processId === processId,
  );
}

function findIncompatibleDuty(
  data: RosterData,
  brandId: string,
  processes: ProcessId[],
): [ProcessId, ProcessId] | null {
  for (let i = 0; i < processes.length; i += 1) {
    for (let j = i + 1; j < processes.length; j += 1) {
      const first = processes[i];
      const second = processes[j];
      const incompatible = (data.incompatiblePairs ?? []).some((pair) => {
        const forward =
          pair.brandId1 === brandId &&
          pair.processId1 === first &&
          pair.brandId2 === brandId &&
          pair.processId2 === second;
        const reverse =
          pair.brandId1 === brandId &&
          pair.processId1 === second &&
          pair.brandId2 === brandId &&
          pair.processId2 === first;
        return forward || reverse;
      });
      if (incompatible) return [first, second];
    }
  }
  return null;
}

function primaryOwned(
  data: RosterData,
  employeeId: string,
  brandId: string,
  processId: ProcessId,
): boolean {
  return data.allocations.some(
    (a) =>
      a.employeeId === employeeId &&
      a.brandId === brandId &&
      a.processId === processId &&
      a.role === 'primary',
  );
}

function currentEntries(
  result: RosterResult,
  date: string,
  employeeId: string,
): RosterEntry[] {
  return result.entries.filter((e) => e.date === date && e.employeeId === employeeId);
}

function displayCurrentAssignment(
  data: RosterData,
  entry: RosterEntry | undefined,
): RecoveryCandidate['currentAssignment'] {
  if (!entry) return null;
  return {
    brandId: entry.brandId,
    brandName: brandName(data, entry.brandId),
    processes: entry.processes,
    isPrimary: data.allocations.some(
      (a) => a.employeeId === entry.employeeId && a.brandId === entry.brandId && a.role === 'primary',
    ),
  };
}

/**
 * Central eligibility evaluator. Every rule that decides whether an employee
 * may repair a slot lives here; candidate discovery only supplies the pool.
 */
export function evaluateRecoveryEligibility(
  data: RosterData,
  result: RosterResult,
  date: string,
  brandId: string,
  processId: ProcessId,
  employeeId: string,
  excludeEmployeeId?: string,
): RecoveryEligibility {
  const emp = data.employees.find((e) => e.id === employeeId);
  const brand = data.brands.find((b) => b.id === brandId);
  const bp = brand?.processes.find((p) => p.processId === processId);
  const base = {
    employeeId,
    employeeName: emp?.name ?? employeeId,
    targetAuthorized: false,
    processAuthorized: false,
    destinationAuthorized: false,
    samePod: false,
    crossPodRequired: false,
    crossPodAuthorized: false,
  };

  if (employeeId === excludeEmployeeId) {
    return { ...base, eligible: false, currentAssignment: null, rejectionCode: 'NO_ELIGIBLE_EMPLOYEE', rejectionReason: REJECTION_TEXT.NO_ELIGIBLE_EMPLOYEE };
  }
  if (!emp) {
    return { ...base, eligible: false, currentAssignment: null, rejectionCode: 'UNKNOWN_EMPLOYEE', rejectionReason: REJECTION_TEXT.UNKNOWN_EMPLOYEE };
  }
  if (!brand || !bp) {
    return { ...base, eligible: false, currentAssignment: null, rejectionCode: 'UNKNOWN_TARGET', rejectionReason: REJECTION_TEXT.UNKNOWN_TARGET };
  }

  const assignments = currentEntries(result, date, employeeId);
  const current = assignments[0];
  const currentAssignment = displayCurrentAssignment(data, current);
  const targetAuthorized = targetAllocation(data, employeeId, brandId, processId);
  const processAuthorized = processAllocation(data, employeeId, processId);
  const crossPodAuthorized = crossPodAuthorization(data, employeeId, brandId, processId);
  const destinationAuthorized = targetAuthorized || crossPodAuthorized;
  const samePod = emp.podId === brand.podId;
  const crossPodRequired = !samePod;
  const enriched = {
    ...base,
    currentAssignment,
    targetAuthorized,
    processAuthorized,
    destinationAuthorized,
    samePod,
    crossPodRequired,
    crossPodAuthorized,
  };

  if (!isOperatingDay(bp.rule, date, data.holidays)) {
    return { ...enriched, eligible: false, rejectionCode: 'TARGET_NOT_OPERATING', rejectionReason: REJECTION_TEXT.TARGET_NOT_OPERATING };
  }
  if (isHardUnavailable(emp, date)) {
    return { ...enriched, eligible: false, rejectionCode: 'ON_LEAVE_OR_COMP_OFF', rejectionReason: REJECTION_TEXT.ON_LEAVE_OR_COMP_OFF };
  }
  if (assignments.length > 1) {
    return { ...enriched, eligible: false, rejectionCode: 'CANDIDATE_DOUBLE_BOOKED', rejectionReason: REJECTION_TEXT.CANDIDATE_DOUBLE_BOOKED };
  }
  if (current?.brandId === brandId && current.processes.includes(processId)) {
    return { ...enriched, eligible: false, rejectionCode: 'ALREADY_ASSIGNED_TARGET', rejectionReason: REJECTION_TEXT.ALREADY_ASSIGNED_TARGET };
  }

  if (current) {
    const recoveryType =
      current.brandId === brandId ? 'same-brand-reassignment' : 'cross-brand-reassignment';
    // A move away from an existing brand needs explicit destination
    // authorization. Generic process experience never grants brand access.
    if (!destinationAuthorized) {
      return {
        ...enriched,
        eligible: false,
        recoveryType,
        allocationType: 'temporary-reassignment',
        rejectionCode: 'NO_DESTINATION_AUTHORIZATION',
        rejectionReason: REJECTION_TEXT.NO_DESTINATION_AUTHORIZATION,
      };
    }
    // Moving to a different brand outside the home pod is a separate
    // permission boundary, even when a permanent destination allocation exists.
    if (crossPodRequired && current.brandId !== brandId && !crossPodAuthorized) {
      return {
        ...enriched,
        eligible: false,
        recoveryType,
        allocationType: 'temporary-reassignment',
        rejectionCode: 'NO_CROSS_POD_AUTHORIZATION',
        rejectionReason: REJECTION_TEXT.NO_CROSS_POD_AUTHORIZATION,
      };
    }
    return {
      ...enriched,
      eligible: true,
      recoveryType,
      allocationType: 'temporary-reassignment',
    };
  }

  // Unassigned employees: direct destination authorization wins, then same-pod
  // process experience. A cross-pod move still needs the pod-boundary grant.
  if (destinationAuthorized) {
    if (crossPodRequired && !crossPodAuthorized) {
      return {
        ...enriched,
        eligible: false,
        rejectionCode: 'NO_CROSS_POD_AUTHORIZATION',
        rejectionReason: REJECTION_TEXT.NO_CROSS_POD_AUTHORIZATION,
      };
    }
    return { ...enriched, eligible: true, recoveryType: 'direct-backup', allocationType: 'temporary-backup' };
  }
  if (samePod && processAuthorized) {
    return { ...enriched, eligible: true, recoveryType: 'same-pod-backup', allocationType: 'temporary-backup' };
  }
  if (processAuthorized) {
    return {
      ...enriched,
      eligible: false,
      rejectionCode: 'NO_DESTINATION_AUTHORIZATION',
      rejectionReason: REJECTION_TEXT.NO_DESTINATION_AUTHORIZATION,
    };
  }
  return {
    ...enriched,
    eligible: false,
    rejectionCode: 'NO_COMPATIBLE_PROCESS_ALLOCATION',
    rejectionReason: REJECTION_TEXT.NO_COMPATIBLE_PROCESS_ALLOCATION,
  };
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

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/**
 * Apply one recovery instruction to a roster entry list and record exactly
 * which assignments were removed and added. Pure: the baseline is never
 * mutated. Invalid directives return structured issues instead of silently
 * producing a partial simulation.
 */
export function simulateRecoveryDetailed(
  data: RosterData,
  entries: RosterEntry[],
  directive: RecoveryAssignment,
): RecoverySimulation {
  const baseline = entries.map((e) => ({ ...e, processes: [...e.processes] }));
  const issues: RecoverySimulationIssue[] = [];
  const failed = (
    code: RecoverySimulationIssueCode,
    message: string,
  ): RecoverySimulation => ({
    entries: baseline,
    removed: [],
    added: [],
    issues: [...issues, { code, message }],
    valid: false,
  });

  if (
    !directive ||
    typeof directive !== 'object' ||
    typeof directive.date !== 'string' ||
    !isValidIsoDate(directive.date) ||
    typeof directive.employeeId !== 'string' ||
    directive.employeeId.length === 0 ||
    typeof directive.brandId !== 'string' ||
    directive.brandId.length === 0 ||
    typeof directive.processId !== 'string' ||
    directive.processId.length === 0 ||
    (directive.type !== 'temporary-backup' &&
      directive.type !== 'temporary-reassignment') ||
    (directive.fromBrandId != null && typeof directive.fromBrandId !== 'string') ||
    (directive.fromProcesses != null &&
      (!Array.isArray(directive.fromProcesses) ||
        !directive.fromProcesses.every((process) => typeof process === 'string')))
  ) {
    return failed('INVALID_DIRECTIVE', 'Recovery directive is malformed or incomplete.');
  }

  const current = baseline.filter(
    (e) => e.employeeId === directive.employeeId && e.date === directive.date,
  );
  if (current.length > 1) {
    return failed(
      'DUPLICATE_ASSIGNMENT',
      `${directive.employeeId} already has ${current.length} assignments on ${directive.date}.`,
    );
  }

  const brand = data.brands.find((b) => b.id === directive.brandId);
  const targetProcess = brand?.processes.find(
    (process) => process.processId === directive.processId,
  );
  const emp = data.employees.find((e) => e.id === directive.employeeId);
  if (!emp) {
    return failed('UNKNOWN_EMPLOYEE', `Unknown employee ${directive.employeeId}.`);
  }
  if (!brand || !targetProcess) {
    return failed(
      'UNKNOWN_TARGET',
      `Unknown destination ${directive.brandId}-${directive.processId}.`,
    );
  }
  if (!isOperatingDay(targetProcess.rule, directive.date, data.holidays)) {
    return failed(
      'TARGET_NOT_OPERATING',
      `${brand.name} ${targetProcess.processId} is not operating on ${directive.date}.`,
    );
  }
  if (isHardUnavailable(emp, directive.date)) {
    return failed(
      'EMPLOYEE_UNAVAILABLE',
      `${emp.name} is unavailable on ${directive.date}.`,
    );
  }

  const fromBrand = directive.fromBrandId;
  const fromProcesses = directive.fromProcesses;
  const hasSourceMetadata =
    fromBrand != null || (Array.isArray(fromProcesses) && fromProcesses.length > 0);

  if (directive.type === 'temporary-reassignment') {
    if (
      current.length !== 1 ||
      fromBrand !== current[0].brandId ||
      !Array.isArray(fromProcesses) ||
      !sameProcessSet(fromProcesses, current[0].processes)
    ) {
      return failed(
        'SOURCE_METADATA_MISMATCH',
        'Source metadata does not match the baseline assignment.',
      );
    }
  } else {
    if (current.length > 0) {
      return failed(
        'ALREADY_ASSIGNED',
        'A temporary backup cannot be added for an employee who is already assigned.',
      );
    }
    if (hasSourceMetadata) {
      return failed(
        'SOURCE_METADATA_MISMATCH',
        'A temporary backup must not claim a source assignment.',
      );
    }
  }

  const removed =
    directive.type === 'temporary-reassignment'
      ? current.map((e) => ({ ...e, processes: [...e.processes] }))
      : [];
  let next =
    directive.type === 'temporary-reassignment'
      ? baseline.filter(
          (e) => !(e.employeeId === directive.employeeId && e.date === directive.date),
        )
      : baseline;

  const added: RosterEntry = {
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
  };
  next = [...next, added];
  return { entries: next, removed, added: [added], issues: [], valid: true };
}

/** Backwards-compatible helper returning only the simulated entries. */
export function simulateRecovery(
  data: RosterData,
  entries: RosterEntry[],
  directive: RecoveryAssignment,
): RosterEntry[] {
  const simulation = simulateRecoveryDetailed(data, entries, directive);
  if (!simulation.valid) throw new RecoverySimulationError(simulation.issues);
  return simulation.entries;
}

function baselineCoverage(data: RosterData, result: RosterResult, date: string): DayCoverage[] {
  // Always derive baseline from the supplied entries. This keeps discovery,
  // simulation and validation consistent even when a caller supplies a patched
  // entry list (and mirrors the Python implementation).
  return computeDayCoverage(data, result.entries, date);
}

function coverageByKey(coverage: DayCoverage[]): Map<string, DayCoverage> {
  return new Map(coverage.map((c) => [`${c.brandId}|${c.processId}`, c]));
}

function rejection(
  data: RosterData,
  date: string,
  brandId: string,
  processId: ProcessId,
  employeeId: string,
  eligibility: RecoveryEligibility,
  overrides: Partial<RecoveryCandidate> = {},
): RecoveryCandidate {
  const brand = data.brands.find((b) => b.id === brandId);
  const emp = data.employees.find((e) => e.id === employeeId);
  const code = eligibility.rejectionCode ?? 'NO_ELIGIBLE_EMPLOYEE';
  return {
    employeeId,
    name: emp?.name ?? employeeId,
    currentAssignment: eligibility.currentAssignment,
    targetAssignment: {
      brandId,
      brandName: brand?.name ?? brandId,
      processId,
      processName: processName(processId),
    },
    recoveryType: eligibility.recoveryType ?? (eligibility.currentAssignment ? 'cross-brand-reassignment' : 'direct-backup'),
    allocationType: eligibility.allocationType ?? (eligibility.currentAssignment ? 'temporary-reassignment' : 'temporary-backup'),
    changedAssignments: eligibility.currentAssignment ? 2 : 1,
    removedAssignments: [],
    addedAssignments: [],
    sourceCoverageLoss: 0,
    primaryDisruption: 0,
    weeklyOffOverrides: emp && isWeeklyOff(emp, date) ? 1 : 0,
    additionalStaffing: 0,
    sourceImpact: [],
    sourceProcessesAtMinimum: 0,
    currentWorkload: 0,
    coverageImpact: [],
    hardConstraintsSatisfied: false,
    valid: false,
    rejectionCode: code,
    rejectionReason: eligibility.rejectionReason ?? REJECTION_TEXT[code],
    reasons: [eligibility.rejectionReason ?? REJECTION_TEXT[code]],
    rankingKey: [],
    rankingExplanation: eligibility.rejectionReason ?? REJECTION_TEXT[code],
    score: Number.MAX_SAFE_INTEGER,
    ...overrides,
  };
}

function compareRanking(a: RecoveryCandidate, b: RecoveryCandidate): number {
  for (let i = 0; i < Math.max(a.rankingKey.length, b.rankingKey.length); i++) {
    const av = a.rankingKey[i] ?? Number.MAX_SAFE_INTEGER;
    const bv = b.rankingKey[i] ?? Number.MAX_SAFE_INTEGER;
    if (av !== bv) return av - bv;
  }
  // Stable final tie-breaker. Discovery order must never affect the result.
  return a.employeeId.localeCompare(b.employeeId);
}

/**
 * Evaluate every candidate that could repair one uncovered slot.
 *
 * Ranking is lexicographic, not weighted:
 *   1. fewer changed assignments
 *   2. lower actual source coverage loss (scheduled seats lost)
 *   3. fewer source processes left exactly at minimum staffing
 *   4. fewer primary-owned source processes actually displaced
 *   5. fewer weekly-off overrides
 *   6. less additional temporary staffing needed
 *   7. lower existing workload
 *   8. deterministic employee-id tie-break
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
  const beforeByKey = coverageByKey(baseCoverage);
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
  const crossPodPool = new Set(
    (data.crossPodAuthorizations ?? [])
      .filter((c) => c.brandId === brandId && c.processId === processId)
      .map((c) => c.employeeId),
  );
  const pool = new Set([...sameBrandPool, ...samePodPool, ...assignedOtherBrand, ...crossPodPool]);
  if (excludeEmployeeId) pool.delete(excludeEmployeeId);

  const proposals: RecoveryCandidate[] = [];
  const rejected: RecoveryCandidate[] = [];

  for (const employeeId of pool) {
    const emp = data.employees.find((e) => e.id === employeeId);
    if (!emp) continue;

    const eligibility = evaluateRecoveryEligibility(
      data,
      result,
      date,
      brandId,
      processId,
      employeeId,
      excludeEmployeeId,
    );
    if (!eligibility.eligible) {
      rejected.push(rejection(data, date, brandId, processId, employeeId, eligibility));
      continue;
    }

    const current = currentEntries(result, date, employeeId)[0];
    const directive: RecoveryAssignment = {
      date,
      employeeId,
      brandId,
      processId,
      type: eligibility.allocationType!,
      fromBrandId: current?.brandId,
      fromProcesses: current?.processes,
      id: `recovery-${date}-${employeeId}-${brandId}-${processId}`,
    };

    const simulation = simulateRecoveryDetailed(data, result.entries, directive);
    if (!simulation.valid) {
      rejected.push(
        rejection(
          data,
          date,
          brandId,
          processId,
          employeeId,
          {
            ...eligibility,
            eligible: false,
            rejectionCode: 'SIMULATION_INVALID',
            rejectionReason: simulation.issues.map((issue) => issue.message).join(' '),
          },
          { reasons: simulation.issues.map((issue) => issue.message) },
        ),
      );
      continue;
    }
    const simulated = simulation.entries;
    const afterCoverage = computeDayCoverage(data, simulated, date);
    const afterByKey = coverageByKey(afterCoverage);

    const coverageImpact: RecoveryImpact[] = [];
    let cascadingFailure: DayCoverage | null = null;
    for (const after of afterCoverage) {
      if (!after.operating) continue;
      const before = beforeByKey.get(`${after.brandId}|${after.processId}`);
      if (!before) continue;
      if (
        before.status !== after.status ||
        before.scheduled.length !== after.scheduled.length ||
        (after.brandId === brandId && after.processId === processId)
      ) {
        const effect: RecoveryImpact['effect'] =
          before.status !== 'covered' && after.status === 'covered'
            ? 'resolved'
            : after.status !== 'covered' &&
                (before.status === 'covered' || after.scheduled.length < before.scheduled.length)
              ? 'introduced'
              : 'changed';
        coverageImpact.push({
          brandId: after.brandId,
          brandName: brandName(data, after.brandId),
          processId: after.processId,
          required: after.required,
          beforeScheduled: before.scheduled.length,
          afterScheduled: after.scheduled.length,
          beforeStatus: before.status,
          afterStatus: after.status,
          effect,
        });
      }
      if (after.scheduled.length < before.scheduled.length && after.scheduled.length < after.required) {
        cascadingFailure = after;
      }
    }

    const targetAfter = afterByKey.get(`${brandId}|${processId}`);
    const targetCovered = targetAfter !== undefined && targetAfter.status === 'covered';
    const destinationEntry = simulation.added[0];
    const incompatibleDuty = destinationEntry
      ? findIncompatibleDuty(data, destinationEntry.brandId, destinationEntry.processes)
      : null;

    if (cascadingFailure) {
      rejected.push(
        rejection(data, date, brandId, processId, employeeId, { ...eligibility, eligible: false, rejectionCode: 'REASSIGNMENT_CAUSES_UNDERSTAFFING', rejectionReason: REJECTION_TEXT.REASSIGNMENT_CAUSES_UNDERSTAFFING }, {
          recoveryType: eligibility.recoveryType,
          allocationType: eligibility.allocationType,
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
        rejection(data, date, brandId, processId, employeeId, { ...eligibility, eligible: false, rejectionCode: 'TARGET_NOT_COVERED', rejectionReason: REJECTION_TEXT.TARGET_NOT_COVERED }, {
          recoveryType: eligibility.recoveryType,
          allocationType: eligibility.allocationType,
          coverageImpact,
        }),
      );
      continue;
    }
    if (incompatibleDuty) {
      rejected.push(
        rejection(data, date, brandId, processId, employeeId, { ...eligibility, eligible: false, rejectionCode: 'INCOMPATIBLE_DUTY', rejectionReason: REJECTION_TEXT.INCOMPATIBLE_DUTY }, {
          recoveryType: eligibility.recoveryType,
          allocationType: eligibility.allocationType,
          coverageImpact,
          reasons: [
            `Cannot cover both ${destinationEntry?.brandId}-${incompatibleDuty[0]} and ` +
              `${destinationEntry?.brandId}-${incompatibleDuty[1]} on the same day.`,
          ],
        }),
      );
      continue;
    }

    const currentBrand = current ? data.brands.find((b) => b.id === current.brandId) : undefined;
    const afterEntry = simulated.find(
      (e) => e.date === date && e.employeeId === employeeId && e.brandId === brandId,
    );
    const sourceImpact: RecoverySourceImpact[] = [];
    if (current && currentBrand) {
      for (const p of current.processes) {
        const beforeSlot = beforeByKey.get(`${current.brandId}|${p}`);
        const afterSlot = afterByKey.get(`${current.brandId}|${p}`);
        if (!beforeSlot || !afterSlot || !beforeSlot.operating) continue;
        const stillCovers = afterEntry?.processes.includes(p) ?? false;
        sourceImpact.push({
          brandId: current.brandId,
          brandName: currentBrand.name,
          processId: p,
          required: afterSlot.required,
          beforeScheduled: beforeSlot.scheduled.length,
          afterScheduled: afterSlot.scheduled.length,
          remainingSlack: afterSlot.scheduled.length - afterSlot.required,
          remainsCovered: afterSlot.status === 'covered',
          primaryOwnedByCandidate: primaryOwned(data, employeeId, current.brandId, p),
          candidateStillCovers: stillCovers,
          coveredByOtherEmployees: afterSlot.scheduled.some((id) => id !== employeeId),
        });
      }
    }

    const lostSourceProcesses = sourceImpact.filter((s) => !s.candidateStillCovers);
    const primaryDisruption = lostSourceProcesses.filter((s) => s.primaryOwnedByCandidate).length;
    const sourceProcessesAtMinimum = lostSourceProcesses.filter(
      (s) => s.afterScheduled === s.required,
    ).length;
    const sourceCoverageLoss = lostSourceProcesses.reduce(
      (total, s) => total + Math.max(0, s.beforeScheduled - s.afterScheduled),
      0,
    );
    const changedAssignments = simulation.removed.length + simulation.added.length;
    const removedAssignments: RecoveryAssignmentChange[] = simulation.removed.map((e) => ({
      brandId: e.brandId,
      brandName: brandName(data, e.brandId),
      processes: e.processes,
    }));
    const addedAssignments: RecoveryAssignmentChange[] = simulation.added.map((e) => ({
      brandId: e.brandId,
      brandName: brandName(data, e.brandId),
      processes: e.processes,
    }));
    const weeklyOffOverrides = isWeeklyOff(emp, date) ? 1 : 0;
    const additionalStaffing =
      eligibility.recoveryType === 'same-pod-backup' ||
      (eligibility.allocationType === 'temporary-reassignment' && !eligibility.destinationAuthorized)
        ? 1
        : 0;
    const currentWorkload = result.entries.filter((e) => e.employeeId === employeeId).length;
    const rankingKey = [
      changedAssignments,
      sourceCoverageLoss,
      sourceProcessesAtMinimum,
      primaryDisruption,
      weeklyOffOverrides,
      additionalStaffing,
      currentWorkload,
    ];

    const reasons = [
      eligibility.recoveryType === 'direct-backup'
        ? 'Free on this date and explicitly allocated to the destination brand/process.'
        : eligibility.recoveryType === 'same-pod-backup'
          ? 'Free on this date; same pod and allocated to the required process.'
          : `Safe to move from ${currentBrand?.name ?? current?.brandId}: all source processes remain above minimum.`,
    ];
    if (primaryDisruption > 0) {
      reasons.push(`Primary ownership changes for ${primaryDisruption} source process(es), with cover maintained by another assigned employee.`);
    }
    if (weeklyOffOverrides > 0) reasons.push('Would work a preferred weekly off (flagged as a warning).');
    if (additionalStaffing > 0) reasons.push('Needs a date-specific temporary authorization; no permanent allocation is changed.');

    proposals.push({
      employeeId,
      name: emp.name,
      currentAssignment: eligibility.currentAssignment,
      targetAssignment: {
        brandId,
        brandName: brand.name,
        processId,
        processName: processName(processId),
      },
      recoveryType: eligibility.recoveryType!,
      allocationType: eligibility.allocationType!,
      changedAssignments,
      removedAssignments,
      addedAssignments,
      sourceCoverageLoss,
      primaryDisruption,
      weeklyOffOverrides,
      additionalStaffing,
      sourceImpact,
      sourceProcessesAtMinimum,
      currentWorkload,
      coverageImpact,
      hardConstraintsSatisfied: true,
      valid: true,
      reasons,
      rankingKey,
      rankingExplanation: '',
      score: 0,
      directive,
    });
  }

  proposals.sort(compareRanking);
  proposals.forEach((p, index) => {
    // Legacy field retained for UI/API compatibility. Ordering is rankingKey.
    p.score = index;
    p.rankingExplanation =
      `Rank ${index + 1} (key ${p.rankingKey.join('/')}): ${p.changedAssignments} assignment change(s), ` +
      `${p.sourceCoverageLoss} source seat(s) lost, ` +
      `${p.sourceProcessesAtMinimum} source process(es) at minimum, ` +
      `${p.primaryDisruption} primary disruption(s), ` +
      `${p.weeklyOffOverrides} weekly-off override(s), ` +
      `${p.additionalStaffing} extra staffing, workload ${p.currentWorkload}.`;
  });
  rejected.sort((a, b) => a.name.localeCompare(b.name) || a.employeeId.localeCompare(b.employeeId));

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

export type RecoveryValidationFailureCode =
  | 'NO_DIRECTIVE'
  | 'UNKNOWN_EMPLOYEE'
  | 'UNKNOWN_TARGET'
  | 'TARGET_NOT_OPERATING'
  | 'ON_LEAVE_OR_COMP_OFF'
  | 'NOT_ELIGIBLE'
  | 'ALLOCATION_TYPE_MISMATCH'
  | 'MALFORMED_DIRECTIVE'
  | 'SOURCE_METADATA_MISMATCH'
  | 'DOUBLE_BOOKED'
  | 'DESTINATION_ASSIGNMENT_MISSING'
  | 'INCOMPATIBLE_DUTY'
  | 'UNRELATED_ENTRY_CHANGED'
  | 'TARGET_UNDERSTAFFED'
  | 'SOURCE_UNDERSTAFFED'
  | 'PERMANENT_ALLOCATION_MUTATED'
  | 'NEW_HARD_CONSTRAINT';

export interface RecoveryValidationFailure {
  code: RecoveryValidationFailureCode;
  message: string;
  brandId?: string;
  processId?: ProcessId;
  employeeId?: string;
}

export interface RecoveryValidation {
  valid: boolean;
  hardConstraintsSatisfied: boolean;
  reason: string;
  failures: RecoveryValidationFailure[];
  coverageImpact: RecoveryImpact[];
  newConflicts: Conflict[];
}

function conflictKey(c: Conflict): string {
  return [c.type, c.date, c.brandId ?? '', c.processId ?? '', c.employeeId ?? ''].join('|');
}

const RECOVERY_TYPES: RecoveryAssignment['type'][] = [
  'temporary-backup',
  'temporary-reassignment',
];

function sameProcessSet(a: readonly ProcessId[], b: readonly ProcessId[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort().join('|');
  const right = [...b].sort().join('|');
  return left === right;
}

function entrySignature(entry: RosterEntry): string {
  return [
    entry.date,
    entry.employeeId,
    entry.brandId,
    [...entry.processes].sort().join(','),
    entry.overriddenOff ? 'override' : 'normal',
  ].join('|');
}

function simulationFailureCode(
  code: RecoverySimulationIssueCode,
): RecoveryValidationFailureCode {
  switch (code) {
    case 'INVALID_DIRECTIVE':
      return 'MALFORMED_DIRECTIVE';
    case 'UNKNOWN_EMPLOYEE':
      return 'UNKNOWN_EMPLOYEE';
    case 'UNKNOWN_TARGET':
      return 'UNKNOWN_TARGET';
    case 'TARGET_NOT_OPERATING':
      return 'TARGET_NOT_OPERATING';
    case 'EMPLOYEE_UNAVAILABLE':
      return 'ON_LEAVE_OR_COMP_OFF';
    case 'DUPLICATE_ASSIGNMENT':
    case 'ALREADY_ASSIGNED':
      return 'DOUBLE_BOOKED';
    case 'SOURCE_METADATA_MISMATCH':
      return 'SOURCE_METADATA_MISMATCH';
  }
}

function impactEffect(
  before: DayCoverage,
  after: DayCoverage,
): RecoveryImpact['effect'] {
  if (before.status !== 'covered' && after.status === 'covered') return 'resolved';
  if (
    after.status !== 'covered' &&
    (before.status === 'covered' || after.scheduled.length < before.scheduled.length)
  ) {
    return 'introduced';
  }
  return 'changed';
}

/**
 * Independently reconstruct and validate one proposed repair. The candidate's
 * `valid`, `hardConstraintsSatisfied`, `score` and `reasons` fields are
 * deliberately ignored; only the directive and the baseline roster are trusted.
 */
export function validateRecoveryProposal(
  data: RosterData,
  result: RosterResult,
  proposal: RecoveryCandidate,
): RecoveryValidation {
  const directive = proposal.directive;
  const fail = (
    code: RecoveryValidationFailureCode,
    message: string,
    extra: Partial<RecoveryValidationFailure> = {},
  ): RecoveryValidation => ({
    valid: false,
    hardConstraintsSatisfied: false,
    reason: message,
    failures: [{ code, message, ...extra }],
    coverageImpact: proposal.coverageImpact ?? [],
    newConflicts: [],
  });

  if (!directive) return fail('NO_DIRECTIVE', 'Proposal has no date-specific recovery directive.');
  if (
    typeof directive !== 'object' ||
    typeof directive.date !== 'string' ||
    !isValidIsoDate(directive.date) ||
    typeof directive.employeeId !== 'string' ||
    directive.employeeId.length === 0 ||
    typeof directive.brandId !== 'string' ||
    directive.brandId.length === 0 ||
    typeof directive.processId !== 'string' ||
    directive.processId.length === 0 ||
    !RECOVERY_TYPES.includes(directive.type) ||
    (directive.fromBrandId != null && typeof directive.fromBrandId !== 'string') ||
    (directive.fromProcesses != null &&
      (!Array.isArray(directive.fromProcesses) ||
        !directive.fromProcesses.every((process) => typeof process === 'string')))
  ) {
    return fail('MALFORMED_DIRECTIVE', 'Recovery directive is malformed or incomplete.');
  }
  if (
    proposal.employeeId !== directive.employeeId ||
    proposal.allocationType !== directive.type ||
    proposal.targetAssignment?.brandId !== directive.brandId ||
    proposal.targetAssignment?.processId !== directive.processId
  ) {
    return fail(
      'MALFORMED_DIRECTIVE',
      'Candidate metadata does not match the recovery directive.',
      { employeeId: directive.employeeId },
    );
  }

  const emp = data.employees.find((e) => e.id === directive.employeeId);
  const brand = data.brands.find((b) => b.id === directive.brandId);
  const bp = brand?.processes.find((p) => p.processId === directive.processId);
  if (!emp) return fail('UNKNOWN_EMPLOYEE', 'Unknown employee.', { employeeId: directive.employeeId });
  if (!brand || !bp) {
    return fail('UNKNOWN_TARGET', 'Unknown destination brand or process.', {
      brandId: directive.brandId,
      processId: directive.processId,
    });
  }
  if (!isOperatingDay(bp.rule, directive.date, data.holidays)) {
    return fail('TARGET_NOT_OPERATING', `${brand.name} ${bp.processId} is not operating on ${directive.date}.`, {
      brandId: brand.id,
      processId: bp.processId,
    });
  }
  if (isHardUnavailable(emp, directive.date)) {
    return fail('ON_LEAVE_OR_COMP_OFF', `${emp.name} is on approved leave or comp-off on ${directive.date}.`, {
      employeeId: emp.id,
    });
  }

  const baselineCurrent = currentEntries(result, directive.date, directive.employeeId);
  if (baselineCurrent.length > 1) {
    return fail(
      'DOUBLE_BOOKED',
      `${emp.name} already has ${baselineCurrent.length} assignments on ${directive.date}.`,
      { employeeId: emp.id },
    );
  }
  if (directive.type === 'temporary-reassignment') {
    const current = baselineCurrent[0];
    if (
      baselineCurrent.length !== 1 ||
      !current ||
      directive.fromBrandId !== current.brandId ||
      !Array.isArray(directive.fromProcesses) ||
      !sameProcessSet(directive.fromProcesses, current.processes)
    ) {
      return fail(
        'SOURCE_METADATA_MISMATCH',
        'Directive source metadata does not match the baseline assignment.',
        { employeeId: emp.id },
      );
    }
  } else if (
    directive.fromBrandId != null ||
    (Array.isArray(directive.fromProcesses) && directive.fromProcesses.length > 0)
  ) {
    return fail(
      'SOURCE_METADATA_MISMATCH',
      'A temporary backup must not claim a source assignment.',
      { employeeId: emp.id },
    );
  }

  const eligibility = evaluateRecoveryEligibility(
    data,
    result,
    directive.date,
    directive.brandId,
    directive.processId,
    directive.employeeId,
  );
  if (!eligibility.eligible) {
    return fail('NOT_ELIGIBLE', eligibility.rejectionReason ?? 'Candidate is not eligible.', {
      employeeId: emp.id,
      brandId: brand.id,
      processId: bp.processId,
    });
  }
  if (eligibility.allocationType !== directive.type) {
    return fail(
      'ALLOCATION_TYPE_MISMATCH',
      `Directive is ${directive.type}, but the employee must use ${eligibility.allocationType}.`,
      { employeeId: emp.id, brandId: brand.id, processId: bp.processId },
    );
  }

  const allocationsBefore = JSON.stringify(data.allocations);
  const beforeCoverage = baselineCoverage(data, result, directive.date);
  const beforeByKey = coverageByKey(beforeCoverage);
  const beforeHardKeys = new Set(
    validateRoster(data, result.entries, beforeCoverage)
      .filter((c) => c.severity === 'error')
      .map(conflictKey),
  );
  const simulation = simulateRecoveryDetailed(data, result.entries, directive);
  const simulated = simulation.entries;
  const allocationsAfter = JSON.stringify(data.allocations);
  const afterCoverage = computeDayCoverage(data, simulated, directive.date);
  const afterByKey = coverageByKey(afterCoverage);

  const failures: RecoveryValidationFailure[] = [];
  for (const issue of simulation.issues) {
    failures.push({
      code: simulationFailureCode(issue.code),
      message: issue.message,
      employeeId: emp.id,
      brandId: brand.id,
      processId: bp.processId,
    });
  }
  if (allocationsBefore !== allocationsAfter) {
    failures.push({
      code: 'PERMANENT_ALLOCATION_MUTATED',
      message: 'Recovery simulation changed a permanent allocation.',
      employeeId: emp.id,
    });
  }

  // The simulation must change exactly the candidate's baseline assignment(s)
  // and add exactly the requested destination assignment.
  if (directive.type === 'temporary-reassignment') {
    const removedMatches =
      simulation.removed.length === baselineCurrent.length &&
      simulation.removed.every((entry) =>
        baselineCurrent.some((baseline) => entrySignature(entry) === entrySignature(baseline)),
      );
    if (!removedMatches) {
      failures.push({
        code: 'SOURCE_METADATA_MISMATCH',
        message: 'Simulation did not remove exactly the baseline source assignment(s).',
        employeeId: emp.id,
      });
    }
  } else if (simulation.removed.length > 0) {
    failures.push({
      code: 'SOURCE_METADATA_MISMATCH',
      message: 'A temporary backup must not remove an existing assignment.',
      employeeId: emp.id,
    });
  }

  const added = simulation.added;
  if (
    added.length !== 1 ||
    added[0].brandId !== directive.brandId ||
    !added[0].processes.includes(directive.processId)
  ) {
    failures.push({
      code: 'DESTINATION_ASSIGNMENT_MISSING',
      message: 'Simulation did not create the requested destination assignment.',
      employeeId: emp.id,
      brandId: brand.id,
      processId: bp.processId,
    });
  }

  const candidateEntries = simulated.filter(
    (e) => e.date === directive.date && e.employeeId === directive.employeeId,
  );
  const candidateBrands = new Set(candidateEntries.map((e) => e.brandId));
  if (candidateEntries.length !== 1 || candidateBrands.size !== 1) {
    failures.push({
      code: 'DOUBLE_BOOKED',
      message: `${emp.name} would have ${candidateEntries.length} assignment(s) across ${candidateBrands.size} brand(s) on ${directive.date}.`,
      employeeId: emp.id,
    });
  }
  const destinationEntry = candidateEntries[0];
  if (
    !destinationEntry ||
    destinationEntry.brandId !== directive.brandId ||
    !destinationEntry.processes.includes(directive.processId)
  ) {
    failures.push({
      code: 'DESTINATION_ASSIGNMENT_MISSING',
      message: `${emp.name} is not assigned to ${brand.name} ${bp.processId} after the repair.`,
      employeeId: emp.id,
      brandId: brand.id,
      processId: bp.processId,
    });
  }
  const incompatibleDuty = destinationEntry
    ? findIncompatibleDuty(data, destinationEntry.brandId, destinationEntry.processes)
    : null;
  if (destinationEntry && incompatibleDuty) {
    failures.push({
      code: 'INCOMPATIBLE_DUTY',
      message:
        `${emp.name} cannot cover both ${destinationEntry.brandId}-${incompatibleDuty[0]} and ` +
        `${destinationEntry.brandId}-${incompatibleDuty[1]} on ${directive.date}.`,
      employeeId: emp.id,
      brandId: destinationEntry.brandId,
      processId: incompatibleDuty[1],
    });
  }

  // Only the candidate's date-specific assignments may change. This catches
  // accidental mutation of unrelated roster entries by future simulation code.
  const untouchedBaseline = result.entries
    .filter((e) => !(e.date === directive.date && e.employeeId === directive.employeeId))
    .map(entrySignature)
    .sort();
  const untouchedAfter = simulated
    .filter((e) => !(e.date === directive.date && e.employeeId === directive.employeeId))
    .map(entrySignature)
    .sort();
  if (JSON.stringify(untouchedBaseline) !== JSON.stringify(untouchedAfter)) {
    failures.push({
      code: 'UNRELATED_ENTRY_CHANGED',
      message: 'Recovery simulation changed an unrelated roster entry.',
      employeeId: emp.id,
    });
  }

  const target = afterByKey.get(`${directive.brandId}|${directive.processId}`);
  if (!target || target.status !== 'covered') {
    failures.push({
      code: 'TARGET_UNDERSTAFFED',
      message: `${brand.name} ${bp.processId} would still be ${target?.status ?? 'not covered'} after the repair.`,
      brandId: brand.id,
      processId: bp.processId,
    });
  }

  const sourceRegressions = afterCoverage.filter((slot) => {
    if (!slot.operating) return false;
    const prior = beforeByKey.get(`${slot.brandId}|${slot.processId}`);
    return (
      prior !== undefined &&
      slot.scheduled.length < prior.scheduled.length &&
      slot.scheduled.length < slot.required
    );
  });
  for (const slot of sourceRegressions) {
    failures.push({
      code: 'SOURCE_UNDERSTAFFED',
      message: `${brandName(data, slot.brandId)} ${slot.processId} would fall to ${slot.scheduled.length}/${slot.required}.`,
      brandId: slot.brandId,
      processId: slot.processId,
    });
  }

  // Re-run the independent conflict validator and only flag hard errors that
  // are genuinely new. A date-specific destination authorization is the
  // directive itself; pre-existing unrelated gaps must not invalidate a repair.
  const afterHard = validateRoster(data, simulated, afterCoverage).filter(
    (c) => c.severity === 'error' && c.date === directive.date,
  );
  const newConflicts = afterHard.filter((c) => {
    const isCandidateDestination =
      c.brandId === directive.brandId &&
      c.processId === directive.processId &&
      c.employeeId === directive.employeeId;
    return !isCandidateDestination && !beforeHardKeys.has(conflictKey(c));
  });
  for (const conflict of newConflicts) {
    failures.push({
      code: 'NEW_HARD_CONSTRAINT',
      message: conflict.message,
      brandId: conflict.brandId,
      processId: conflict.processId,
      employeeId: conflict.employeeId,
    });
  }

  const coverageImpact: RecoveryImpact[] = [];
  for (const slot of afterCoverage) {
    if (!slot.operating) continue;
    const prior = beforeByKey.get(`${slot.brandId}|${slot.processId}`);
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
        effect: impactEffect(prior, slot),
      });
    }
  }

  const valid = failures.length === 0;
  return {
    valid,
    hardConstraintsSatisfied: valid,
    reason: valid
      ? `All hard constraints remain satisfied. ${emp.name} is cleared to cover ${brand.name} ${bp.processId} on ${directive.date}.`
      : failures.map((f) => f.message).join(' '),
    failures,
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
