/**
 * TypeScript scheduling-engine regression tests.
 *
 * These tests exercise the only scheduling engine directly: generation,
 * independent validation, calendar rules, incompatible duties, input errors
 * and the optional workload policy. No runtime or external solver is used.
 */

import assert from 'node:assert/strict';

import {
  ALLOCATIONS,
  BRANDS,
  CROSS_POD_AUTHORIZATIONS,
  EMPLOYEES,
  HOLIDAYS,
  type Brand,
  type Employee,
  type IncompatiblePair,
  type OperatingRule,
} from '../src/data/seed';
import {
  generateRoster,
  validateRoster,
  validateRosterInput,
  type RosterData,
  type RosterEntry,
  type WorkloadPolicy,
} from '../src/lib/engine';

const data: RosterData = {
  employees: EMPLOYEES,
  brands: BRANDS,
  allocations: ALLOCATIONS,
  holidays: HOLIDAYS,
  crossPodAuthorizations: CROSS_POD_AUTHORIZATIONS,
};

function clone(): RosterData {
  return structuredClone(data);
}

// Baseline December 2026: complete coverage, deterministic output.
{
  const first = generateRoster(data, 2026, 12);
  const second = generateRoster(data, 2026, 12);
  assert.equal(first.stats.operatingSlots, 875);
  assert.equal(first.stats.coveredSlots, 875);
  assert.equal(first.stats.gapSlots, 0);
  assert.equal(first.stats.understaffedSlots, 0);
  assert.equal(first.stats.errors, 0);
  assert.equal(first.stats.employeesWorking, 36);
  assert.equal(first.conflicts.filter((c) => c.type === 'OFF_OVERRIDDEN').length, 15);
  assert.deepEqual(first.entries, second.entries);
  assert.deepEqual(first.coverage, second.coverage);
  assert.deepEqual(first.conflicts, second.conflicts);
}

// A generated roster never double-books an employee, schedules someone on
// approved leave/comp-off, or assigns an operating slot without cover.
{
  const result = generateRoster(data, 2026, 12);
  const seen = new Set<string>();
  for (const entry of result.entries) {
    const key = `${entry.employeeId}|${entry.date}`;
    assert.equal(seen.has(key), false, `double-booked ${key}`);
    seen.add(key);

    const employee = EMPLOYEES.find((e) => e.id === entry.employeeId);
    assert.ok(employee, `unknown employee ${entry.employeeId}`);
    assert.equal(employee.leaves.includes(entry.date), false, `leave clash for ${key}`);
    assert.equal(employee.compOffs.includes(entry.date), false, `comp-off clash for ${key}`);

    for (const processId of entry.processes) {
      assert.ok(
        ALLOCATIONS.some(
          (allocation) =>
            allocation.employeeId === entry.employeeId &&
            allocation.brandId === entry.brandId &&
            allocation.processId === processId,
        ),
        `unauthorized ${key} ${processId}`,
      );
    }
  }
  for (const slot of result.coverage) {
    if (slot.operating) assert.equal(slot.status, 'covered', `${slot.date} ${slot.brandId} ${slot.processId}`);
  }
}

// Seed leave scenario: e01 is away 8-10 December; GlowKart Retention is still
// covered by the specialist without scheduling e01.
{
  const result = generateRoster(data, 2026, 12);
  for (const date of ['2026-12-08', '2026-12-09', '2026-12-10']) {
    assert.equal(
      result.entries.some((entry) => entry.date === date && entry.employeeId === 'e01'),
      false,
      `e01 scheduled while on leave on ${date}`,
    );
    const retention = result.coverage.find(
      (slot) => slot.date === date && slot.brandId === 'b01' && slot.processId === 'RET',
    );
    assert.ok(retention);
    assert.equal(retention.status, 'covered');
    assert.ok(retention.scheduled.includes('e35'));
  }
}

// Insufficient staffing is reported as a hard error, not hidden.
{
  const input = clone();
  const b01 = input.brands.find((brand) => brand.id === 'b01')!;
  const retention = b01.processes.find((process) => process.processId === 'RET')!;
  retention.minStaff = 3;
  const result = generateRoster(input, 2026, 12);
  assert.ok(result.stats.errors > 0);
  assert.ok(
    result.conflicts.some(
      (conflict) =>
        conflict.type === 'UNDERSTAFFED' &&
        conflict.brandId === 'b01' &&
        conflict.processId === 'RET',
    ),
  );
}

// Invalid input is rejected with an explanation instead of throwing.
{
  assert.ok(validateRosterInput(data, 2026, 13).length > 0);
  const invalidMonth = generateRoster(data, 2026, 13);
  assert.equal(invalidMonth.entries.length, 0);
  assert.ok(invalidMonth.conflicts.every((c) => c.type === 'INVALID_INPUT'));

  const input = clone();
  input.allocations.push({
    employeeId: 'e999',
    brandId: 'b01',
    processId: 'CS',
    role: 'secondary',
  });
  const invalidAllocation = generateRoster(input, 2026, 12);
  assert.equal(invalidAllocation.entries.length, 0);
  assert.ok(
    invalidAllocation.conflicts.some(
      (conflict) =>
        conflict.type === 'INVALID_INPUT' && conflict.message.includes('unknown employee e999'),
    ),
  );

  const duplicateEmployees = clone();
  duplicateEmployees.employees = [
    ...duplicateEmployees.employees,
    { ...duplicateEmployees.employees[0] },
  ];
  assert.ok(
    validateRosterInput(duplicateEmployees, 2026, 12).some((error) =>
      error.includes('Duplicate or empty employee id'),
    ),
  );
}

// The independent validator catches incompatible same-day duties.
{
  const incompatiblePairs: IncompatiblePair[] = [
    { brandId1: 'b01', processId1: 'CS', brandId2: 'b01', processId2: 'RET' },
  ];
  const entry: RosterEntry = {
    date: '2026-12-01',
    employeeId: 'e01',
    brandId: 'b01',
    processes: ['CS', 'RET'],
    overriddenOff: false,
  };
  const conflicts = validateRoster(
    { ...data, incompatiblePairs },
    [entry],
    [],
  );
  assert.ok(conflicts.some((conflict) => conflict.type === 'INCOMPATIBLE_DUTY'));
}

// Generation refuses to assign an employee both sides of an incompatible pair.
{
  const input = clone();
  input.incompatiblePairs = [
    { brandId1: 'b01', processId1: 'CS', brandId2: 'b01', processId2: 'RET' },
  ];
  const result = generateRoster(input, 2026, 12);
  for (const entry of result.entries) {
    if (entry.brandId !== 'b01') continue;
    assert.equal(entry.processes.includes('CS') && entry.processes.includes('RET'), false);
  }
  assert.ok(
    result.conflicts.some(
      (conflict) => conflict.brandId === 'b01' && conflict.processId === 'RET',
    ),
  );
}

// Custom operating dates are honoured by both generation and validation.
{
  const input = clone();
  const b01 = input.brands.find((brand) => brand.id === 'b01')!;
  const cs = b01.processes.find((process) => process.processId === 'CS')!;
  cs.rule = 'CUSTOM' as OperatingRule;
  cs.customOperatingDates = ['2026-12-01'];
  const result = generateRoster(input, 2026, 12);
  const operating = result.coverage.find(
    (slot) => slot.date === '2026-12-01' && slot.brandId === 'b01' && slot.processId === 'CS',
  );
  const closed = result.coverage.find(
    (slot) => slot.date === '2026-12-02' && slot.brandId === 'b01' && slot.processId === 'CS',
  );
  assert.ok(operating?.operating);
  assert.equal(closed?.operating, false);
}

// Optional workload policy: sufficient capacity passes, a demand beyond all
// scheduled capacity is reported as a workload shortage.
{
  const capacities = EMPLOYEES.map((employee) => ({
    employeeId: employee.id,
    date: '2026-12-01',
    maxDailyHours: 8,
    processCapacityHours: { 'b01:CS': 8 },
  }));
  const feasible: WorkloadPolicy = {
    enabled: true,
    demands: [{ brandId: 'b01', processId: 'CS', date: '2026-12-01', demandHours: 8 }],
    capacities,
  };
  const feasibleResult = generateRoster({ ...data, workloadPolicy: feasible }, 2026, 12);
  assert.equal(
    feasibleResult.conflicts.some((conflict) => conflict.type === 'WORKLOAD_SHORTAGE'),
    false,
  );

  const impossible: WorkloadPolicy = {
    ...feasible,
    demands: [{ brandId: 'b01', processId: 'CS', date: '2026-12-01', demandHours: 100 }],
  };
  const impossibleResult = generateRoster({ ...data, workloadPolicy: impossible }, 2026, 12);
  assert.ok(
    impossibleResult.conflicts.some((conflict) => conflict.type === 'WORKLOAD_SHORTAGE'),
  );
}

// Calendar and authorization checks also apply to manually supplied entries.
{
  const employee = EMPLOYEES[0] as Employee;
  const brand = BRANDS[0] as Brand;
  const closedEntry: RosterEntry = {
    date: '2026-12-06', // Sunday; b01 RET is NO_SUN_HOLIDAYS
    employeeId: employee.id,
    brandId: brand.id,
    processes: ['RET'],
    overriddenOff: false,
  };
  const closed = validateRoster(data, [closedEntry], []);
  assert.ok(closed.some((conflict) => conflict.type === 'CALENDAR_VIOLATION'));

  const unauthorizedEntry: RosterEntry = {
    date: '2026-12-01',
    employeeId: 'e36',
    brandId: 'b09',
    processes: ['RET'],
    overriddenOff: false,
  };
  const unauthorized = validateRoster(data, [unauthorizedEntry], []);
  assert.ok(unauthorized.some((conflict) => conflict.type === 'UNAUTHORIZED_ASSIGNMENT'));
}

console.log('TypeScript scheduling-engine smoke tests passed');
