// ---------------------------------------------------------------------------
// Seed data for the Datastraw Smart Roster Management System.
// All data is fictional. Brand names, employee names and holidays are invented
// for the assessment; the India public holidays listed are the real ones for
// the months covered (Nov 2026 – Feb 2027).
// ---------------------------------------------------------------------------

export type ProcessId = 'CS' | 'ACC' | 'RET' | 'NDR';

export const PROCESSES: { id: ProcessId; label: string; short: string }[] = [
  { id: 'CS', label: 'Customer Support', short: 'CS' },
  { id: 'ACC', label: 'Abandoned Cart Conversions', short: 'ACC' },
  { id: 'RET', label: 'Retention', short: 'RET' },
  { id: 'NDR', label: 'Non-Delivery Report', short: 'NDR' },
];

/** How a brand/process calendar behaves. */
export type OperatingRule = 'ALL_YEAR' | 'EXCEPT_HOLIDAYS' | 'NO_SUN_HOLIDAYS' | 'CUSTOM';

export const RULES: { id: OperatingRule; label: string; description: string }[] = [
  { id: 'ALL_YEAR', label: '365-day ops', description: 'Operates every day, including Sundays and public holidays.' },
  { id: 'EXCEPT_HOLIDAYS', label: 'Daily except holidays', description: 'Operates every day except public holidays.' },
  { id: 'NO_SUN_HOLIDAYS', label: 'Sundays & holidays off', description: 'Closed on Sundays and public holidays.' },
];

export interface BrandProcess {
  processId: ProcessId;
  rule: OperatingRule;
  /** Minimum number of employees who must be working that process on an operating day. */
  minStaff: number;
  /** Explicit ISO operating dates for the CUSTOM calendar rule. */
  customOperatingDates?: string[];
}

export interface Brand {
  id: string;
  name: string;
  category: string;
  podId: string;
  processes: BrandProcess[];
}

export interface Pod {
  id: string;
  name: string;
  leadId: string;
}

export type CompOffAssignmentStatus = 'scheduled' | 'pending';

/**
 * Explicit link between a shift worked on a preferred weekly off and the
 * compensatory day that was actually recorded for it. The comp-off date must
 * also exist in `Employee.compOffs` before it is treated as scheduled; this is
 * deliberately not inferred from the next non-working day.
 */
export interface CompOffAssignment {
  /** ISO date of the shift that fell on the employee's preferred weekly off. */
  workedDate: string;
  /** ISO date explicitly assigned as the compensatory off, if one exists. */
  compOffDate?: string;
  status?: CompOffAssignmentStatus;
  reason?: string;
}

export interface Employee {
  id: string;
  name: string;
  podId: string;
  /** Preferred weekly off days, 0 = Sunday … 6 = Saturday. Preferences, not hard
   *  constraints: mandatory client coverage can override them (flagged as a warning). */
  weeklyOff: number[];
  /** Planned leave, ISO dates. Hard unavailability. */
  leaves: string[];
  /** Compensatory days off (e.g. earned by working a public holiday). Hard unavailability. */
  compOffs: string[];
  /** Explicit compensatory-off records for shifts worked on a preferred weekly off. */
  compOffAssignments?: CompOffAssignment[];
}

export interface Allocation {
  employeeId: string;
  brandId: string;
  processId: ProcessId;
  role: 'primary' | 'secondary';
}

export interface Holiday {
  date: string; // ISO yyyy-mm-dd
  name: string;
}

/**
 * A date-specific recovery instruction. These are deliberately separate from
 * permanent `Allocation` records: a temporary backup or reassignment changes
 * only the named date and never rewrites the permanent allocation model.
 */
export type RecoveryAssignmentType = 'temporary-backup' | 'temporary-reassignment';

export interface CrossPodAuthorization {
  employeeId: string;
  brandId: string;
  processId: ProcessId;
}

/** Explicitly incompatible brand/process duties for one employee-day. */
export interface IncompatiblePair {
  brandId1: string;
  processId1: ProcessId;
  brandId2: string;
  processId2: ProcessId;
}

export interface RecoveryAssignment {
  /** ISO date the instruction applies to. */
  date: string;
  employeeId: string;
  /** Destination brand + process. */
  brandId: string;
  processId: ProcessId;
  type: RecoveryAssignmentType;
  /** Original assignment, retained for audit/review (not used to mutate allocations). */
  fromBrandId?: string;
  fromProcesses?: ProcessId[];
  /** Optional stable id used by the UI. */
  id?: string;
}

export const PODS: Pod[] = [
  { id: 'pod-alpha', name: 'Pod Alpha', leadId: 'e01' },
  { id: 'pod-beta', name: 'Pod Beta', leadId: 'e10' },
  { id: 'pod-gamma', name: 'Pod Gamma', leadId: 'e18' },
  { id: 'pod-delta', name: 'Pod Delta', leadId: 'e26' },
];

export const BRANDS: Brand[] = [
  {
    id: 'b01', name: 'GlowKart', category: 'Beauty & personal care', podId: 'pod-alpha',
    processes: [
      { processId: 'CS', rule: 'ALL_YEAR', minStaff: 1 },
      { processId: 'ACC', rule: 'EXCEPT_HOLIDAYS', minStaff: 1 },
      { processId: 'RET', rule: 'NO_SUN_HOLIDAYS', minStaff: 1 },
    ],
  },
  {
    id: 'b02', name: 'FitFuel', category: 'Nutrition & supplements', podId: 'pod-alpha',
    processes: [
      { processId: 'CS', rule: 'ALL_YEAR', minStaff: 1 },
      { processId: 'RET', rule: 'EXCEPT_HOLIDAYS', minStaff: 1 },
    ],
  },
  {
    id: 'b03', name: 'UrbanNest', category: 'Home decor', podId: 'pod-alpha',
    processes: [
      { processId: 'CS', rule: 'NO_SUN_HOLIDAYS', minStaff: 1 },
      { processId: 'NDR', rule: 'EXCEPT_HOLIDAYS', minStaff: 1 },
    ],
  },
  {
    id: 'b04', name: 'TechTrove', category: 'Gadgets & electronics', podId: 'pod-beta',
    processes: [
      { processId: 'CS', rule: 'ALL_YEAR', minStaff: 2 },
      { processId: 'ACC', rule: 'ALL_YEAR', minStaff: 1 },
      { processId: 'NDR', rule: 'EXCEPT_HOLIDAYS', minStaff: 1 },
    ],
  },
  {
    id: 'b05', name: 'PetPals', category: 'Pet supplies', podId: 'pod-beta',
    processes: [
      { processId: 'CS', rule: 'EXCEPT_HOLIDAYS', minStaff: 1 },
      { processId: 'RET', rule: 'NO_SUN_HOLIDAYS', minStaff: 1 },
    ],
  },
  {
    id: 'b06', name: 'StyleSutra', category: 'Fashion', podId: 'pod-beta',
    processes: [
      { processId: 'CS', rule: 'ALL_YEAR', minStaff: 1 },
      { processId: 'ACC', rule: 'NO_SUN_HOLIDAYS', minStaff: 1 },
      { processId: 'RET', rule: 'EXCEPT_HOLIDAYS', minStaff: 1 },
    ],
  },
  {
    id: 'b07', name: 'SnackBox', category: 'Snacks & gourmet', podId: 'pod-gamma',
    processes: [
      { processId: 'CS', rule: 'ALL_YEAR', minStaff: 1 },
      { processId: 'ACC', rule: 'ALL_YEAR', minStaff: 1 },
    ],
  },
  {
    id: 'b08', name: 'BabyBliss', category: 'Baby care', podId: 'pod-gamma',
    processes: [
      { processId: 'CS', rule: 'EXCEPT_HOLIDAYS', minStaff: 1 },
      { processId: 'NDR', rule: 'NO_SUN_HOLIDAYS', minStaff: 1 },
    ],
  },
  {
    id: 'b09', name: 'GreenLeaf', category: 'Organic foods', podId: 'pod-gamma',
    processes: [
      { processId: 'CS', rule: 'NO_SUN_HOLIDAYS', minStaff: 1 },
      { processId: 'RET', rule: 'EXCEPT_HOLIDAYS', minStaff: 1 },
      { processId: 'ACC', rule: 'NO_SUN_HOLIDAYS', minStaff: 1 },
    ],
  },
  {
    id: 'b10', name: 'AutoAce', category: 'Auto accessories', podId: 'pod-delta',
    processes: [
      { processId: 'CS', rule: 'ALL_YEAR', minStaff: 2 },
      { processId: 'NDR', rule: 'ALL_YEAR', minStaff: 1 },
    ],
  },
  {
    id: 'b11', name: 'BookBarn', category: 'Books & stationery', podId: 'pod-delta',
    processes: [
      { processId: 'CS', rule: 'NO_SUN_HOLIDAYS', minStaff: 1 },
      { processId: 'RET', rule: 'NO_SUN_HOLIDAYS', minStaff: 1 },
    ],
  },
  {
    id: 'b12', name: 'WellnessWave', category: 'Wellness & fitness', podId: 'pod-delta',
    processes: [
      { processId: 'CS', rule: 'ALL_YEAR', minStaff: 1 },
      { processId: 'ACC', rule: 'EXCEPT_HOLIDAYS', minStaff: 1 },
      { processId: 'RET', rule: 'ALL_YEAR', minStaff: 1 },
      { processId: 'NDR', rule: 'EXCEPT_HOLIDAYS', minStaff: 1 },
    ],
  },
];

// Staffing pattern (matches the brief): 9 of 12 brands (75%) have ONE dedicated
// employee handling all of that brand's processes; AutoAce and BookBarn have 2
// primaries each and WellnessWave has 3. Every single-resource brand still
// carries at least one secondary allocation per process. The remaining
// employees are shared across brands or pod floaters who act as secondary/backup
// cover.
export const EMPLOYEES: Employee[] = [
  // Pod Alpha
  { id: 'e01', name: 'Aarav Mehta', podId: 'pod-alpha', weeklyOff: [0], leaves: ['2026-12-08', '2026-12-09', '2026-12-10'], compOffs: [] },
  { id: 'e02', name: 'Priya Sharma', podId: 'pod-alpha', weeklyOff: [1], leaves: ['2026-12-15'], compOffs: [] },
  { id: 'e03', name: 'Rohan Iyer', podId: 'pod-alpha', weeklyOff: [2], leaves: [], compOffs: [] },
  { id: 'e04', name: 'Kavya Nair', podId: 'pod-alpha', weeklyOff: [3], leaves: [], compOffs: [] },
  { id: 'e05', name: 'Arjun Patel', podId: 'pod-alpha', weeklyOff: [4], leaves: [], compOffs: [] },
  { id: 'e06', name: 'Sneha Kulkarni', podId: 'pod-alpha', weeklyOff: [5], leaves: [], compOffs: [] },
  { id: 'e07', name: 'Vikram Singh', podId: 'pod-alpha', weeklyOff: [6], leaves: [], compOffs: ['2026-12-26'] },
  { id: 'e08', name: 'Ananya Gupta', podId: 'pod-alpha', weeklyOff: [0], leaves: [], compOffs: [] },
  { id: 'e09', name: 'Dev Malhotra', podId: 'pod-alpha', weeklyOff: [1], leaves: [], compOffs: [] },
  // Pod Beta
  { id: 'e10', name: 'Neha Joshi', podId: 'pod-beta', weeklyOff: [2], leaves: ['2026-12-03'], compOffs: [] },
  { id: 'e11', name: 'Kabir Shah', podId: 'pod-beta', weeklyOff: [3], leaves: [], compOffs: [] },
  { id: 'e12', name: 'Riya Kapoor', podId: 'pod-beta', weeklyOff: [4], leaves: ['2026-12-24'], compOffs: [] },
  { id: 'e13', name: 'Manish Verma', podId: 'pod-beta', weeklyOff: [5], leaves: [], compOffs: [] },
  { id: 'e14', name: 'Pooja Desai', podId: 'pod-beta', weeklyOff: [6], leaves: [], compOffs: [] },
  { id: 'e15', name: 'Farhan Khan', podId: 'pod-beta', weeklyOff: [0], leaves: [], compOffs: [] },
  { id: 'e16', name: 'Ishita Bose', podId: 'pod-beta', weeklyOff: [1], leaves: [], compOffs: ['2026-12-27'] },
  { id: 'e17', name: 'Sahil Ahmed', podId: 'pod-beta', weeklyOff: [2], leaves: [], compOffs: [] },
  // Pod Gamma
  { id: 'e18', name: 'Divya Reddy', podId: 'pod-gamma', weeklyOff: [3], leaves: ['2026-12-28', '2026-12-29'], compOffs: [] },
  { id: 'e19', name: 'Aditya Rao', podId: 'pod-gamma', weeklyOff: [4], leaves: [], compOffs: [] },
  { id: 'e20', name: 'Tanvi Bhatt', podId: 'pod-gamma', weeklyOff: [5], leaves: [], compOffs: [] },
  { id: 'e21', name: 'Nikhil Jain', podId: 'pod-gamma', weeklyOff: [6], leaves: [], compOffs: [] },
  { id: 'e22', name: 'Shreya Menon', podId: 'pod-gamma', weeklyOff: [0], leaves: [], compOffs: [] },
  { id: 'e23', name: 'Varun Chopra', podId: 'pod-gamma', weeklyOff: [1], leaves: [], compOffs: [] },
  { id: 'e24', name: 'Nisha Agarwal', podId: 'pod-gamma', weeklyOff: [2], leaves: [], compOffs: [] },
  { id: 'e25', name: 'Karan Bhatia', podId: 'pod-gamma', weeklyOff: [3], leaves: ['2026-12-08'], compOffs: [] },
  // Pod Delta
  { id: 'e26', name: 'Rahul Khanna', podId: 'pod-delta', weeklyOff: [4], leaves: [], compOffs: [] },
  { id: 'e27', name: 'Meera Pillai', podId: 'pod-delta', weeklyOff: [5], leaves: ['2026-12-21'], compOffs: [] },
  { id: 'e28', name: 'Sanjay Yadav', podId: 'pod-delta', weeklyOff: [6], leaves: ['2026-12-21'], compOffs: [] },
  { id: 'e29', name: 'Tara Singh', podId: 'pod-delta', weeklyOff: [0], leaves: [], compOffs: [] },
  { id: 'e30', name: 'Yash Thakur', podId: 'pod-delta', weeklyOff: [1], leaves: [], compOffs: [] },
  { id: 'e31', name: 'Zoya Sheikh', podId: 'pod-delta', weeklyOff: [2], leaves: [], compOffs: [] },
  { id: 'e32', name: 'Amit Tiwari', podId: 'pod-delta', weeklyOff: [3], leaves: [], compOffs: [] },
  { id: 'e33', name: 'Lakshmi Venkat', podId: 'pod-delta', weeklyOff: [4], leaves: [], compOffs: [] },
  { id: 'e34', name: 'Om Prakash', podId: 'pod-delta', weeklyOff: [5], leaves: [], compOffs: [] },
  // Two additional recovery specialists: one strengthens single-resource
  // GlowKart cover, one gives BookBarn/TechTrove a safe floater.
  { id: 'e35', name: 'Isha Rao', podId: 'pod-alpha', weeklyOff: [6], leaves: [], compOffs: [] },
  { id: 'e36', name: 'Naveen Kumar', podId: 'pod-delta', weeklyOff: [0], leaves: [], compOffs: [] },
];

export const ALLOCATIONS: Allocation[] = [
  // --- Dedicated employees: one per brand, all of that brand's processes ---
  { employeeId: 'e01', brandId: 'b01', processId: 'CS', role: 'primary' },
  { employeeId: 'e01', brandId: 'b01', processId: 'ACC', role: 'primary' },
  { employeeId: 'e01', brandId: 'b01', processId: 'RET', role: 'primary' },
  { employeeId: 'e02', brandId: 'b02', processId: 'CS', role: 'primary' },
  { employeeId: 'e02', brandId: 'b02', processId: 'RET', role: 'primary' },
  { employeeId: 'e03', brandId: 'b03', processId: 'CS', role: 'primary' },
  { employeeId: 'e03', brandId: 'b03', processId: 'NDR', role: 'primary' },
  { employeeId: 'e10', brandId: 'b04', processId: 'CS', role: 'primary' },
  { employeeId: 'e10', brandId: 'b04', processId: 'ACC', role: 'primary' },
  { employeeId: 'e10', brandId: 'b04', processId: 'NDR', role: 'primary' },
  { employeeId: 'e11', brandId: 'b05', processId: 'CS', role: 'primary' },
  { employeeId: 'e11', brandId: 'b05', processId: 'RET', role: 'primary' },
  { employeeId: 'e12', brandId: 'b06', processId: 'CS', role: 'primary' },
  { employeeId: 'e12', brandId: 'b06', processId: 'ACC', role: 'primary' },
  { employeeId: 'e12', brandId: 'b06', processId: 'RET', role: 'primary' },
  { employeeId: 'e18', brandId: 'b07', processId: 'CS', role: 'primary' },
  { employeeId: 'e18', brandId: 'b07', processId: 'ACC', role: 'primary' },
  { employeeId: 'e19', brandId: 'b08', processId: 'CS', role: 'primary' },
  { employeeId: 'e19', brandId: 'b08', processId: 'NDR', role: 'primary' },
  { employeeId: 'e20', brandId: 'b09', processId: 'CS', role: 'primary' },
  { employeeId: 'e20', brandId: 'b09', processId: 'RET', role: 'primary' },
  { employeeId: 'e20', brandId: 'b09', processId: 'ACC', role: 'primary' },
  { employeeId: 'e26', brandId: 'b10', processId: 'CS', role: 'primary' },
  { employeeId: 'e26', brandId: 'b10', processId: 'NDR', role: 'secondary' },
  // --- BookBarn: 2 employees, different primary processes, each secondary on the other's ---
  { employeeId: 'e27', brandId: 'b11', processId: 'CS', role: 'primary' },
  { employeeId: 'e27', brandId: 'b11', processId: 'RET', role: 'secondary' },
  { employeeId: 'e28', brandId: 'b11', processId: 'RET', role: 'primary' },
  { employeeId: 'e28', brandId: 'b11', processId: 'CS', role: 'secondary' },
  // --- WellnessWave: 3 employees on different processes, with cross-cover ---
  { employeeId: 'e29', brandId: 'b12', processId: 'CS', role: 'primary' },
  { employeeId: 'e29', brandId: 'b12', processId: 'NDR', role: 'secondary' },
  { employeeId: 'e30', brandId: 'b12', processId: 'ACC', role: 'primary' },
  { employeeId: 'e30', brandId: 'b12', processId: 'RET', role: 'primary' },
  { employeeId: 'e30', brandId: 'b12', processId: 'CS', role: 'secondary' },
  { employeeId: 'e31', brandId: 'b12', processId: 'NDR', role: 'primary' },
  { employeeId: 'e31', brandId: 'b12', processId: 'RET', role: 'secondary' },
  // --- Shared employees: second cover on two brands each ---
  { employeeId: 'e07', brandId: 'b01', processId: 'CS', role: 'secondary' },
  { employeeId: 'e07', brandId: 'b02', processId: 'CS', role: 'secondary' },
  { employeeId: 'e08', brandId: 'b03', processId: 'CS', role: 'secondary' },
  { employeeId: 'e08', brandId: 'b01', processId: 'ACC', role: 'secondary' },
  { employeeId: 'e15', brandId: 'b04', processId: 'CS', role: 'secondary' },
  { employeeId: 'e15', brandId: 'b05', processId: 'CS', role: 'secondary' },
  { employeeId: 'e16', brandId: 'b06', processId: 'ACC', role: 'secondary' },
  { employeeId: 'e16', brandId: 'b04', processId: 'NDR', role: 'secondary' },
  { employeeId: 'e23', brandId: 'b07', processId: 'ACC', role: 'secondary' },
  { employeeId: 'e23', brandId: 'b08', processId: 'CS', role: 'secondary' },
  { employeeId: 'e24', brandId: 'b09', processId: 'RET', role: 'secondary' },
  { employeeId: 'e24', brandId: 'b07', processId: 'CS', role: 'secondary' },
  { employeeId: 'e34', brandId: 'b10', processId: 'CS', role: 'secondary' },
  { employeeId: 'e34', brandId: 'b12', processId: 'ACC', role: 'secondary' },
  // --- Pod floaters: backup pool inside their pod ---
  { employeeId: 'e04', brandId: 'b02', processId: 'CS', role: 'secondary' },
  { employeeId: 'e04', brandId: 'b03', processId: 'NDR', role: 'secondary' },
  { employeeId: 'e05', brandId: 'b03', processId: 'NDR', role: 'secondary' },
  { employeeId: 'e06', brandId: 'b03', processId: 'CS', role: 'secondary' },
  { employeeId: 'e09', brandId: 'b02', processId: 'RET', role: 'secondary' },
  { employeeId: 'e13', brandId: 'b05', processId: 'RET', role: 'secondary' },
  { employeeId: 'e13', brandId: 'b06', processId: 'CS', role: 'secondary' },
  { employeeId: 'e14', brandId: 'b04', processId: 'ACC', role: 'secondary' },
  { employeeId: 'e17', brandId: 'b06', processId: 'RET', role: 'secondary' },
  { employeeId: 'e21', brandId: 'b08', processId: 'NDR', role: 'secondary' },
  { employeeId: 'e21', brandId: 'b09', processId: 'CS', role: 'secondary' },
  { employeeId: 'e22', brandId: 'b07', processId: 'CS', role: 'secondary' },
  { employeeId: 'e25', brandId: 'b09', processId: 'ACC', role: 'secondary' },
  { employeeId: 'e32', brandId: 'b10', processId: 'NDR', role: 'primary' },
  { employeeId: 'e32', brandId: 'b12', processId: 'CS', role: 'secondary' },
  { employeeId: 'e33', brandId: 'b12', processId: 'RET', role: 'secondary' },
  { employeeId: 'e33', brandId: 'b10', processId: 'CS', role: 'secondary' },
  // --- Recovery specialists (e35, e36): cross-cover the fragile single-resource brands ---
  { employeeId: 'e35', brandId: 'b01', processId: 'RET', role: 'secondary' },
  { employeeId: 'e35', brandId: 'b01', processId: 'CS', role: 'secondary' },
  { employeeId: 'e35', brandId: 'b02', processId: 'RET', role: 'secondary' },
  { employeeId: 'e36', brandId: 'b11', processId: 'CS', role: 'secondary' },
  { employeeId: 'e36', brandId: 'b11', processId: 'RET', role: 'secondary' },
  { employeeId: 'e36', brandId: 'b04', processId: 'CS', role: 'secondary' },
];

// Explicit pod-boundary permissions. An allocation for a brand/process does
// not by itself authorize an employee to work outside their home pod.
export const CROSS_POD_AUTHORIZATIONS: CrossPodAuthorization[] = [
  { employeeId: 'e36', brandId: 'b04', processId: 'CS' },
];

export const HOLIDAYS: Holiday[] = [
  { date: '2026-11-24', name: 'Guru Nanak Jayanti' },
  { date: '2026-12-25', name: 'Christmas Day' },
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-14', name: 'Makar Sankranti' },
  { date: '2027-01-26', name: 'Republic Day' },
  { date: '2027-02-19', name: 'Chhatrapati Shivaji Maharaj Jayanti' },
];

// ---------------------------------------------------------------------------
// Date helpers (all local-time, ISO yyyy-mm-dd keys)
// ---------------------------------------------------------------------------

export function isoDate(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

export function daysInMonth(year: number, month: number): string[] {
  // month is 1-based
  const days: string[] = [];
  const n = new Date(year, month, 0).getDate();
  for (let d = 1; d <= n; d++) days.push(isoDate(year, month, d));
  return days;
}

export function dayOfWeek(iso: string): number {
  return new Date(`${iso}T12:00:00`).getDay(); // 0 = Sunday
}

export function isHoliday(iso: string): Holiday | undefined {
  return HOLIDAYS.find((h) => h.date === iso);
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function processLabel(id: ProcessId): string {
  return PROCESSES.find((p) => p.id === id)?.label ?? id;
}
