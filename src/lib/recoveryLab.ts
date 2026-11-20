// ---------------------------------------------------------------------------
// Recovery Lab integration layer.
//
// The recovery engine is a set of pure functions. This module runs those same
// functions in their real order and packages their genuine outputs into a
// timeline the UI can replay. It intentionally does not reimplement eligibility,
// simulation, ranking or validation rules: every decision shown by the Lab is
// read back from `findRecoveryOptions`, `evaluateRecoveryEligibility`,
// `simulateRecoveryDetailed` and `validateRecoveryProposal`.
// ---------------------------------------------------------------------------

import {
  PROCESSES,
  type Employee,
  type ProcessId,
} from '../data/seed';
import {
  generateRoster,
  type DayCoverage,
  type RosterData,
  type RosterResult,
} from './engine';
import {
  computeDayCoverage,
  evaluateRecoveryEligibility,
  findRecoveryOptions,
  simulateRecoveryDetailed,
  validateRecoveryProposal,
  type RecoveryAnalysis,
  type RecoveryCandidate,
  type RecoveryEligibility,
  type RecoveryRejectionCode,
  type RecoverySimulation,
  type RecoveryValidation,
} from './recovery';

export type RecoveryLabStageId =
  | 'detect'
  | 'discover'
  | 'availability'
  | 'authorization'
  | 'pod-restrictions'
  | 'eligibility'
  | 'simulate'
  | 'source-impact'
  | 'rank'
  | 'validate';

export type RecoveryLabStageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'failed';

export interface RecoveryLabStage {
  id: RecoveryLabStageId;
  title: string;
  description: string;
  status: RecoveryLabStageStatus;
  summary: string;
  metrics: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' | 'muted' }[];
}

export interface RecoveryCandidateEvaluation {
  employeeId: string;
  name: string;
  eligibility: RecoveryEligibility;
  final?: RecoveryCandidate;
  outcome: 'selected' | 'valid' | 'rejected';
  rejectionCode?: RecoveryRejectionCode;
  rejectionReason?: string;
}

export interface RecoveryShortageRef {
  date: string;
  brandId: string;
  brandName: string;
  processId: ProcessId;
  processName: string;
  required: number;
  beforeScheduled: number;
  afterScheduled: number;
  status: DayCoverage['status'];
}

export interface RecoveryLabTrace {
  target: RecoveryShortageRef;
  data: RosterData;
  result: RosterResult;
  analysis: RecoveryAnalysis;
  evaluations: RecoveryCandidateEvaluation[];
  selected: RecoveryCandidate | null;
  validation: RecoveryValidation | null;
  simulation: RecoverySimulation | null;
  simulatedCoverage: DayCoverage[];
  stages: RecoveryLabStage[];
  impactedShortages: RecoveryShortageRef[];
}

export interface RecoveryLabSelection {
  candidate: RecoveryCandidate;
  validation: RecoveryValidation;
  simulation: RecoverySimulation;
  simulatedCoverage: DayCoverage[];
}

export interface AbsenceScenario {
  employee: Employee;
  data: RosterData;
  result: RosterResult;
  impacted: RecoveryShortageRef[];
}

function processName(processId: ProcessId): string {
  return PROCESSES.find((p) => p.id === processId)?.label ?? processId;
}

function coverageKey(date: string, brandId: string, processId: ProcessId): string {
  return `${date}|${brandId}|${processId}`;
}

function coverageBeforeMap(result: RosterResult): Map<string, DayCoverage> {
  return new Map(
    result.coverage.map((slot) => [coverageKey(slot.date, slot.brandId, slot.processId), slot]),
  );
}

function shortageFromCoverage(
  data: RosterData,
  before: DayCoverage | undefined,
  after: DayCoverage,
): RecoveryShortageRef {
  const brand = data.brands.find((b) => b.id === after.brandId);
  return {
    date: after.date,
    brandId: after.brandId,
    brandName: brand?.name ?? after.brandId,
    processId: after.processId,
    processName: processName(after.processId),
    required: after.required,
    beforeScheduled: before?.scheduled.length ?? 0,
    afterScheduled: after.scheduled.length,
    status: after.status,
  };
}

/** Sort so the most severe/largest shortage is the default target. */
export function compareShortages(a: RecoveryShortageRef, b: RecoveryShortageRef): number {
  const severity = (s: RecoveryShortageRef) => (s.status === 'gap' ? 0 : 1);
  if (severity(a) !== severity(b)) return severity(a) - severity(b);
  const missingA = Math.max(0, a.required - a.afterScheduled);
  const missingB = Math.max(0, b.required - b.afterScheduled);
  if (missingA !== missingB) return missingB - missingA;
  return (
    a.brandName.localeCompare(b.brandName) ||
    a.processId.localeCompare(b.processId) ||
    a.date.localeCompare(b.date)
  );
}

/**
 * Build an absence scenario by adding one date-specific leave to a copy of the
 * live data and regenerating the roster. The live data and roster are never
 * mutated. The returned shortages are only slots that genuinely regressed
 * relative to the supplied baseline roster.
 */
export function buildAbsenceScenario(
  data: RosterData,
  baseline: RosterResult,
  employeeId: string,
  date: string,
): AbsenceScenario {
  const employee = data.employees.find((e) => e.id === employeeId);
  if (!employee) throw new Error(`Unknown employee ${employeeId}`);
  if (!baseline.days.includes(date)) throw new Error(`${date} is outside the roster month`);

  const scenarioData: RosterData = {
    ...data,
    employees: data.employees.map((e) =>
      e.id === employeeId
        ? {
            ...e,
            leaves: e.leaves.includes(date) ? e.leaves : [...e.leaves, date],
          }
        : e,
    ),
  };
  const result = generateRoster(scenarioData, baseline.year, baseline.month);
  const beforeByKey = coverageBeforeMap(baseline);
  const impacted = result.coverage
    .filter((slot) => slot.date === date && slot.operating && slot.status !== 'covered')
    .filter((slot) => {
      const before = beforeByKey.get(coverageKey(slot.date, slot.brandId, slot.processId));
      if (!before) return true;
      return slot.scheduled.length < before.scheduled.length;
    })
    .map((slot) =>
      shortageFromCoverage(
        scenarioData,
        beforeByKey.get(coverageKey(slot.date, slot.brandId, slot.processId)),
        slot,
      ),
    )
    .sort(compareShortages);

  return { employee, data: scenarioData, result, impacted };
}

/** Resolve the target coverage slot for a scenario. */
export function targetShortage(
  data: RosterData,
  result: RosterResult,
  before: RosterResult,
  date: string,
  brandId: string,
  processId: ProcessId,
): RecoveryShortageRef {
  const after = result.coverage.find(
    (slot) => slot.date === date && slot.brandId === brandId && slot.processId === processId,
  );
  if (!after) throw new Error('Target slot is missing from the generated roster.');
  const prior = before.coverage.find(
    (slot) => slot.date === date && slot.brandId === brandId && slot.processId === processId,
  );
  return shortageFromCoverage(data, prior, after);
}

function stage(
  id: RecoveryLabStageId,
  title: string,
  description: string,
  status: RecoveryLabStageStatus,
  summary: string,
  metrics: RecoveryLabStage['metrics'] = [],
): RecoveryLabStage {
  return { id, title, description, status, summary, metrics };
}

function countCode(
  evaluations: RecoveryCandidateEvaluation[],
  codes: RecoveryRejectionCode[],
): number {
  return evaluations.filter(
    (evaluation) => evaluation.rejectionCode && codes.includes(evaluation.rejectionCode),
  ).length;
}

const AUTH_CODES: RecoveryRejectionCode[] = [
  'NO_DESTINATION_AUTHORIZATION',
  'NO_CROSS_POD_AUTHORIZATION',
  'NO_COMPATIBLE_PROCESS_ALLOCATION',
];
const AVAILABILITY_CODES: RecoveryRejectionCode[] = [
  'ON_LEAVE_OR_COMP_OFF',
  'CANDIDATE_DOUBLE_BOOKED',
  'UNKNOWN_EMPLOYEE',
];
const ELIGIBILITY_CODES: RecoveryRejectionCode[] = [
  'TARGET_NOT_OPERATING',
  'ALREADY_ASSIGNED_TARGET',
  'TARGET_NOT_COVERED',
  'REASSIGNMENT_CAUSES_UNDERSTAFFING',
  'INCOMPATIBLE_DUTY',
  'SIMULATION_INVALID',
  'UNKNOWN_TARGET',
  'NO_ELIGIBLE_EMPLOYEE',
];

/** Build a complete, reproducible execution trace for one uncovered slot. */
export function buildRecoveryTrace(input
: {
  data: RosterData;
  result: RosterResult;
  target: RecoveryShortageRef;
  impactedShortages?: RecoveryShortageRef[];
  excludeEmployeeId?: string;
  preferredEmployeeId?: string;
}): RecoveryLabTrace {
  const { data, result, target } = input;
  const analysis = findRecoveryOptions(
    data,
    result,
    target.date,
    target.brandId,
    target.processId,
    input.excludeEmployeeId,
  );

  const candidates = new Map<string, RecoveryCandidate>();
  for (const proposal of analysis.proposals) candidates.set(proposal.employeeId, proposal);
  for (const rejected of analysis.rejected) candidates.set(rejected.employeeId, rejected);

  const evaluations: RecoveryCandidateEvaluation[] = [...candidates.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.employeeId.localeCompare(b.employeeId))
    .map((candidate) => {
      const eligibility = evaluateRecoveryEligibility(
        data,
        result,
        target.date,
        target.brandId,
        target.processId,
        candidate.employeeId,
        input.excludeEmployeeId,
      );
      return {
        employeeId: candidate.employeeId,
        name: candidate.name,
        eligibility,
        final: candidate,
        outcome: candidate.valid ? 'valid' as const : 'rejected' as const,
        rejectionCode: candidate.rejectionCode ?? eligibility.rejectionCode,
        rejectionReason: candidate.rejectionReason ?? eligibility.rejectionReason,
      };
    });

  const selected =
    analysis.proposals.find((p) => p.employeeId === input.preferredEmployeeId) ??
    analysis.proposals[0] ??
    null;
  const selection = selected ? buildProposalSelection(data, result, selected) : null;

  for (const evaluation of evaluations) {
    if (selected && evaluation.employeeId === selected.employeeId) {
      evaluation.outcome = 'selected';
    }
  }

  const availabilityFailures = countCode(evaluations, AVAILABILITY_CODES);
  const authFailures = countCode(evaluations, AUTH_CODES);
  const eligibilityFailures = countCode(evaluations, ELIGIBILITY_CODES);
  const validCount = analysis.proposals.length;
  const rejectedCount = analysis.rejected.length;
  const hasProposals = validCount > 0;

  const sourceImpactCandidates = analysis.proposals.filter((p) => p.sourceImpact.length > 0);
  const coverageResolved = analysis.proposals.filter((p) =>
    p.coverageImpact.some((impact) => impact.effect === 'resolved'),
  ).length;

  const stages: RecoveryLabStage[] = [
    stage(
      'detect',
      'Detect coverage gap',
      'Read the regenerated roster and locate the uncovered operating slot.',
      'completed',
      `${target.brandName} ${target.processName} is ${target.status} on ${target.date}: ${target.afterScheduled}/${target.required} scheduled.`,
      [
        { label: 'Required', value: String(target.required) },
        { label: 'Scheduled', value: String(target.afterScheduled), tone: 'bad' },
        { label: 'Status', value: target.status === 'gap' ? 'No cover' : 'Understaffed', tone: 'bad' },
      ],
    ),
    stage(
      'discover',
      'Discover potential candidates',
      'Discover the same-brand, same-pod, cross-brand and explicitly authorized candidate pool.',
      'completed',
      `${analysis.poolSize} employee(s) discovered in the permitted pool.`,
      [
        { label: 'Pool', value: String(analysis.poolSize) },
        { label: 'Evaluated', value: String(evaluations.length) },
        { label: 'Excluded absent employee', value: input.excludeEmployeeId ?? '—' },
      ],
    ),
    stage(
      'availability',
      'Check employee availability',
      'Reject employees on hard leave or comp-off, and employees already double-booked on the date.',
      'completed',
      availabilityFailures === 0
        ? 'Every discovered employee passed the availability check.'
        : `${availabilityFailures} employee(s) rejected for availability.`,
      [
        { label: 'Unavailable', value: String(availabilityFailures), tone: availabilityFailures ? 'bad' : 'ok' },
        { label: 'Passed', value: String(evaluations.length - availabilityFailures) },
      ],
    ),
    stage(
      'authorization',
      'Verify brand / process authorization',
      'Check explicit destination authorization, process allocation and pod-boundary permission.',
      'completed',
      authFailures === 0
        ? 'Every available employee had the required destination authorization.'
        : `${authFailures} employee(s) rejected for insufficient authorization.`,
      [
        { label: 'Rejected', value: String(authFailures), tone: authFailures ? 'warn' : 'ok' },
        { label: 'Passed', value: String(evaluations.length - authFailures) },
      ],
    ),
    stage(
      'pod-restrictions',
      'Verify pod restrictions',
      'Confirm that any move outside the employee’s home pod has an explicit cross-pod authorization.',
      'completed',
      countCode(evaluations, ['NO_CROSS_POD_AUTHORIZATION']) === 0
        ? 'No candidate failed the pod-boundary rule.'
        : `${countCode(evaluations, ['NO_CROSS_POD_AUTHORIZATION'])} employee(s) rejected for missing cross-pod authorization.`,
      [
        { label: 'Cross-pod checked', value: String(evaluations.filter((evaluation) => evaluation.eligibility.crossPodRequired).length) },
        { label: 'Rejected', value: String(countCode(evaluations, ['NO_CROSS_POD_AUTHORIZATION'])), tone: countCode(evaluations, ['NO_CROSS_POD_AUTHORIZATION']) ? 'warn' : 'ok' },
      ],
    ),
    stage(
      'eligibility',
      'Evaluate reassignment eligibility',
      'Apply the remaining hard rules: target operating, not already assigned, compatible duties.',
      'completed',
      eligibilityFailures === 0
        ? 'No candidate failed the remaining eligibility rules.'
        : `${eligibilityFailures} employee(s) rejected by reassignment eligibility.`,
      [
        { label: 'Rejected', value: String(eligibilityFailures), tone: eligibilityFailures ? 'warn' : 'ok' },
        { label: 'Safe proposals', value: String(validCount), tone: validCount ? 'ok' : 'bad' },
      ],
    ),
    stage(
      'simulate',
      'Simulate proposed changes',
      'Apply each directive to a copy of the roster and recompute the whole day.',
      hasProposals ? 'completed' : 'rejected',
      hasProposals
        ? `${validCount} proposal(s) simulated without cascading a new coverage failure.`
        : 'No proposal survived simulation; see the candidate panel for the actual rejection reasons.',
      [
        { label: 'Simulated', value: String(validCount), tone: hasProposals ? 'ok' : 'bad' },
        { label: 'Rejected', value: String(rejectedCount), tone: rejectedCount ? 'warn' : 'ok' },
      ],
    ),
    stage(
      'source-impact',
      'Evaluate source coverage impact',
      'Recompute coverage at the candidate’s source brand and every other affected slot.',
      hasProposals ? 'completed' : 'rejected',
      hasProposals
        ? `${sourceImpactCandidates.length} proposal(s) source-impact evaluated; ${coverageResolved} resolve the target without source regression.`
        : 'No candidate reached source-impact evaluation.',
      [
        { label: 'Source rows', value: String(sourceImpactCandidates.reduce((n, p) => n + p.sourceImpact.length, 0)) },
        { label: 'Repairs', value: String(coverageResolved), tone: coverageResolved ? 'ok' : 'bad' },
      ],
    ),
    stage(
      'rank',
      'Rank valid proposals',
      'Order valid repairs lexicographically: changes, source loss, minimum coverage, primary disruption, overrides, staffing, workload, employee id.',
      hasProposals ? 'completed' : 'rejected',
      hasProposals
        ? `${validCount} proposal(s) ranked. ${analysis.proposals[0].name} is first with key ${analysis.proposals[0].rankingKey.join('/')}.`
        : 'No valid proposal is available to rank.',
      analysis.proposals.slice(0, 3).map((proposal, index) => ({
        label: `#${index + 1}`,
        value: `${proposal.name} (${proposal.rankingKey.join('/')})`,
        tone: index === 0 ? 'ok' as const : 'muted' as const,
      })),
    ),
    stage(
      'validate',
      'Independently validate selected proposal',
      'Rebuild the roster from the baseline directive and re-check authorization, coverage and every hard constraint.',
      !selection ? 'rejected' : selection.validation.valid ? 'completed' : 'failed',
      !selection
        ? 'No selected proposal is available to validate.'
        : selection.validation.reason,
      selection
        ? [
            {
              label: 'Result',
              value: selection.validation.valid ? 'Valid' : 'Failed',
              tone: selection.validation.valid ? 'ok' as const : 'bad' as const,
            },
            {
              label: 'Failures',
              value: String(selection.validation.failures.length),
              tone: selection.validation.failures.length ? 'bad' as const : 'ok' as const,
            },
          ]
        : [],
    ),
  ];

  return {
    target,
    data,
    result,
    analysis,
    evaluations,
    selected,
    validation: selection?.validation ?? null,
    simulation: selection?.simulation ?? null,
    simulatedCoverage: selection?.simulatedCoverage ?? [],
    stages,
    impactedShortages: input.impactedShortages ?? [target],
  };
}

/**
 * Independently re-run validation and simulation for a proposal selected by
 * the evaluator. This is deliberately the same engine path used initially.
 */
export function buildProposalSelection(
  data: RosterData,
  result: RosterResult,
  candidate: RecoveryCandidate,
): RecoveryLabSelection {
  const directive = candidate.directive;
  if (!directive) throw new Error('Proposal has no recovery directive.');
  const simulation = simulateRecoveryDetailed(data, result.entries, directive);
  const validation = validateRecoveryProposal(data, result, candidate);
  const simulatedCoverage = simulation.valid
    ? computeDayCoverage(data, simulation.entries, directive.date)
    : [];
  return { candidate, validation, simulation, simulatedCoverage };
}

export function proposalCriteria(candidate: RecoveryCandidate): {
  label: string;
  value: string;
  hint: string;
}[] {
  return [
    { label: 'Changed assignments', value: String(candidate.changedAssignments), hint: 'Removed + added roster entries for this date.' },
    { label: 'Source coverage loss', value: String(candidate.sourceCoverageLoss), hint: 'Scheduled source seats lost by the move.' },
    { label: 'Source processes at minimum', value: String(candidate.sourceProcessesAtMinimum), hint: 'Source processes left exactly at their required minimum.' },
    { label: 'Primary disruptions', value: String(candidate.primaryDisruption), hint: 'Primary-owned source processes actually displaced.' },
    { label: 'Weekly-off overrides', value: String(candidate.weeklyOffOverrides), hint: 'Would schedule the employee on a preferred weekly off.' },
    { label: 'Additional staffing', value: String(candidate.additionalStaffing), hint: 'Temporary authorization burden (lower is better).' },
    { label: 'Current workload', value: String(candidate.currentWorkload), hint: 'Existing dated roster entries for the employee this month.' },
  ];
}

export function rankingComparison(
  selected: RecoveryCandidate,
  alternative: RecoveryCandidate,
): string {
  if (selected.employeeId === alternative.employeeId) return 'Selected proposal.';
  const criteria = proposalCriteria(selected);
  for (let index = 0; index < Math.max(selected.rankingKey.length, alternative.rankingKey.length); index += 1) {
    const left = selected.rankingKey[index] ?? Number.MAX_SAFE_INTEGER;
    const right = alternative.rankingKey[index] ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) {
      const label = criteria[index]?.label ?? `Criterion ${index + 1}`;
      return left < right
        ? `Outranked on ${label.toLowerCase()} (${left} vs ${right}).`
        : `Would outrank the selection on ${label.toLowerCase()} (${right} vs ${left}).`;
    }
  }
  return selected.employeeId.localeCompare(alternative.employeeId) <= 0
    ? 'Tied on every criterion; the deterministic employee-id tie-break keeps this proposal below the selection.'
    : 'Tied on every criterion; the deterministic employee-id tie-break would put this proposal first.';
}
