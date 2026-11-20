/**
 * TypeScript parity smoke tests for the recovery engine.
 *
 * The Python suite is the primary regression suite. This file exercises the
 * browser/TypeScript implementation directly so discovery, simulation,
 * validation and ranking cannot silently drift from the Python engine.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ALLOCATIONS,
  BRANDS,
  CROSS_POD_AUTHORIZATIONS,
  EMPLOYEES,
  HOLIDAYS,
  type ProcessId,
  type RecoveryAssignment,
} from '../src/data/seed';
import {
  generateRoster,
  type RosterData,
  type RosterEntry,
  type RosterResult,
} from '../src/lib/engine';
import {
  findRecoveryOptions,
  simulateRecovery,
  simulateRecoveryDetailed,
  validateRecoveryProposal,
  type RecoveryCandidate,
} from '../src/lib/recovery';
import {
  buildAbsenceScenario,
  buildRecoveryTrace,
} from '../src/lib/recoveryLab';

const DATE = '2026-12-01';
const data: RosterData = {
  employees: EMPLOYEES,
  brands: BRANDS,
  allocations: ALLOCATIONS,
  holidays: HOLIDAYS,
  crossPodAuthorizations: CROSS_POD_AUTHORIZATIONS,
};
const result = generateRoster(data, 2026, 12);

function candidate(
  analysis: ReturnType<typeof findRecoveryOptions>,
  employeeId: string,
) {
  const proposal = analysis.proposals.find((p) => p.employeeId === employeeId);
  assert.ok(proposal, `expected ${employeeId} to be a proposal`);
  return proposal;
}

function rejected(
  analysis: ReturnType<typeof findRecoveryOptions>,
  employeeId: string,
) {
  const entry = analysis.rejected.find((p) => p.employeeId === employeeId);
  assert.ok(entry, `expected ${employeeId} to be rejected`);
  return entry;
}

function entry(
  employeeId: string,
  brandId: string,
  processes: RosterEntry['processes'],
  date = DATE,
): RosterEntry {
  return { date, employeeId, brandId, processes, overriddenOff: false };
}

function patched(entries: RosterEntry[]): RosterResult {
  return { ...result, entries };
}

// Direct backup: unassigned but explicitly allocated to the destination.
{
  const entries = result.entries.filter(
    (e) => !(e.date === DATE && e.employeeId === 'e15'),
  );
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  const proposal = candidate(analysis, 'e15');
  assert.equal(proposal.recoveryType, 'direct-backup');
  assert.equal(proposal.allocationType, 'temporary-backup');
  assert.deepEqual(proposal.removedAssignments, []);
  assert.equal(proposal.addedAssignments[0].brandId, 'b04');
  assert.equal(validateRecoveryProposal(data, patched(entries), proposal).valid, true);
}

// Same-pod backup: free, same pod, allocated to the required process.
{
  const entries = result.entries.filter(
    (e) => !(e.date === DATE && (e.employeeId === 'e12' || e.employeeId === 'e15')),
  );
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  const proposal = candidate(analysis, 'e12');
  assert.equal(proposal.recoveryType, 'same-pod-backup');
  assert.equal(validateRecoveryProposal(data, patched(entries), proposal).valid, true);
}

// Process experience outside the pod is not destination authorization.
{
  const entries = [entry('e24', 'b09', ['RET'])];
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b01', 'RET');
  assert.equal(rejected(analysis, 'e24').rejectionCode, 'NO_DESTINATION_AUTHORIZATION');
}

// A separate explicit cross-pod authorization permits the move.
{
  const authorized: RosterData = {
    ...data,
    crossPodAuthorizations: [{ employeeId: 'e24', brandId: 'b01', processId: 'RET' }],
  };
  const entries = [entry('e24', 'b09', ['RET']), entry('e20', 'b09', ['RET'])];
  const analysis = findRecoveryOptions(authorized, patched(entries), DATE, 'b01', 'RET');
  const proposal = candidate(analysis, 'e24');
  assert.equal(proposal.recoveryType, 'cross-brand-reassignment');
  assert.equal(validateRecoveryProposal(authorized, patched(entries), proposal).valid, true);
}

// Moving the only source cover must be rejected, even when the move is authorized.
{
  const entries = [entry('e35', 'b02', ['RET'])];
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b01', 'RET');
  const proposal = rejected(analysis, 'e35');
  assert.equal(proposal.rejectionCode, 'REASSIGNMENT_CAUSES_UNDERSTAFFING');
}

// Primary disruption is measured from real source coverage, not "has an allocation".
{
  const entries = result.entries.filter(
    (e) => !(e.date === DATE && ['e26', 'e29', 'e32'].includes(e.employeeId)),
  );
  entries.push(entry('e32', 'b10', ['NDR']), entry('e26', 'b10', ['NDR']));
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b12', 'CS');
  const proposal = candidate(analysis, 'e32');
  assert.equal(proposal.primaryDisruption, 1);
  assert.equal(proposal.sourceImpact[0].primaryOwnedByCandidate, true);
  assert.equal(proposal.sourceImpact[0].coveredByOtherEmployees, true);
  assert.equal(validateRecoveryProposal(data, patched(entries), proposal).valid, true);
}

// Double-booking is a hard rejection.
{
  const entries = [entry('e15', 'b05', ['CS']), entry('e15', 'b06', ['CS'])];
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  assert.equal(rejected(analysis, 'e15').rejectionCode, 'CANDIDATE_DOUBLE_BOOKED');
}

// The validator checks duplicate baseline assignments even if discovery is bypassed.
{
  const clean = result.entries.filter(
    (e) => !(e.date === DATE && e.employeeId === 'e15'),
  );
  const analysis = findRecoveryOptions(data, patched(clean), DATE, 'b04', 'CS');
  const proposal = candidate(analysis, 'e15');
  const duplicated = [
    ...clean,
    entry('e15', 'b05', ['CS']),
    entry('e15', 'b06', ['CS']),
  ];
  const validation = validateRecoveryProposal(data, patched(duplicated), proposal);
  assert.equal(validation.valid, false);
  assert.ok(validation.failures.some((f) => f.code === 'DOUBLE_BOOKED'));
}

// Validation must ignore the candidate's own flags and re-check eligibility.
{
  const entries = [entry('e24', 'b09', ['RET'])];
  const invalid = {
    employeeId: 'e24',
    name: 'Nisha Agarwal',
    currentAssignment: {
      brandId: 'b09',
      brandName: 'GreenLeaf',
      processes: ['RET'],
      isPrimary: false,
    },
    targetAssignment: {
      brandId: 'b01',
      brandName: 'GlowKart',
      processId: 'RET',
      processName: 'Retention',
    },
    recoveryType: 'cross-brand-reassignment',
    allocationType: 'temporary-reassignment',
    changedAssignments: 2,
    removedAssignments: [],
    addedAssignments: [],
    sourceCoverageLoss: 0,
    primaryDisruption: 0,
    weeklyOffOverrides: 0,
    additionalStaffing: 0,
    sourceImpact: [],
    sourceProcessesAtMinimum: 0,
    currentWorkload: 0,
    coverageImpact: [],
    hardConstraintsSatisfied: true,
    valid: true,
    reasons: [],
    rankingKey: [],
    rankingExplanation: '',
    score: 0,
    directive: {
      date: DATE,
      employeeId: 'e24',
      brandId: 'b01',
      processId: 'RET',
      type: 'temporary-reassignment',
      fromBrandId: 'b09',
      fromProcesses: ['RET'],
    },
  } satisfies RecoveryCandidate;
  const validation = validateRecoveryProposal(data, patched(entries), invalid);
  assert.equal(validation.valid, false);
  assert.ok(validation.failures.some((f) => f.code === 'NOT_ELIGIBLE'));
}

// Cross-pod moves require a separate pod-boundary grant, even when the
// employee has a permanent destination allocation.
{
  const noCrossPod: RosterData = { ...data, crossPodAuthorizations: [] };
  const entries = [entry('e36', 'b11', ['CS'])];
  const analysis = findRecoveryOptions(noCrossPod, patched(entries), DATE, 'b04', 'CS');
  assert.equal(rejected(analysis, 'e36').rejectionCode, 'NO_CROSS_POD_AUTHORIZATION');
}

// The explicit cross-pod grant permits the same direct backup.
{
  const entries = [entry('e10', 'b04', ['CS'])];
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  const proposal = candidate(analysis, 'e36');
  assert.equal(proposal.recoveryType, 'direct-backup');
  assert.equal(validateRecoveryProposal(data, patched(entries), proposal).valid, true);
}

// Forged source metadata is rejected by the validator.
{
  const entries = result.entries.filter(
    (e) => !(e.date === DATE && e.employeeId === 'e15'),
  );
  entries.push(entry('e15', 'b05', ['CS']));
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  const proposal = candidate(analysis, 'e15');
  const forged: RecoveryCandidate = {
    ...proposal,
    directive: { ...proposal.directive!, fromBrandId: 'b06' },
  };
  const validation = validateRecoveryProposal(data, patched(entries), forged);
  assert.equal(validation.valid, false);
  assert.ok(validation.failures.some((f) => f.code === 'SOURCE_METADATA_MISMATCH'));
}

// Candidate display metadata cannot disagree with the directive.
{
  const entries = result.entries.filter(
    (e) => !(e.date === DATE && e.employeeId === 'e15'),
  );
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  const proposal = candidate(analysis, 'e15');
  const forged: RecoveryCandidate = {
    ...proposal,
    targetAssignment: { ...proposal.targetAssignment, brandId: 'b06' },
  };
  const validation = validateRecoveryProposal(data, patched(entries), forged);
  assert.equal(validation.valid, false);
  assert.ok(validation.failures.some((f) => f.code === 'MALFORMED_DIRECTIVE'));
}

// Pre-existing unrelated gaps do not invalidate a safe repair.
{
  const entries = result.entries.filter(
    (e) => !(e.date === DATE && ['e01', 'e15'].includes(e.employeeId)),
  );
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  const proposal = candidate(analysis, 'e15');
  assert.equal(validateRecoveryProposal(data, patched(entries), proposal).valid, true);
}

// Ranking is deterministic and lexicographically sorted.
{
  const entries = result.entries.filter(
    (e) => !(e.date === DATE && e.employeeId === 'e15'),
  );
  const first = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  const second = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  assert.deepEqual(
    first.proposals.map((p) => p.employeeId),
    second.proposals.map((p) => p.employeeId),
  );
  for (let index = 1; index < first.proposals.length; index += 1) {
    const previous = first.proposals[index - 1];
    const current = first.proposals[index];
    const previousKey = previous.rankingKey.join('|');
    const currentKey = current.rankingKey.join('|');
    assert.ok(previousKey <= currentKey);
    if (previousKey === currentKey) {
      assert.ok(previous.employeeId < current.employeeId);
    }
  }
}

// Permanent allocations are never mutated by analysis or validation.
{
  const before = JSON.stringify(data.allocations);
  const entries = result.entries.filter(
    (e) => !(e.date === DATE && e.employeeId === 'e15'),
  );
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  validateRecoveryProposal(data, patched(entries), candidate(analysis, 'e15'));
  assert.equal(JSON.stringify(data.allocations), before);
}

// Simulation rejects invalid input explicitly and never mutates the baseline.
{
  const baseline = [entry('e15', 'b05', ['CS'])];
  const base: RecoveryAssignment = {
    date: DATE,
    employeeId: 'e15',
    brandId: 'b04',
    processId: 'CS',
    type: 'temporary-backup',
  };
  const invalidDate = simulateRecoveryDetailed(data, baseline, {
    ...base,
    date: '2026-13-01',
  });
  assert.equal(invalidDate.valid, false);
  assert.equal(invalidDate.issues[0].code, 'INVALID_DIRECTIVE');

  const unknownTarget = simulateRecoveryDetailed(data, baseline, {
    ...base,
    processId: 'ZZ' as RosterEntry['processes'][number],
  });
  assert.equal(unknownTarget.issues[0].code, 'UNKNOWN_TARGET');

  const alreadyAssigned = simulateRecoveryDetailed(data, baseline, base);
  assert.equal(alreadyAssigned.issues[0].code, 'ALREADY_ASSIGNED');

  const duplicated = [...baseline, entry('e15', 'b06', ['CS'])];
  const duplicate = simulateRecoveryDetailed(data, duplicated, base);
  assert.equal(duplicate.issues[0].code, 'DUPLICATE_ASSIGNMENT');

  const forgedSourceDirective: RecoveryAssignment = {
    ...base,
    type: 'temporary-reassignment',
    fromBrandId: 'b06',
    fromProcesses: ['CS'],
  };
  const forgedSource = simulateRecoveryDetailed(
    data,
    baseline,
    forgedSourceDirective,
  );
  assert.equal(forgedSource.issues[0].code, 'SOURCE_METADATA_MISMATCH');
  assert.throws(() => simulateRecovery(data, baseline, forgedSourceDirective));
  assert.deepEqual(baseline, [entry('e15', 'b05', ['CS'])]);
}

// Same-pod process experience does not authorize an assigned cross-brand move.
{
  const entries = [entry('e15', 'b05', ['CS'])];
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b06', 'CS');
  assert.equal(rejected(analysis, 'e15').rejectionCode, 'NO_DESTINATION_AUTHORIZATION');
}

// Invalid dates and processes are rejected before validation proceeds.
{
  const entries = result.entries.filter(
    (e) => !(e.date === DATE && e.employeeId === 'e15'),
  );
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  const proposal = candidate(analysis, 'e15');

  const invalidDate: RecoveryCandidate = {
    ...proposal,
    directive: { ...proposal.directive!, date: '2026-13-01' },
  };
  assert.ok(
    validateRecoveryProposal(data, patched(entries), invalidDate).failures.some(
      (f) => f.code === 'MALFORMED_DIRECTIVE',
    ),
  );

  const invalidProcess: RecoveryCandidate = {
    ...proposal,
    targetAssignment: {
      ...proposal.targetAssignment,
      processId: 'ZZ' as RosterEntry['processes'][number],
    },
    directive: {
      ...proposal.directive!,
      processId: 'ZZ' as RosterEntry['processes'][number],
    },
  };
  assert.ok(
    validateRecoveryProposal(data, patched(entries), invalidProcess).failures.some(
      (f) => f.code === 'UNKNOWN_TARGET',
    ),
  );
}

// A closed destination process is rejected even if validation is bypassed.
{
  const entries = result.entries.filter(
    (e) => !(e.date === DATE && e.employeeId === 'e15'),
  );
  const analysis = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  const proposal = candidate(analysis, 'e15');
  const closed: RecoveryCandidate = {
    ...proposal,
    targetAssignment: {
      ...proposal.targetAssignment,
      brandId: 'b01',
      processId: 'RET',
    },
    directive: {
      ...proposal.directive!,
      date: '2026-12-06',
      brandId: 'b01',
      processId: 'RET',
    },
  };
  assert.ok(
    validateRecoveryProposal(data, patched(entries), closed).failures.some(
      (f) => f.code === 'TARGET_NOT_OPERATING',
    ),
  );
}

// Incompatible destination duties are rejected when the model declares them.
{
  const incompatibleData: RosterData = {
    ...data,
    allocations: [
      ...ALLOCATIONS,
      { employeeId: 'e15', brandId: 'b04', processId: 'ACC', role: 'secondary' },
    ],
    incompatiblePairs: [
      {
        brandId1: 'b04',
        processId1: 'CS',
        brandId2: 'b04',
        processId2: 'ACC',
      },
    ],
  };
  const entries = [
    entry('e10', 'b04', ['CS']),
    entry('e12', 'b05', ['CS']),
    entry('e15', 'b05', ['CS']),
  ];
  const analysis = findRecoveryOptions(
    incompatibleData,
    patched(entries),
    DATE,
    'b04',
    'CS',
  );
  assert.equal(rejected(analysis, 'e15').rejectionCode, 'INCOMPATIBLE_DUTY');

  const normal = findRecoveryOptions(data, patched(entries), DATE, 'b04', 'CS');
  const proposal = candidate(normal, 'e15');
  const validation = validateRecoveryProposal(
    incompatibleData,
    patched(entries),
    proposal,
  );
  assert.ok(validation.failures.some((f) => f.code === 'INCOMPATIBLE_DUTY'));
}

// Validator detects new source understaffing, not just discovery failures.
{
  const entries = [entry('e35', 'b02', ['RET'])];
  const candidateWithSource = {
    employeeId: 'e35',
    name: 'Isha Rao',
    currentAssignment: {
      brandId: 'b02',
      brandName: 'FitFuel',
      processes: ['RET'],
      isPrimary: false,
    },
    targetAssignment: {
      brandId: 'b01',
      brandName: 'GlowKart',
      processId: 'RET',
      processName: 'Retention',
    },
    recoveryType: 'cross-brand-reassignment',
    allocationType: 'temporary-reassignment',
    changedAssignments: 2,
    removedAssignments: [],
    addedAssignments: [],
    sourceCoverageLoss: 0,
    primaryDisruption: 0,
    weeklyOffOverrides: 0,
    additionalStaffing: 0,
    sourceImpact: [],
    sourceProcessesAtMinimum: 0,
    currentWorkload: 0,
    coverageImpact: [],
    hardConstraintsSatisfied: true,
    valid: true,
    reasons: [],
    rankingKey: [],
    rankingExplanation: '',
    score: 0,
    directive: {
      date: DATE,
      employeeId: 'e35',
      brandId: 'b01',
      processId: 'RET',
      type: 'temporary-reassignment',
      fromBrandId: 'b02',
      fromProcesses: ['RET'],
    },
  } satisfies RecoveryCandidate;
  const validation = validateRecoveryProposal(
    data,
    patched(entries),
    candidateWithSource,
  );
  assert.equal(validation.valid, false);
  assert.ok(validation.failures.some((f) => f.code === 'SOURCE_UNDERSTAFFED'));
  assert.ok(validation.failures.some((f) => f.code === 'NEW_HARD_CONSTRAINT'));
}

// Retained BookBarn regression: both BookBarn employees are on leave, but a
// same-pod CS float can still repair the slot.
{
  const analysis = findRecoveryOptions(
    data,
    { ...result, entries: [] },
    '2026-12-21',
    'b11',
    'CS',
  );
  assert.equal(rejected(analysis, 'e27').rejectionCode, 'ON_LEAVE_OR_COMP_OFF');
  assert.equal(rejected(analysis, 'e28').rejectionCode, 'ON_LEAVE_OR_COMP_OFF');
  assert.ok(analysis.proposals.length > 0);
  for (const proposal of analysis.proposals) {
    assert.equal(
      validateRecoveryProposal(data, { ...result, entries: [] }, proposal).valid,
      true,
    );
  }
  assert.ok(
    analysis.proposals[0].coverageImpact.some((impact) => impact.effect === 'resolved'),
  );
}

// The Recovery Lab trace is built from the same engine run, not a parallel
// implementation. An absence scenario must yield the full ten-stage pipeline.
{
  const scenario = buildAbsenceScenario(data, result, 'e17', '2026-12-03');
  assert.ok(scenario.impacted.length > 0, 'expected the absence to create a shortage');
  const trace = buildRecoveryTrace({
    data: scenario.data,
    result: scenario.result,
    target: scenario.impacted[0],
    impactedShortages: scenario.impacted,
    excludeEmployeeId: 'e17',
  });
  assert.deepEqual(
    trace.stages.map((stage) => stage.id),
    [
      'detect',
      'discover',
      'availability',
      'authorization',
      'pod-restrictions',
      'eligibility',
      'simulate',
      'source-impact',
      'rank',
      'validate',
    ],
  );
  assert.ok(trace.analysis.proposals.length > 0);
  for (const proposal of trace.analysis.proposals) {
    assert.equal(
      validateRecoveryProposal(scenario.data, scenario.result, proposal).valid,
      true,
    );
  }
}

// Shared fixture: Python and TypeScript must produce the same lexicographical
// order and ranking keys for the same seed scenario.
{
  const parity = JSON.parse(
    readFileSync('tests/parity_scenarios.json', 'utf8'),
  ) as {
    recovery_ranking: {
      date: string;
      brand_id: string;
      process_id: string;
      exclude_employee_ids: string[];
      expected_order: string[];
      expected_keys: Record<string, number[]>;
    };
  };
  const scenario = parity.recovery_ranking;
  const entries = result.entries.filter(
    (e) =>
      e.date === scenario.date &&
      !scenario.exclude_employee_ids.includes(e.employeeId),
  );
  const analysis = findRecoveryOptions(
    data,
    patched(entries),
    scenario.date,
    scenario.brand_id,
    scenario.process_id as ProcessId,
  );
  assert.deepEqual(
    analysis.proposals.map((proposal) => proposal.employeeId),
    scenario.expected_order,
  );
  for (const proposal of analysis.proposals) {
    assert.deepEqual(
      proposal.rankingKey,
      scenario.expected_keys[proposal.employeeId],
      `ranking key drifted for ${proposal.employeeId}`,
    );
  }
}

console.log('TypeScript recovery smoke tests passed');
