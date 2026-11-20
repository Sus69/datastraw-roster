/**
 * TypeScript parity smoke tests for the recovery engine.
 *
 * The Python suite is the primary regression suite. This file exercises the
 * browser/TypeScript implementation directly so discovery, simulation,
 * validation and ranking cannot silently drift from the Python engine.
 */

import assert from 'node:assert/strict';

import {
  ALLOCATIONS,
  BRANDS,
  CROSS_POD_AUTHORIZATIONS,
  EMPLOYEES,
  HOLIDAYS,
} from '../src/data/seed';
import {
  generateRoster,
  type RosterData,
  type RosterEntry,
  type RosterResult,
} from '../src/lib/engine';
import {
  findRecoveryOptions,
  validateRecoveryProposal,
  type RecoveryCandidate,
} from '../src/lib/recovery';

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
): RosterEntry {
  return { date: DATE, employeeId, brandId, processes, overriddenOff: false };
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

console.log('TypeScript recovery smoke tests passed');
