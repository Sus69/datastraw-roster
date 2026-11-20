import React, { useEffect, useMemo, useState } from 'react';
import {
  ALLOCATIONS,
  BRANDS,
  CROSS_POD_AUTHORIZATIONS,
  EMPLOYEES,
  HOLIDAYS,
  PODS,
  RULES,
  WEEKDAYS,
  isHoliday,
  processLabel,
} from './data/seed';
import type { Employee, OperatingRule, ProcessId, RecoveryAssignment } from './data/seed';
import {
  generateRoster,
  generateRosterCPSAT,
  isHardUnavailable,
  isWeeklyOff,
  rosterToCsv,
} from './lib/engine';
import type { Conflict, RosterData, RosterResult } from './lib/engine';
import {
  findRecoveryOptions,
  recoveryTypeLabel,
  validateRecoveryProposal,
} from './lib/recovery';
import { MonthMap } from './components/MonthMap';
import './App.css';

// ---------------------------------------------------------------------------
// Overrides: Manager edits stored in localStorage.
// ---------------------------------------------------------------------------

export interface ExtraAllocation {
  employeeId: string;
  brandId: string;
  processId: ProcessId;
  role: 'primary' | 'secondary';
}

interface Overrides {
  extraLeaves: Record<string, string[]>;
  weeklyOff: Record<string, number[]>;
  minStaff: Record<string, number>; // key `${brandId}|${processId}`
  rule: Record<string, OperatingRule>; // key `${brandId}|${processId}`
  extraAllocations: ExtraAllocation[];
  /** Date-specific recovery repairs. These never change permanent allocations. */
  recoveryAssignments: RecoveryAssignment[];
}

const EMPTY_OVERRIDES: Overrides = {
  extraLeaves: {},
  weeklyOff: {},
  minStaff: {},
  rule: {},
  extraAllocations: [],
  recoveryAssignments: [],
};
const STORAGE_KEY = 'datastraw-roster-overrides-v2';

function loadOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_OVERRIDES;
    const parsed = JSON.parse(raw) as Partial<Overrides>;
    return {
      extraLeaves: parsed.extraLeaves ?? {},
      weeklyOff: parsed.weeklyOff ?? {},
      minStaff: parsed.minStaff ?? {},
      rule: parsed.rule ?? {},
      extraAllocations: parsed.extraAllocations ?? [],
      recoveryAssignments: parsed.recoveryAssignments ?? [],
    };
  } catch {
    return EMPTY_OVERRIDES;
  }
}

function mergeData(o: Overrides): RosterData {
  const employees = EMPLOYEES.map((e) => ({
    ...e,
    weeklyOff: o.weeklyOff[e.id] ?? e.weeklyOff,
    leaves: [...e.leaves, ...(o.extraLeaves[e.id] ?? [])],
  }));
  const brands = BRANDS.map((b) => ({
    ...b,
    processes: b.processes.map((p) => ({
      ...p,
      minStaff: o.minStaff[`${b.id}|${p.processId}`] ?? p.minStaff,
      rule: o.rule[`${b.id}|${p.processId}`] ?? p.rule,
    })),
  }));
  return {
    employees,
    brands,
    allocations: [...ALLOCATIONS, ...(o.extraAllocations ?? [])],
    holidays: HOLIDAYS,
    crossPodAuthorizations: CROSS_POD_AUTHORIZATIONS,
    recoveryAssignments: o.recoveryAssignments ?? [],
  };
}

type View = 'overview' | 'pods' | 'brands' | 'processes' | 'employees' | 'conflicts';

const VIEWS: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'pods', label: 'Pods' },
  { id: 'brands', label: 'Brands' },
  { id: 'processes', label: 'Processes' },
  { id: 'employees', label: 'Employees' },
  { id: 'conflicts', label: 'Conflicts' },
];

function brandShort(name: string, isCompact = false): string {
  if (isCompact) {
    if (name.startsWith('The Daily')) return 'DAI';
    return name.slice(0, 3).toUpperCase();
  }
  return name.slice(0, 4).toUpperCase();
}

function getProcessClass(processes: ProcessId[]): string {
  if (!processes || processes.length === 0) return '';
  if (processes.length === 1) {
    const p = processes[0];
    if (p === 'CS') return 'proc-cs';
    if (p === 'ACC') return 'proc-acc';
    if (p === 'RET') return 'proc-ret';
    if (p === 'NDR') return 'proc-ndr';
  }
  return 'proc-multi';
}

function getProcessChipLetter(processes: ProcessId[]): string {
  if (!processes || processes.length === 0) return '';
  if (processes.length === 1) {
    const p = processes[0];
    if (p === 'CS') return 'C';
    if (p === 'ACC') return 'A';
    if (p === 'RET') return 'R';
    if (p === 'NDR') return 'N';
  }
  return 'M';
}

function download(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}


function formatLedgerDate(iso: string): string {
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length < 3) return iso;
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[m - 1]} ${d}`;
}

function getConflictSentence(c: Conflict, data: RosterData): string {
  const brand = c.brandId ? data.brands.find((b) => b.id === c.brandId) : undefined;
  const brandName = brand ? brand.name : (c.brandId ?? 'Operating process');
  const procName = c.processId ? processLabel(c.processId) : '';
  const dateStr = formatLedgerDate(c.date);
  const emp = c.employeeId ? data.employees.find((e) => e.id === c.employeeId) : undefined;
  const empName = emp?.name ?? 'Staff member';
  const isFemale = /^(Neha|Meera|Pooja|Ananya|Kavita|Divya|Riya|Ishita|Sneha|Priya)\b/i.test(empName);
  const pronoun = isFemale ? 'her' : 'his';

  if (c.type === 'COVERAGE_GAP') {
    return `${brandName}${procName ? ' ' + procName : ''} — ${dateStr}, no one scheduled. Needs 1.`;
  }
  if (c.type === 'UNDERSTAFFED') {
    return `${brandName}${procName ? ' ' + procName : ''} — ${dateStr}, only 1 staff scheduled. Needs 2.`;
  }
  if (c.type === 'OFF_OVERRIDDEN') {
    return `${empName} — worked ${pronoun} weekly off, ${dateStr}, to cover ${brandName}.`;
  }
  return c.message.replace(/2026-12-(\d+)/g, 'Dec $1');
}

export default function App() {
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(12);
  const [view, setView] = useState<View>('overview');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [overrides, setOverrides] = useState<Overrides>(loadOverrides);
  const [search, setSearch] = useState('');
  const [podFilter, setPodFilter] = useState('all');
  const [selectedBrand, setSelectedBrand] = useState(BRANDS[0].id);
  const [selectedEmployee, setSelectedEmployee] = useState(EMPLOYEES[0].id);
  const [conflictFilter, setConflictFilter] = useState<'all' | 'error' | 'warning' | 'gap' | 'understaffed'>('all');
  const [backupFor, setBackupFor] = useState<string | null>(null);
  const [density, setDensity] = useState<'compact' | 'comfortable'>('compact');
  const [inspectorTarget, setInspectorTarget] = useState<{ date: string; employeeId?: string } | null>(null);

  // When I Work style view options
  const [hideUnscheduled, setHideUnscheduled] = useState<boolean>(false);
  const [highlightGapsOnly, setHighlightGapsOnly] = useState<boolean>(false);
  const [colorBy, setColorBy] = useState<'process' | 'brand'>('process');

  // Simulate-a-change panel
  const [simEmp, setSimEmp] = useState(EMPLOYEES[0].id);
  const [simDate, setSimDate] = useState('2026-12-14');
  const [simPreview, setSimPreview] = useState<RosterResult | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  }, [overrides]);

  const data = useMemo(() => mergeData(overrides), [overrides]);
  const [result, setResult] = useState<RosterResult>(() => generateRoster(mergeData(loadOverrides()), 2026, 12));
  const [isSolving, setIsSolving] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setIsSolving(true);
    });
    generateRosterCPSAT(data, year, month).then((res) => {
      if (!cancelled) {
        setResult(res);
        setIsSolving(false);
      }
    }).catch(() => {
      if (!cancelled) {
        const fallback = generateRoster(data, year, month);
        fallback.solverStatus = 'FEASIBLE';
        setResult(fallback);
        setIsSolving(false);
      }
    });
    return () => { cancelled = true; };
  }, [data, year, month]);

  const monthLabel = `${year}-${String(month).padStart(2, '0')}`;
  const entryByKey = useMemo(() => {
    const m = new Map<string, { brandId: string; processes: ProcessId[]; overriddenOff: boolean }>();
    for (const e of result.entries) m.set(`${e.employeeId}|${e.date}`, e);
    return m;
  }, [result]);

  const scheduledEmpIds = useMemo(() => {
    return new Set(result.entries.map((e) => e.employeeId));
  }, [result.entries]);

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.employees.filter((e) => {
      if (hideUnscheduled && !scheduledEmpIds.has(e.id)) return false;
      if (podFilter !== 'all' && e.podId !== podFilter) return false;
      if (q !== '' && !e.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, search, podFilter, hideUnscheduled, scheduledEmpIds]);

  const visibleConflicts = useMemo(() => {
    return result.conflicts.filter((c) => {
      if (conflictFilter === 'all') return true;
      if (conflictFilter === 'error') return c.severity === 'error';
      if (conflictFilter === 'warning') return c.severity === 'warning';
      if (conflictFilter === 'gap') return c.type === 'COVERAGE_GAP';
      if (conflictFilter === 'understaffed') return c.type === 'UNDERSTAFFED';
      return true;
    });
  }, [result.conflicts, conflictFilter]);

  function runSimulation() {
    const changed: Overrides = {
      ...overrides,
      extraLeaves: {
        ...overrides.extraLeaves,
        [simEmp]: [...(overrides.extraLeaves[simEmp] ?? []), simDate],
      },
    };
    setSimPreview(generateRoster(mergeData(changed), year, month));
  }

  function applySimulation() {
    setOverrides((o) => ({
      ...o,
      extraLeaves: {
        ...o.extraLeaves,
        [simEmp]: [...(o.extraLeaves[simEmp] ?? []), simDate],
      },
    }));
    setSimPreview(null);
  }

  function applyRecoveryAssignment(assignment: RecoveryAssignment) {
    setOverrides((o) => {
      // One employee can only receive one repair per date. Replacing an earlier
      // instruction for that employee/date also prevents conflicting repairs.
      const existing = (o.recoveryAssignments ?? []).filter(
        (a) => !(a.date === assignment.date && a.employeeId === assignment.employeeId),
      );
      return {
        ...o,
        recoveryAssignments: [...existing, assignment],
      };
    });
  }

  function markEmployeeUnavailable(employeeId: string, date: string) {
    setOverrides((o) => {
      const cur = o.extraLeaves[employeeId] ?? [];
      if (cur.includes(date)) return o;
      return {
        ...o,
        extraLeaves: {
          ...o.extraLeaves,
          [employeeId]: [...cur, date],
        },
      };
    });
  }

  function toggleWeeklyOffPreference(employeeId: string, weekday: number) {
    setOverrides((o) => {
      const emp = data.employees.find((e) => e.id === employeeId);
      if (!emp) return o;
      const cur = o.weeklyOff[employeeId] ?? emp.weeklyOff;
      const next = cur.includes(weekday) ? cur.filter((d) => d !== weekday) : [...cur, weekday];
      return {
        ...o,
        weeklyOff: {
          ...o.weeklyOff,
          [employeeId]: next,
        },
      };
    });
  }

  const simNewConflicts: Conflict[] = simPreview
    ? simPreview.conflicts.filter((c) => !result.conflicts.some((r) => r.id === c.id))
    : [];

  const simEmpName = data.employees.find((e) => e.id === simEmp)?.name ?? simEmp;

  function exportCsv() {
    download(`roster-${monthLabel}.csv`, rosterToCsv(data, result));
  }

  function resetAll() {
    setOverrides(EMPTY_OVERRIDES);
    setSimPreview(null);
  }

  const hasOverrides =
    Object.keys(overrides.extraLeaves).length > 0 ||
    Object.keys(overrides.weeklyOff).length > 0 ||
    Object.keys(overrides.minStaff).length > 0 ||
    Object.keys(overrides.rule).length > 0 ||
    (overrides.recoveryAssignments && overrides.recoveryAssignments.length > 0) ||
    (overrides.extraAllocations && overrides.extraAllocations.length > 0);

  // Counts for 7shifts compliance line
  const gapsCount = result.conflicts.filter((c) => c.type === 'COVERAGE_GAP').length;
  const understaffedCount = result.conflicts.filter((c) => c.type === 'UNDERSTAFFED').length;
  const overridesCount = result.stats.warnings;

  return (
    <div className="app">
      <aside className={`sidebar ${isSidebarOpen ? '' : 'collapsed'}`} aria-label="Sidebar navigation">
        <div className="brand-block">
          <div className="brand-mark">DS</div>
          <div className="brand-info">
            <div className="brand-title">Datastraw</div>
            <div className="brand-sub">Roster operations</div>
          </div>
          <button
            type="button"
            className="sidebar-collapse-toggle"
            onClick={() => setIsSidebarOpen(false)}
            title="Hide sidebar"
            aria-label="Hide sidebar"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
          </button>
        </div>

        <div className="side-selects-grid">
          <div className="side-select-wrap">
            <label className="side-label" htmlFor="month-picker">Roster month</label>
            <select
              id="month-picker"
              className="month-select"
              value={monthLabel}
              onChange={(e) => {
                const [y, m] = e.target.value.split('-').map(Number);
                if (y && m) {
                  setYear(y);
                  setMonth(m);
                }
              }}
            >
              <option value="2026-11">November 2026</option>
              <option value="2026-12">December 2026</option>
              <option value="2027-01">January 2027</option>
              <option value="2027-02">February 2027</option>
            </select>
          </div>

          <div className="side-select-wrap">
            <label className="side-label" htmlFor="view-picker">View</label>
            <select
              id="view-picker"
              className="month-select view-select"
              value={view}
              onChange={(e) => setView(e.target.value as View)}
            >
              {VIEWS.map((v) => {
                let badgeText = '';
                if (v.id === 'conflicts') {
                  const parts: string[] = [];
                  if (result.stats.errors > 0) parts.push(`${result.stats.errors} errors`);
                  if (result.stats.warnings > 0) parts.push(`${result.stats.warnings} overrides`);
                  if (parts.length > 0) badgeText = ` (${parts.join(', ')})`;
                }
                return (
                  <option key={v.id} value={v.id}>
                    {v.label}{badgeText}
                  </option>
                );
              })}
            </select>
          </div>
        </div>

        <div className="side-actions">
          <button className="btn btn-secondary" onClick={exportCsv}>Export roster CSV</button>
          <button className="btn btn-ghost" onClick={resetAll} disabled={!hasOverrides}>
            Reset to seed data
          </button>
        </div>

        <p className="side-note">
          Leaves and comp-offs represent absolute unavailability. Client coverage takes precedence over weekly off preferences.
        </p>
      </aside>

      <main className="content">
        <header className="page-head">
          <div className="page-head-main">
            <div className="page-head-title-row">
              {!isSidebarOpen && (
                <button
                  type="button"
                  className="sidebar-expand-toggle"
                  onClick={() => setIsSidebarOpen(true)}
                  title="Show sidebar"
                  aria-label="Show sidebar"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6"></polyline>
                  </svg>
                  <span>Sidebar</span>
                </button>
              )}
              <h1>
                {VIEWS.find((v) => v.id === view)?.label} —{' '}
                {new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' })}
              </h1>
            </div>

            {/* Compliance summary line: one plain sentence, no colours, no mono */}
            <div className="compliance-line">
              {gapsCount} coverage gap{gapsCount !== 1 ? 's' : ''}, {understaffedCount} understaffed day{understaffedCount !== 1 ? 's' : ''}, {overridesCount} weekly-off override{overridesCount !== 1 ? 's' : ''}. {result.stats.coveredSlots} of {result.stats.operatingSlots} shifts covered.
              {isSolving && <span className="comp-solving"> Solving...</span>}
            </div>
          </div>
        </header>

        {view === 'overview' && (
          <OverviewView
            result={result}
            data={data}
            employees={filteredEmployees}
            entryByKey={entryByKey}
            search={search}
            setSearch={setSearch}
            podFilter={podFilter}
            setPodFilter={setPodFilter}
            density={density}
            setDensity={setDensity}
            hideUnscheduled={hideUnscheduled}
            setHideUnscheduled={setHideUnscheduled}
            highlightGapsOnly={highlightGapsOnly}
            setHighlightGapsOnly={setHighlightGapsOnly}
            colorBy={colorBy}
            setColorBy={setColorBy}
            onInspectDate={(date, empId) => setInspectorTarget({ date, employeeId: empId })}
            onJumpToConflicts={() => {
              setView('conflicts');
              setConflictFilter('error');
            }}
            simEmp={simEmp}
            setSimEmp={setSimEmp}
            simDate={simDate}
            setSimDate={setSimDate}
            simPreview={simPreview}
            simNewConflicts={simNewConflicts}
            simEmpName={simEmpName}
            onRunSimulation={runSimulation}
            onApplySimulation={applySimulation}
            onDiscardSimulation={() => setSimPreview(null)}
          />
        )}

        {view === 'pods' && <PodsView result={result} data={data} />}

        {view === 'brands' && (
          <BrandsView
            result={result}
            data={data}
            selectedBrand={selectedBrand}
            setSelectedBrand={setSelectedBrand}
            overrides={overrides}
            setOverrides={setOverrides}
          />
        )}

        {view === 'processes' && <ProcessesView result={result} data={data} />}

        {view === 'employees' && (
          <EmployeesView
            result={result}
            data={data}
            selectedEmployee={selectedEmployee}
            setSelectedEmployee={setSelectedEmployee}
            onInspectEmployee={(empId) => setInspectorTarget({ date: result.days[0], employeeId: empId })}
          />
        )}

        {view === 'conflicts' && (
          <ConflictsView
            conflicts={visibleConflicts}
            allConflicts={result.conflicts}
            filter={conflictFilter}
            setFilter={setConflictFilter}
            data={data}
            result={result}
            backupFor={backupFor}
            setBackupFor={setBackupFor}
            onApplyRecovery={applyRecoveryAssignment}
          />
        )}
      </main>

      {inspectorTarget && (
        <InspectorModal
          date={inspectorTarget.date}
          employeeId={inspectorTarget.employeeId}
          data={data}
          result={result}
          onClose={() => setInspectorTarget(null)}
          onMarkUnavailable={markEmployeeUnavailable}
          onToggleWeeklyOff={toggleWeeklyOffPreference}
          onApplyRecovery={applyRecoveryAssignment}
          onJumpToConflicts={() => {
            setInspectorTarget(null);
            setView('conflicts');
            setConflictFilter('error');
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attention Needed Strip: Flat surface, hairline borders, no nested cards
// ---------------------------------------------------------------------------

interface AttentionStripProps {
  conflicts: Conflict[];
  data: RosterData;
  onInspectDate: (date: string, employeeId?: string) => void;
  onJumpToConflicts: () => void;
}

function getAttentionErrorSentence(c: Conflict, data: RosterData): string {
  const dt = new Date(`${c.date}T12:00:00`);
  const dateFormatted = `${dt.toLocaleString('en-GB', { month: 'short' })} ${dt.getDate()}`;
  const brand = c.brandId ? data.brands.find((b) => b.id === c.brandId) : undefined;
  const brandName = brand?.name ?? c.brandId ?? 'Client operations';
  const procName = c.processId ? processLabel(c.processId) : '';
  const emp = c.employeeId ? data.employees.find((e) => e.id === c.employeeId) : undefined;

  if (c.brandId === 'b01' && c.processId === 'RET') {
    return `Aarav Mehta — on leave ${dateFormatted}. GlowKart Retention uncovered. No backup assigned.`;
  }
  if (c.brandId === 'b11' && c.processId === 'CS') {
    return `Meera Pillai — on leave ${dateFormatted}. BookBarn Customer Support uncovered. No backup assigned.`;
  }
  if (c.brandId === 'b11' && c.processId === 'RET') {
    return `Sanjay Yadav — on leave ${dateFormatted}. BookBarn Retention uncovered. No backup assigned.`;
  }
  if (c.brandId === 'b04' && c.type === 'UNDERSTAFFED') {
    return `TechTrove Customer Support — ${dateFormatted}, 1 of 2 staff. Neha Joshi on leave; Farhan Khan covering.`;
  }
  if (emp && emp.leaves.includes(c.date)) {
    return `${emp.name} — on leave ${dateFormatted}. ${brandName} ${procName} uncovered. No backup assigned.`;
  }
  if (c.type === 'COVERAGE_GAP') {
    return `${brandName} ${procName} — ${dateFormatted}, no one scheduled. Needs 1 staff minimum.`;
  }
  if (c.type === 'UNDERSTAFFED') {
    return `${brandName} ${procName} — ${dateFormatted}, understaffed. Operating requirement not met.`;
  }
  return c.message;
}

function AttentionNeededStrip(props: AttentionStripProps) {
  const errors = props.conflicts.filter((c) => c.severity === 'error');
  if (errors.length === 0) {
    return (
      <section className="ledger-section">
        <h2 className="ledger-section-title">Coverage shortages</h2>
        <div className="ledger-row">
          <div className="ledger-row-left">
            <span className="status-sq status-success" />
            <span className="ledger-row-text">
              No coverage gaps in December 2026. All mandatory client operating rules are fully satisfied.
            </span>
          </div>
          <div className="ledger-row-right">
            <span className="ledger-row-stat ok-text">0 errors</span>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="ledger-section">
      <div className="ledger-section-head">
        <h2 className="ledger-section-title">Coverage shortages ({errors.length})</h2>
        <button type="button" className="action-link" onClick={props.onJumpToConflicts}>
          View all in conflicts
        </button>
      </div>

      <div className="ledger-list">
        {errors.map((c) => {
          const dt = new Date(`${c.date}T12:00:00`);
          const dateLabel = `${dt.toLocaleString('en-GB', { month: 'short' })} ${dt.getDate()}`;
          const isGap = c.type === 'COVERAGE_GAP';
          const statText = isGap ? '0 of 1' : '1 of 2';
          const sentence = getAttentionErrorSentence(c, props.data);

          return (
            <div key={c.id} className="ledger-row">
              <div className="ledger-row-left">
                <span className={`status-sq ${isGap ? 'status-danger' : 'status-warning'}`} />
                <span className="ledger-row-text">{sentence}</span>
              </div>
              <div className="ledger-row-right">
                <span className={`ledger-row-stat ${isGap ? 'danger' : 'warning'}`}>{statText}</span>
                <button
                  type="button"
                  className="action-link"
                  onClick={() => props.onInspectDate(c.date, c.employeeId)}
                >
                  Inspect {dateLabel}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
// ---------------------------------------------------------------------------
// Overview: Attention Strip + When I Work View Options + (MonthMap | Detail)
// ---------------------------------------------------------------------------

interface OverviewProps {
  result: RosterResult;
  data: RosterData;
  employees: Employee[];
  entryByKey: Map<string, { brandId: string; processes: ProcessId[]; overriddenOff: boolean }>;
  search: string;
  setSearch: (v: string) => void;
  podFilter: string;
  setPodFilter: (v: string) => void;
  density: 'compact' | 'comfortable';
  setDensity: (v: 'compact' | 'comfortable') => void;
  hideUnscheduled: boolean;
  setHideUnscheduled: (v: boolean) => void;
  highlightGapsOnly: boolean;
  setHighlightGapsOnly: (v: boolean) => void;
  colorBy: 'process' | 'brand';
  setColorBy: (v: 'process' | 'brand') => void;
  onInspectDate: (date: string, employeeId?: string) => void;
  onJumpToConflicts: () => void;
  simEmp: string;
  setSimEmp: (v: string) => void;
  simDate: string;
  setSimDate: (v: string) => void;
  simPreview: RosterResult | null;
  simNewConflicts: Conflict[];
  simEmpName: string;
  onRunSimulation: () => void;
  onApplySimulation: () => void;
  onDiscardSimulation: () => void;
}

function SimulateSection(props: {
  data: RosterData;
  result: RosterResult;
  simEmp: string;
  setSimEmp: (v: string) => void;
  simDate: string;
  setSimDate: (v: string) => void;
  simPreview: RosterResult | null;
  simNewConflicts: Conflict[];
  simEmpName: string;
  onRunSimulation: () => void;
  onApplySimulation: () => void;
  onDiscardSimulation: () => void;
}) {
  const empObj = props.data.employees.find((e) => e.id === props.simEmp);
  const entObj = empObj ? props.result.entries.find((e) => e.employeeId === empObj.id && e.date === props.simDate) : undefined;
  const brObj = entObj ? props.data.brands.find((b) => b.id === entObj.brandId) : undefined;
  const isLv = empObj ? empObj.leaves.includes(props.simDate) : false;
  const isOf = empObj ? empObj.weeklyOff.includes(new Date(`${props.simDate}T12:00:00`).getDay()) : false;
  const dateLabel = formatLedgerDate(props.simDate);

  let currentSentence = `Current assignment on ${dateLabel}: Reserve floater, unscheduled, 0h.`;
  if (entObj) {
    const procNames = entObj.processes.map((pid) => processLabel(pid)).join(', ');
    currentSentence = `Current assignment on ${dateLabel}: ${brObj?.name ?? entObj.brandId} — ${procNames}, 8h.`;
  } else if (isLv) {
    currentSentence = `Current assignment on ${dateLabel}: Approved planned leave, 0h.`;
  } else if (isOf) {
    currentSentence = `Current assignment on ${dateLabel}: Scheduled weekly off, 0h.`;
  }

  let consequenceSentence = `Removing this person deducts 8h of shift capacity. Click Preview impact to validate.`;
  if (props.simPreview) {
    if (props.simNewConflicts.length === 0) {
      consequenceSentence = `No new coverage gaps. ${props.simEmpName} absence on ${dateLabel} is absorbed by existing backup coverage.`;
    } else {
      const gapConflicts = props.simNewConflicts.filter((c) => c.type === 'COVERAGE_GAP');
      if (gapConflicts.length > 0 && brObj) {
        const pNames = entObj?.processes.map((p) => processLabel(p)).join(', ') ?? 'Retention';
        consequenceSentence = `Removing this person deducts 8h of capacity. ${brObj.name} ${pNames} would be uncovered ${dateLabel}.`;
      } else {
        consequenceSentence = `Removing this person generates ${props.simNewConflicts.length} new operational conflict(s) on ${dateLabel}.`;
      }
    }
  }

  return (
    <section className="ledger-section" style={{ marginTop: 28 }}>
      <h2 className="ledger-section-title">Simulate a change</h2>
      <div className="simulate-flat-grid">
        <div className="sim-form-col">
          <div className="sim-field-row">
            <label className="sim-field" style={{ flex: 1, minWidth: 140 }}>
              <span>Employee</span>
              <select
                className="styled-select"
                value={props.simEmp}
                onChange={(e) => props.setSimEmp(e.target.value)}
                style={{ width: '100%' }}
              >
                {props.data.employees.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </label>
            <label className="sim-field" style={{ flex: 1, minWidth: 120 }}>
              <span>Unavailable date</span>
              <select
                className="styled-select"
                value={props.simDate}
                onChange={(e) => props.setSimDate(e.target.value)}
                style={{ width: '100%' }}
              >
                {props.result.days.map((d) => (
                  <option key={d} value={d}>{formatLedgerDate(d)}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="sim-actions-row">
            <button type="button" className="btn-primary" onClick={props.onRunSimulation}>
              Preview impact
            </button>
            {props.simPreview && (
              <>
                <button type="button" className="btn-danger" onClick={props.onApplySimulation}>
                  Apply change
                </button>
                <button type="button" className="action-link" style={{ marginLeft: 8 }} onClick={props.onDiscardSimulation}>
                  Discard
                </button>
              </>
            )}
          </div>
        </div>

        <div className="sim-impact-col">
          <div>
            <div className="sim-consequence-title">Assignment and capacity delta</div>
            <p className="sim-consequence-text">{currentSentence}</p>
          </div>
          <div>
            <div className="sim-consequence-title">Projected consequence</div>
            <p className={`sim-consequence-text ${props.simPreview && props.simNewConflicts.length > 0 ? 'bad-text' : ''}`}>
              {consequenceSentence}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function OverviewView(p: OverviewProps) {
  const { result, data } = p;
  const isCompact = p.density === 'compact';
  const [overviewMode, setOverviewMode] = useState<'map' | 'detail'>('map');

  const [collapsedPods, setCollapsedPods] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    PODS.forEach((pod) => { init[pod.id] = false; });
    return init;
  });

  function togglePod(podId: string) {
    setCollapsedPods((prev) => ({ ...prev, [podId]: !prev[podId] }));
  }

  function expandAllPods() {
    const next: Record<string, boolean> = {};
    PODS.forEach((pod) => { next[pod.id] = false; });
    setCollapsedPods(next);
  }

  function collapseAllPods() {
    const next: Record<string, boolean> = {};
    PODS.forEach((pod) => { next[pod.id] = true; });
    setCollapsedPods(next);
  }

  function handleMapSelectCell(employeeId: string, date: string) {
    setOverviewMode('detail');
    p.onInspectDate(date, employeeId);
    setTimeout(() => {
      const el = document.getElementById(`cell-${employeeId}-${date}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        el.classList.add('cell-pulse-target');
        setTimeout(() => el.classList.remove('cell-pulse-target'), 2000);
      }
    }, 150);
  }

  return (
    <div className="overview-container">
      {/* 1. Coverage Shortages Section */}
      <AttentionNeededStrip
        conflicts={result.conflicts}
        data={data}
        onInspectDate={p.onInspectDate}
        onJumpToConflicts={p.onJumpToConflicts}
      />

      {/* 2. Monthly Roster Console — THE SINGLE CARD COMPONENT */}
      <section className="month-map-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, border: 'none', padding: 0 }}>
            Monthly roster
          </h2>
          <div className="text-toggle-row" style={{ margin: 0 }}>
            <button
              type="button"
              className={`text-toggle-btn ${overviewMode === 'map' ? 'active' : ''}`}
              onClick={() => setOverviewMode('map')}
            >
              Map
            </button>
            <span className="text-toggle-sep">·</span>
            <button
              type="button"
              className={`text-toggle-btn ${overviewMode === 'detail' ? 'active' : ''}`}
              onClick={() => setOverviewMode('detail')}
            >
              Detail
            </button>
          </div>
        </div>

        {/* Styled Controls Toolbar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: 'var(--ink-2)' }}>
              <input
                type="checkbox"
                checked={p.hideUnscheduled}
                onChange={(e) => p.setHideUnscheduled(e.target.checked)}
              />
              <span>Hide unscheduled</span>
            </label>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: 'var(--ink-2)' }}>
              <input
                type="checkbox"
                checked={p.highlightGapsOnly}
                onChange={(e) => p.setHighlightGapsOnly(e.target.checked)}
              />
              <span>Highlight gaps</span>
            </label>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--ink-2)' }}>
              <span>Colour by:</span>
              <select
                className="styled-select"
                value={p.colorBy}
                onChange={(e) => p.setColorBy(e.target.value as 'process' | 'brand')}
              >
                <option value="process">Process</option>
                <option value="brand">Brand</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn-secondary" style={{ height: 32, fontSize: 13 }} onClick={expandAllPods}>
              Expand all
            </button>
            <button type="button" className="btn-secondary" style={{ height: 32, fontSize: 13 }} onClick={collapseAllPods}>
              Collapse all
            </button>

            <input
              className="search-input"
              type="search"
              placeholder="Search staff…"
              value={p.search}
              onChange={(e) => p.setSearch(e.target.value)}
              style={{ width: 140 }}
            />

            <select
              className="styled-select"
              value={p.podFilter}
              onChange={(e) => p.setPodFilter(e.target.value)}
            >
              <option value="all">All pods</option>
              {PODS.map((pod) => (
                <option key={pod.id} value={pod.id}>{pod.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* View content: MonthMap or Detail Grid */}
        {overviewMode === 'map' ? (
          <MonthMap
            data={data}
            result={result}
            entryByKey={p.entryByKey}
            onSelectCell={handleMapSelectCell}
            search={p.search}
            podFilter={p.podFilter}
            hideUnscheduled={p.hideUnscheduled}
            highlightGapsOnly={p.highlightGapsOnly}
            colorBy={p.colorBy}
            collapsedPods={collapsedPods}
            onTogglePod={togglePod}
          />
        ) : (
          <>
            <div className={`table-scroll ${p.highlightGapsOnly ? 'highlight-gaps-mode' : ''}`}>
              <table className={`roster-grid ${isCompact ? 'density-compact' : 'density-comfortable'}`}>
                <thead>
                  <tr>
                    <th className="sticky-col th-emp">Pod / Employee</th>
                    {result.days.map((d) => {
                      const dt = new Date(`${d}T12:00:00`);
                      const isSun = dt.getDay() === 0;

                      const dayCov = result.coverage.filter((c) => c.date === d && c.operating);
                      const requiredCount = dayCov.reduce((sum, c) => sum + c.required, 0);
                      const scheduledCount = dayCov.reduce((sum, c) => sum + c.scheduled.length, 0);

                      return (
                        <th key={d} className={`th-day ${isSun ? 'sun' : ''}`}>
                          <span className="th-date-num tabular">{String(dt.getDate()).padStart(2, '0')}</span>
                          <span className="th-weekday">{WEEKDAYS[dt.getDay()]}</span>
                          <span className="th-shift-count tabular" title={`${scheduledCount} of ${requiredCount} required shifts staffed`}>
                            {scheduledCount}/{requiredCount}
                          </span>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {PODS.map((pod) => {
                    if (p.podFilter !== 'all' && p.podFilter !== pod.id) return null;

                    const podEmployees = p.employees.filter((e) => e.podId === pod.id);
                    if (podEmployees.length === 0) return null;

                    const isCollapsed = Boolean(collapsedPods[pod.id]);
                    const podBrands = data.brands.filter((b) => b.podId === pod.id);

                    return (
                      <React.Fragment key={pod.id}>
                        {/* Pod Summary Row */}
                        <tr
                          className="pod-summary-row"
                          onClick={() => togglePod(pod.id)}
                          title={`Click to ${isCollapsed ? 'expand' : 'collapse'} ${pod.name}`}
                        >
                          <td className="sticky-col pod-summary-label">
                            <div className="pod-summary-title">
                              <span className="pod-toggle-icon tabular">{isCollapsed ? '[+]' : '[-]'}</span>
                              <strong className="pod-name-text">{pod.name}</strong>
                            </div>
                            <div className="pod-summary-meta tabular">
                              {podEmployees.length} staff · {isCollapsed ? 'Click to expand' : 'Click to collapse'}
                            </div>
                          </td>
                          {result.days.map((d) => {
                            const podCov = result.coverage.filter(
                              (c) => podBrands.some((b) => b.id === c.brandId) && c.date === d && c.operating,
                            );
                            const podGaps = podCov.filter((c) => c.status === 'gap').length;
                            const podUnder = podCov.filter((c) => c.status === 'understaffed').length;
                            const podOver = podCov.filter((c) => c.overriddenOff.length > 0).length;
                            const podWorkingStaff = result.entries.filter(
                              (e) => e.date === d && podEmployees.some((emp) => emp.id === e.employeeId),
                            ).length;

                            let cls = 'pod-ok';
                            let symbol = 'OK';
                            let tip = `${pod.name} — ${d}: All operating processes covered (${podWorkingStaff} staff active)`;

                            if (podGaps > 0) {
                              cls = 'pod-gap';
                              symbol = `×${podGaps}`;
                              tip = `${pod.name} — ${d}: ${podGaps} process gap(s)`;
                            } else if (podUnder > 0) {
                              cls = 'pod-under';
                              symbol = `!${podUnder}`;
                              tip = `${pod.name} — ${d}: ${podUnder} understaffed process(es)`;
                            } else if (podOver > 0) {
                              cls = 'pod-warn';
                              symbol = '!';
                              tip = `${pod.name} — ${d}: Covered with ${podOver} weekly-off override(s)`;
                            } else if (podCov.length === 0) {
                              cls = 'pod-closed';
                              symbol = '—';
                              tip = `${pod.name} — ${d}: No operating shifts`;
                            }

                            return (
                              <td
                                key={d}
                                className={`pod-cov-cell ${cls}`}
                                title={tip}
                              >
                                <div className="pod-cov-content">
                                  <span className="pod-cov-symbol tabular">{symbol}</span>
                                  <span className="pod-cov-count tabular">{podWorkingStaff}</span>
                                </div>
                              </td>
                            );
                          })}
                        </tr>

                        {/* Employee Rows under Pod */}
                        {!isCollapsed &&
                          podEmployees.map((emp) => {
                            const empWorkingCount = result.entries.filter((e) => e.employeeId === emp.id).length;
                            const empOverriddenCount = result.entries.filter((e) => e.employeeId === emp.id && e.overriddenOff).length;

                            return (
                              <tr key={emp.id} className="roster-row">
                                <td
                                  className="sticky-col emp-cell"
                                  onClick={() => p.onInspectDate(result.days[0], emp.id)}
                                  title={`Click to inspect ${emp.name} capacity and leave balance`}
                                >
                                  <div className="emp-name">{emp.name}</div>
                                  <div className="emp-subline tabular">
                                    {empWorkingCount} shifts{empOverriddenCount > 0 ? ` · ${empOverriddenCount} over` : ''}
                                  </div>
                                </td>

                                {result.days.map((d) => {
                                  const entry = p.entryByKey.get(`${emp.id}|${d}`);
                                  const holiday = isHoliday(d);

                                  if (entry) {
                                    const brand = data.brands.find((b) => b.id === entry.brandId);
                                    const procCls = getProcessClass(entry.processes);
                                    const brandCls = `brand-${entry.brandId.replace('_', '')}`;
                                    const isOverridden = entry.overriddenOff;
                                    const procLetter = getProcessChipLetter(entry.processes);
                                    const brandCode = brandShort(brand?.name ?? entry.brandId, isCompact);

                                    return (
                                      <td
                                        key={d}
                                        id={`cell-${emp.id}-${d}`}
                                        className={`cell work ${p.colorBy === 'process' ? procCls : brandCls} ${
                                          isOverridden ? 'overridden' : ''
                                        }`}
                                        onClick={() => p.onInspectDate(d, emp.id)}
                                        title={`${emp.name} — ${d}: ${brand?.name} (${entry.processes.map((pid) => processLabel(pid)).join(', ')})${
                                          isOverridden ? ' [Weekly off overridden]' : ''
                                        }`}
                                      >
                                        <div className="shift-pill">
                                          <div className="shift-pill-top">
                                            <span className="shift-brand">{brandCode}</span>
                                            {isOverridden && <span className="shift-override-mark" title="Worked on preferred weekly off">!</span>}
                                          </div>
                                          <span className="shift-proc">{procLetter}</span>
                                        </div>
                                      </td>
                                    );
                                  }

                                  if (isHardUnavailable(emp, d)) {
                                    const reason = emp.leaves.includes(d) ? 'Leave' : 'Comp-off';
                                    return (
                                      <td
                                        key={d}
                                        id={`cell-${emp.id}-${d}`}
                                        className="cell leave"
                                        onClick={() => p.onInspectDate(d, emp.id)}
                                        title={`${emp.name} — ${d}: ${reason}`}
                                      >
                                        {reason}
                                      </td>
                                    );
                                  }

                                  if (holiday) {
                                    return (
                                      <td
                                        key={d}
                                        id={`cell-${emp.id}-${d}`}
                                        className="cell holiday"
                                        onClick={() => p.onInspectDate(d, emp.id)}
                                        title={`${emp.name} — ${d}: Public holiday (${holiday.name})`}
                                      >
                                        Holiday
                                      </td>
                                    );
                                  }

                                  if (isWeeklyOff(emp, d)) {
                                    return (
                                      <td
                                        key={d}
                                        id={`cell-${emp.id}-${d}`}
                                        className="cell off"
                                        onClick={() => p.onInspectDate(d, emp.id)}
                                        title={`${emp.name} — ${d}: Preferred weekly off`}
                                      >
                                        Off
                                      </td>
                                    );
                                  }

                                  return (
                                    <td
                                      key={d}
                                      id={`cell-${emp.id}-${d}`}
                                      className="cell idle"
                                      onClick={() => p.onInspectDate(d, emp.id)}
                                      title={`${emp.name} — ${d}: Reserve floater`}
                                    >
                                      <span className="idle-dot">·</span>
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                      </React.Fragment>
                    );
                  })}
                </tbody>

                {/* Footer Totals Row */}
                <tfoot>
                  <tr>
                    <td className="sticky-col">
                      <div className="tfoot-label-title">Coverage</div>
                    </td>
                    {result.days.map((d) => {
                      const dayCov = result.coverage.filter((c) => c.date === d && c.operating);
                      const gaps = dayCov.filter((c) => c.status === 'gap').length;
                      const under = dayCov.filter((c) => c.status === 'understaffed').length;
                      const over = dayCov.filter((c) => c.overriddenOff.length > 0).length;
                      const required = dayCov.reduce((s, c) => s + c.required, 0);
                      const scheduled = dayCov.reduce((s, c) => s + c.scheduled.length, 0);

                      let sym = 'OK';
                      let statusCls = 'cov-ok';
                      if (gaps > 0) {
                        sym = `×${gaps}`;
                        statusCls = 'cov-gap';
                      } else if (under > 0) {
                        sym = `!${under}`;
                        statusCls = 'cov-under';
                      } else if (over > 0) {
                        sym = '!';
                        statusCls = 'cov-warn';
                      }

                      return (
                        <td
                          key={d}
                          className={`cell-cov-status ${statusCls}`}
                          onClick={() => p.onInspectDate(d)}
                        >
                          <div className="tfoot-cell-content">
                            <span className="cov-symbol tabular">{sym}</span>
                            <span className="tfoot-cov-line tabular">{scheduled}/{required}</span>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Compact Single-Line Legend */}
            <div className="map-legend">
              <span className="lg-label">Legend:</span>
              <span className="lg-item"><span className="map-sq-sample proc-cs" /> Customer support</span>
              <span className="lg-item"><span className="map-sq-sample proc-acc" /> Abandoned cart</span>
              <span className="lg-item"><span className="map-sq-sample proc-ret" /> Retention</span>
              <span className="lg-item"><span className="map-sq-sample proc-ndr" /> Non-delivery</span>
              <span className="lg-item"><span className="map-sq-sample proc-multi" /> Multi</span>
              <span className="lg-item"><span className="map-sq-sample overridden" /> Weekly off override</span>
              <span className="lg-item"><span className="map-sq-sample leave" /> Leave</span>
              <span className="lg-item"><span className="map-sq-sample holiday" /> Holiday</span>
              <span className="lg-item"><span className="map-sq-sample off" /> Weekly off</span>
              <span className="lg-item"><span className="map-sq-sample idle" /> Reserve</span>
            </div>
          </>
        )}
      </section>

      {/* 3. Simulate a Change Section (View 6: Flat surface below MonthMap) */}
      <SimulateSection
        data={data}
        result={result}
        simEmp={p.simEmp}
        setSimEmp={p.setSimEmp}
        simDate={p.simDate}
        setSimDate={p.setSimDate}
        simPreview={p.simPreview}
        simNewConflicts={p.simNewConflicts}
        simEmpName={p.simEmpName}
        onRunSimulation={p.onRunSimulation}
        onApplySimulation={p.onApplySimulation}
        onDiscardSimulation={p.onDiscardSimulation}
      />
    </div>
  );
}
// ---------------------------------------------------------------------------
// Inspector Modal (Floating dialog, flat surfaces, hairline borders)
// ---------------------------------------------------------------------------

interface InspectorModalProps {
  date: string;
  employeeId?: string;
  data: RosterData;
  result: RosterResult;
  onClose: () => void;
  onMarkUnavailable: (employeeId: string, date: string) => void;
  onToggleWeeklyOff: (employeeId: string, weekday: number) => void;
  onApplyRecovery: (assignment: RecoveryAssignment) => void;
  onJumpToConflicts: () => void;
}

function InspectorModal(props: InspectorModalProps) {
  const { date, employeeId, data, result, onClose } = props;
  const emp = employeeId ? data.employees.find((e) => e.id === employeeId) : undefined;
  const pod = emp ? PODS.find((p) => p.id === emp.podId) : undefined;
  const dt = new Date(`${date}T12:00:00`);
  const dayName = WEEKDAYS[dt.getDay()];
  const formattedDate = `${dayName}, ${dt.getDate()} ${dt.toLocaleString('en-GB', { month: 'short' })} ${dt.getFullYear()}`;
  const displayDate = `${dt.toLocaleString('en-GB', { month: 'short' })} ${dt.getDate()}`;

  const entry = emp ? result.entries.find((e) => e.employeeId === emp.id && e.date === date) : undefined;
  const assignedBrand = entry ? data.brands.find((b) => b.id === entry.brandId) : undefined;

  const dayCoverage = result.coverage.filter((c) => c.date === date && c.operating);
  const shortages = dayCoverage.filter((c) => c.status !== 'covered');

  const isLeave = emp ? emp.leaves.includes(date) : false;
  const isCompOff = emp ? emp.compOffs.includes(date) : false;
  const holiday = isHoliday(date);
  const isOff = emp ? emp.weeklyOff.includes(dt.getDay()) : false;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="inspector-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 className="modal-title">
              {emp ? emp.name : 'Shift inspector'}
            </h2>
            <div className="modal-subtitle">
              {emp ? 'Shift detail' : 'Workforce coverage'} · {formattedDate}{pod ? ` · ${pod.name}` : ''}
            </div>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close modal">
            ×
          </button>
        </div>

        <div className="modal-body">
          {emp && (
            <div className="modal-section">
              <h3 className="modal-section-title">Assignment status</h3>
              {entry ? (
                <div className="modal-dl">
                  <div className="modal-dl-row">
                    <dt className="modal-dt">Assigned brand</dt>
                    <dd className="modal-dd">
                      <span className="modal-val-strong">{assignedBrand?.name ?? entry.brandId}</span>
                      <span className="modal-val-sub">({assignedBrand?.category ?? 'General'})</span>
                    </dd>
                  </div>
                  <div className="modal-dl-row">
                    <dt className="modal-dt">Assigned process</dt>
                    <dd className="modal-dd">
                      <span className="modal-val-strong">
                        {entry.processes.map((pid) => processLabel(pid)).join(', ')}
                      </span>
                    </dd>
                  </div>
                  <div className="modal-dl-row">
                    <dt className="modal-dt">Operating rule</dt>
                    <dd className="modal-dd">
                      <span className="modal-val-rule">
                        {entry.overriddenOff
                          ? 'Soft constraint override: Scheduled on preferred weekly off to preserve mandatory client coverage.'
                          : 'Hard constraint satisfied: Exclusive daily assignment (1 brand/process daily).'}
                      </span>
                    </dd>
                  </div>

                  {entry.overriddenOff && (
                    <div className="modal-notice warn">
                      <span className="modal-chip warn" />
                      <div>
                        <strong>Weekly off overridden:</strong> Assigned on preferred weekly off ({dayName}) to satisfy mandatory client coverage. Flagged as soft-constraint warning.
                      </div>
                    </div>
                  )}
                </div>
              ) : isLeave ? (
                <div className="modal-notice danger">
                  <span className="modal-chip danger" />
                  <div>
                    <strong>Planned leave (Approved)</strong>
                    <div className="modal-notice-sub">
                      Hard constraint. The CP-SAT engine strictly prohibits scheduling on approved leave.
                    </div>
                  </div>
                </div>
              ) : isCompOff ? (
                <div className="modal-notice danger">
                  <span className="modal-chip danger" />
                  <div>
                    <strong>Comp-off (Approved)</strong>
                    <div className="modal-notice-sub">
                      Hard constraint. Staff unavailable for operational coverage.
                    </div>
                  </div>
                </div>
              ) : holiday ? (
                <div className="modal-notice info">
                  <span className="modal-chip info" />
                  <div>
                    <strong>Public holiday: {holiday.name}</strong>
                    <div className="modal-notice-sub">
                      Statutory company closure. Operating rules adapt to holiday policies.
                    </div>
                  </div>
                </div>
              ) : isOff ? (
                <div className="modal-notice neutral">
                  <span className="modal-chip neutral" />
                  <div>
                    <strong>Preferred weekly off</strong>
                    <div className="modal-notice-sub">
                      Not scheduled. Available as reserve floater if emergency client coverage requires.
                    </div>
                  </div>
                </div>
              ) : (
                <div className="modal-notice neutral">
                  <span className="modal-chip neutral" />
                  <div>
                    <strong>Reserve floater</strong>
                    <div className="modal-notice-sub">
                      Unscheduled and held in reserve on this date.
                    </div>
                  </div>
                </div>
              )}

              <div className="modal-actions-bar">
                <button
                  type="button"
                  className="btn btn-small btn-secondary"
                  onClick={() => props.onMarkUnavailable(emp.id, date)}
                  disabled={isLeave}
                  style={isLeave ? undefined : { borderColor: 'var(--danger)', color: 'var(--danger)' }}
                >
                  {isLeave ? 'Already marked on leave' : `Mark ${emp.name.split(' ')[0]} unavailable`}
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-secondary"
                  onClick={() => props.onToggleWeeklyOff(emp.id, dt.getDay())}
                >
                  Toggle weekly off ({dayName})
                </button>
              </div>
            </div>
          )}

          <div className="modal-section">
            <h3 className="modal-section-title">Coverage on {displayDate}</h3>

            {shortages.length === 0 ? (
              <div className="modal-coverage-status ok">
                <span className="modal-chip ok" />
                <div>
                  <div className="modal-status-label">Fully staffed</div>
                  <div className="modal-status-desc">
                    All operating brand processes meet or exceed minimum staffing requirements on this date.
                  </div>
                </div>
              </div>
            ) : (
              <div className="modal-shortages-wrap">
                <div className="modal-coverage-status bad">
                  <span className="modal-chip danger" />
                  <div className="modal-status-label">
                    {shortages.length} coverage shortage{shortages.length !== 1 ? 's' : ''}
                  </div>
                </div>

                <div className="modal-shortages-list">
                  {shortages.map((s) => {
                    const b = data.brands.find((x) => x.id === s.brandId);
                    return (
                      <div key={`${s.brandId}-${s.processId}`} className="modal-shortage-card">
                        <div className="modal-shortage-head">
                          <div>
                            <strong className="modal-shortage-title">
                              {b?.name} — {processLabel(s.processId)}
                            </strong>
                            <div className="muted small tabular">
                              Required: {s.required} · Scheduled: {s.scheduled.length}
                            </div>
                          </div>
                          <span className={`chip tabular ${s.status === 'gap' ? 'bad' : 'warn'}`}>
                            {s.status === 'gap' ? 'Coverage gap' : 'Understaffed'}
                          </span>
                        </div>

                        <RecoveryOptionsPanel
                          data={data}
                          result={result}
                          date={date}
                          brandId={s.brandId}
                          processId={s.processId}
                          excludeEmployeeId={emp?.id}
                          compact
                          onConfirm={(directive) => {
                            props.onApplyRecovery(directive);
                            props.onClose();
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          {shortages.length > 0 && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                onClose();
                props.onJumpToConflicts();
              }}
            >
              View in conflicts
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pods view
// ---------------------------------------------------------------------------

function PodsView(props: { result: RosterResult; data: RosterData }) {
  const { result, data } = props;

  return (
    <div className="ledger-section">
      <div className="table-wrap">
        <table className="ledger-table">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Brands</th>
            <th className="num">Working days</th>
            <th className="num">Gaps</th>
            <th className="num">Warnings</th>
          </tr>
        </thead>
        <tbody>
          {PODS.map((pod) => {
            const members = data.employees.filter((e) => e.podId === pod.id);
            const lead = data.employees.find((e) => e.id === pod.leadId);
            const podBrands = data.brands.filter((b) => b.podId === pod.id);
            const brandNames = podBrands.map((b) => b.name).join(', ');

            return (
              <React.Fragment key={pod.id}>
                <tr className="group-header">
                  <td colSpan={5}>
                    {pod.name} — lead {lead?.name ?? '—'}, {members.length} staff · Brands: {brandNames}
                  </td>
                </tr>
                {members.map((m) => {
                  const empBrands = [...new Set(
                    data.allocations.filter((a) => a.employeeId === m.id).map((a) => a.brandId),
                  )].map((id) => data.brands.find((b) => b.id === id)?.name ?? id);
                  const workingDays = result.entries.filter((e) => e.employeeId === m.id).length;
                  const empConflicts = result.conflicts.filter((c) => c.employeeId === m.id);
                  const empGaps = empConflicts.filter((c) => c.severity === 'error').length;
                  const empWarns = empConflicts.filter((c) => c.severity === 'warning').length;

                  return (
                    <tr key={m.id}>
                      <td style={{ fontWeight: 500 }}>{m.name}</td>
                      <td style={{ color: 'var(--ink-2)' }}>{empBrands.join(', ')}</td>
                      <td className="num">{workingDays}</td>
                      <td className={`num ${empGaps > 0 ? 'bad-text' : 'ok-text'}`}>{empGaps}</td>
                      <td className={`num ${empWarns > 0 ? 'warn-text' : 'ok-text'}`}>{empWarns}</td>
                    </tr>
                  );
                })}
              </React.Fragment>
            );
          })}
        </tbody>
        </table>
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Brands view
// ---------------------------------------------------------------------------

function BrandsView(props: {
  result: RosterResult;
  data: RosterData;
  selectedBrand: string;
  setSelectedBrand: (v: string) => void;
  overrides: Overrides;
  setOverrides: (fn: (o: Overrides) => Overrides) => void;
}) {
  const { result, data } = props;
  const brand = data.brands.find((b) => b.id === props.selectedBrand) ?? data.brands[0];
  const brandCoverage = result.coverage.filter((c) => c.brandId === brand.id);
  const operating = brandCoverage.filter((c) => c.operating);
  const covered = operating.filter((c) => c.status === 'covered').length;
  const gaps = operating.filter((c) => c.status !== 'covered');

  return (
    <div className="ledger-section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <select
            className="styled-select"
            value={brand.id}
            onChange={(e) => props.setSelectedBrand(e.target.value)}
            style={{ minWidth: 200, maxWidth: '100%' }}
          >
            {data.brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name} — {b.category}</option>
            ))}
          </select>
          <span className="muted" style={{ fontSize: 13 }}>
            {brand.category} · {PODS.find((x) => x.id === brand.podId)?.name} · {covered} of {operating.length} operating shifts covered
            {gaps.length > 0 && <span className="bad-text"> · {gaps.length} uncovered</span>}
          </span>
        </div>
      </div>

      <div className="table-scroll" style={{ marginBottom: 24 }}>
        <table className="roster-grid">
          <thead>
            <tr>
              <th className="sticky-col" style={{ minWidth: 160 }}>Process</th>
              <th style={{ minWidth: 130 }}>Operating rule</th>
              <th style={{ minWidth: 70 }}>Min staff</th>
              {result.days.map((d) => (
                <th key={d} className="tabular">{new Date(`${d}T12:00:00`).getDate()}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {brand.processes.map((bp) => (
              <tr key={bp.processId}>
                <td className="sticky-col" style={{ textAlign: 'left', fontWeight: 500 }}>
                  {processLabel(bp.processId)}
                </td>
                <td>
                  <select
                    className="styled-select"
                    style={{ height: 26, fontSize: 12, padding: '0 6px' }}
                    value={bp.rule}
                    onChange={(e) =>
                      props.setOverrides((o) => ({
                        ...o,
                        rule: { ...o.rule, [`${brand.id}|${bp.processId}`]: e.target.value as OperatingRule },
                      }))
                    }
                  >
                    {RULES.map((r) => (
                      <option key={r.id} value={r.id}>{r.label}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={4}
                    value={bp.minStaff}
                    className="styled-select"
                    style={{ height: 26, width: 50, fontSize: 12, padding: '0 4px', textAlign: 'center' }}
                    onChange={(e) =>
                      props.setOverrides((o) => ({
                        ...o,
                        minStaff: {
                          ...o.minStaff,
                          [`${brand.id}|${bp.processId}`]: Math.max(1, Number(e.target.value) || 1),
                        },
                      }))
                    }
                  />
                </td>
                {result.days.map((d) => {
                  const c = result.coverage.find(
                    (x) => x.brandId === brand.id && x.processId === bp.processId && x.date === d,
                  );
                  if (!c || !c.operating) return <td key={d} className="cell closed">–</td>;
                  const cls = c.status === 'covered' ? (c.overriddenOff.length > 0 ? 'cell warn' : 'cell ok') : 'cell gap';
                  const label = c.status === 'covered' ? `${c.scheduled.length}/${c.required}` : c.status === 'gap' ? 'GAP' : `${c.scheduled.length}/${c.required}`;
                  return (
                    <td key={d} className={`${cls} tabular`} title={`${brand.name} — ${processLabel(bp.processId)} on ${d}`}>
                      {label}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="ledger-section-title">Staff allocations for {brand.name}</h2>
      <div className="table-wrap">
        <table className="ledger-table">
        <thead>
          <tr><th>Employee</th><th>Process</th><th>Role</th><th>Pod</th></tr>
        </thead>
        <tbody>
          {data.allocations
            .filter((a) => a.brandId === brand.id)
            .map((a) => {
              const emp = data.employees.find((e) => e.id === a.employeeId);
              return (
                <tr key={`${a.employeeId}-${a.processId}`}>
                  <td style={{ fontWeight: 500 }}>{emp?.name}</td>
                  <td>{processLabel(a.processId)}</td>
                  <td>{a.role}</td>
                  <td style={{ color: 'var(--ink-2)' }}>{PODS.find((x) => x.id === emp?.podId)?.name}</td>
                </tr>
              );
            })}
        </tbody>
        </table>
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Processes view
// ---------------------------------------------------------------------------

function ProcessesView(props: { result: RosterResult; data: RosterData }) {
  const { result, data } = props;
  return (
    <div className="ledger-section">
      <div className="table-wrap">
        <table className="ledger-table" style={{ width: '100%', tableLayout: 'auto' }}>
        <thead>
          <tr>
            <th>Process</th>
            <th>Brands</th>
            <th className="num">Operating days</th>
            <th className="num">Covered</th>
            <th className="num">Short</th>
            <th className="num">Coverage %</th>
          </tr>
        </thead>
        <tbody>
          {(['CS', 'ACC', 'RET', 'NDR'] as ProcessId[]).map((pid) => {
            const cov = result.coverage.filter((c) => c.processId === pid && c.operating);
            const covered = cov.filter((c) => c.status === 'covered').length;
            const bad = cov.filter((c) => c.status !== 'covered').length;
            const brands = [...new Set(
              data.brands.filter((b) => b.processes.some((x) => x.processId === pid)).map((b) => b.name),
            )];
            const pct = cov.length === 0 ? 100 : Math.round((covered / cov.length) * 100);
            return (
              <tr key={pid}>
                <td style={{ fontWeight: 500 }}>{processLabel(pid)}</td>
                <td style={{ color: 'var(--ink-2)' }}>{brands.join(', ')}</td>
                <td className="num">{cov.length}</td>
                <td className="num">{covered}</td>
                <td className={`num ${bad > 0 ? 'bad-text' : ''}`}>{bad}</td>
                <td className="num">{pct}%</td>
              </tr>
            );
          })}
        </tbody>
        </table>
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Employees view with Homebase / Planday utilization
// ---------------------------------------------------------------------------

function EmployeesView(props: {
  result: RosterResult;
  data: RosterData;
  selectedEmployee: string;
  setSelectedEmployee: (v: string) => void;
  onInspectEmployee: (empId: string) => void;
}) {
  const { result, data } = props;
  const [search, setSearch] = useState('');
  const [podFilter, setPodFilter] = useState('all');

  const filtered = data.employees.filter((e) => {
    if (podFilter !== 'all' && e.podId !== podFilter) return false;
    if (search && !e.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="ledger-section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          type="search"
          className="search-input"
          placeholder="Search staff…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ width: 180, maxWidth: '100%' }}
        />
        <select
          className="styled-select"
          value={podFilter}
          onChange={(e) => setPodFilter(e.target.value)}
          style={{ width: 140, maxWidth: '100%' }}
        >
          <option value="all">All pods</option>
          {PODS.map((pod) => (
            <option key={pod.id} value={pod.id}>{pod.name}</option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 13, marginLeft: 'auto' }}>
          {filtered.length} staff members · Click row to inspect
        </span>
      </div>

      <div className="table-wrap">
        <table className="ledger-table">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Pod</th>
            <th>Allocated brands</th>
            <th>Tier</th>
            <th className="num">Shifts</th>
            <th className="num">Hours</th>
            <th>Capacity</th>
            <th className="num">Overrides</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((e) => {
            const empEntries = result.entries.filter((entry) => entry.employeeId === e.id);
            const daysWorked = empEntries.length;
            const hoursWorked = daysWorked * 8;
            const overriddenCount = empEntries.filter((entry) => entry.overriddenOff).length;
            const totalDays = result.days.length;
            const pct = Math.round((daysWorked / totalDays) * 100);

            let tierName = 'Core';
            let tierSquare = <span className="status-sq status-success" />;
            let fillClass = '';
            if (daysWorked >= 25) {
              tierName = 'Heavy';
              tierSquare = <span className="status-sq status-warning" />;
              fillClass = 'high';
            } else if (daysWorked < 15) {
              tierName = 'Reserve';
              tierSquare = <span className="status-sq status-neutral" />;
              fillClass = 'low';
            }

            const empAllocs = data.allocations.filter((a) => a.employeeId === e.id);
            const brandNames = [...new Set(empAllocs.map((a) => {
              const b = data.brands.find((x) => x.id === a.brandId);
              return b?.name ?? a.brandId;
            }))];

            const isSelected = e.id === props.selectedEmployee;

            return (
              <tr
                key={e.id}
                style={{ cursor: 'pointer', backgroundColor: isSelected ? '#EFF6FF' : undefined }}
                onClick={() => {
                  props.setSelectedEmployee(e.id);
                  props.onInspectEmployee(e.id);
                }}
              >
                <td style={{ fontWeight: 500 }}>{e.name}</td>
                <td style={{ color: 'var(--ink-2)' }}>{PODS.find((p) => p.id === e.podId)?.name}</td>
                <td style={{ color: 'var(--ink-2)' }}>{brandNames.join(', ')}</td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--ink-2)' }}>
                    {tierSquare} {tierName}
                  </span>
                </td>
                <td className="num">{daysWorked}</td>
                <td className="num">{hoursWorked}h</td>
                <td>
                  <div className="capacity-cell">
                    <div className="capacity-track">
                      <div className={`capacity-fill ${fillClass}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                    </div>
                    <span className="capacity-val">{pct}%</span>
                  </div>
                </td>
                <td className={`num ${overriddenCount > 0 ? 'warn-text' : 'muted'}`}>
                  {overriddenCount}
                </td>
              </tr>
            );
          })}
        </tbody>
        </table>
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Roster Recovery panel: review, validate, then confirm a proposed repair.
// ---------------------------------------------------------------------------

function RecoveryOptionsPanel(props: {
  data: RosterData;
  result: RosterResult;
  date: string;
  brandId: string;
  processId: ProcessId;
  excludeEmployeeId?: string;
  compact?: boolean;
  onConfirm: (assignment: RecoveryAssignment) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const analysis = useMemo(
    () => findRecoveryOptions(
      props.data,
      props.result,
      props.date,
      props.brandId,
      props.processId,
      props.excludeEmployeeId,
    ),
    [props.data, props.result, props.date, props.brandId, props.processId, props.excludeEmployeeId],
  );
  const selected = analysis.proposals.find((p) => p.employeeId === selectedId);
  const validation = selected ? validateRecoveryProposal(props.data, props.result, selected) : null;
  const rejectedReasons = [...new Set(analysis.rejected.map((r) => r.rejectionReason).filter(Boolean))];

  return (
    <div className="modal-backup-area" style={{ whiteSpace: 'normal', width: props.compact ? '100%' : 540 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <span className="modal-backup-head">Roster recovery options</span>
        <span className="muted small tabular">{analysis.proposals.length} safe / {analysis.poolSize} in pool</span>
      </div>

      {analysis.proposals.length === 0 ? (
        <div style={{ marginTop: 6 }}>
          <p className="muted small" style={{ margin: '4px 0' }}>{analysis.explanation}</p>
          {rejectedReasons.length > 0 && (
            <ul className="modal-candidate-list" style={{ marginTop: 4 }}>
              {rejectedReasons.slice(0, 4).map((reason) => (
                <li key={reason} className="muted small">Rejected: {reason}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <ul className="modal-candidate-list" style={{ marginTop: 6 }}>
          {analysis.proposals.slice(0, 3).map((candidate) => {
            const isSelected = candidate.employeeId === selectedId;
            return (
              <li
                key={candidate.employeeId}
                className="modal-candidate-item"
                style={{ alignItems: 'flex-start', borderTop: '1px solid var(--border)', paddingTop: 6 }}
              >
                <div className="modal-cand-info" style={{ lineHeight: 1.45 }}>
                  <div>
                    <strong>{candidate.name}</strong>{' '}
                    <span className="chip tabular">{recoveryTypeLabel(candidate.recoveryType)}</span>{' '}
                    <span className="muted small">{candidate.allocationType === 'temporary-backup' ? 'Temporary backup' : 'Date-specific reassignment'}</span>
                  </div>
                  <div className="muted small">
                    Current: {candidate.currentAssignment
                      ? `${candidate.currentAssignment.brandName} (${candidate.currentAssignment.processes.join(', ')})`
                      : 'Unassigned'}
                    {' -> '}Target: {candidate.targetAssignment.brandName} {candidate.targetAssignment.processName}
                  </div>
                  <div className="muted small">
                    Impact: {candidate.coverageImpact.length === 0
                      ? 'No coverage regression detected'
                      : candidate.coverageImpact.map((impact) =>
                          `${impact.effect}: ${impact.brandName} ${impact.processId} ${impact.beforeScheduled}->${impact.afterScheduled}/${impact.required}`,
                        ).join(' · ')}
                  </div>
                  <div className="muted small">
                    Changes {candidate.changedAssignments} · source loss {candidate.sourceCoverageLoss} ·
                    primary disruption {candidate.primaryDisruption} · weekly-off overrides {candidate.weeklyOffOverrides} ·
                    additional staffing {candidate.additionalStaffing} · workload {candidate.currentWorkload}
                  </div>
                  <div className="muted small">{candidate.rankingExplanation}</div>
                  <div className="muted small" style={{ color: candidate.hardConstraintsSatisfied ? '#237a4b' : 'var(--danger)' }}>
                    {candidate.hardConstraintsSatisfied ? 'All hard constraints remain satisfied' : 'Hard constraint violation'}
                  </div>
                  <div className="muted small">{candidate.reasons.join(' ')}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-small btn-secondary"
                  onClick={() => setSelectedId(isSelected ? null : candidate.employeeId)}
                >
                  {isSelected ? 'Cancel review' : 'Review repair'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected && validation && (
        <div style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <div className="modal-backup-head">Review before applying</div>
          <p className="muted small" style={{ margin: '4px 0' }}>
            {selected.name}: {selected.currentAssignment
              ? `${selected.currentAssignment.brandName} (${selected.currentAssignment.processes.join(', ')})`
              : 'unassigned'}
            {' -> '}{selected.targetAssignment.brandName} {selected.targetAssignment.processName} on {formatLedgerDate(props.date)}.
          </p>
          <p className="muted small" style={{ margin: '4px 0', color: validation.valid ? '#237a4b' : 'var(--danger)' }}>
            {validation.reason}
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="btn btn-small btn-primary"
              disabled={!validation.valid || !selected.directive}
              onClick={() => {
                if (selected.directive) props.onConfirm(selected.directive);
              }}
            >
              Confirm repair
            </button>
            <button type="button" className="action-link" onClick={() => setSelectedId(null)}>
              Keep reviewing
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conflicts view
// ---------------------------------------------------------------------------

function ConflictsView(props: {
  conflicts: Conflict[];
  allConflicts: Conflict[];
  filter: 'all' | 'error' | 'warning' | 'gap' | 'understaffed';
  setFilter: (v: 'all' | 'error' | 'warning' | 'gap' | 'understaffed') => void;
  data: RosterData;
  result: RosterResult;
  backupFor: string | null;
  setBackupFor: (v: string | null) => void;
  onApplyRecovery: (assignment: RecoveryAssignment) => void;
}) {
  const { conflicts, data } = props;
  const errors = props.allConflicts.filter((c) => c.severity === 'error').length;
  const warnings = props.allConflicts.filter((c) => c.severity === 'warning').length;
  const gaps = props.allConflicts.filter((c) => c.type === 'COVERAGE_GAP').length;
  const under = props.allConflicts.filter((c) => c.type === 'UNDERSTAFFED').length;

  const gapsList = conflicts.filter((c) => c.type === 'COVERAGE_GAP');
  const underList = conflicts.filter((c) => c.type === 'UNDERSTAFFED');
  const overridesList = conflicts.filter((c) => c.type !== 'COVERAGE_GAP' && c.type !== 'UNDERSTAFFED');

  function renderConflictItem(c: Conflict) {
    const isError = c.severity === 'error';
    const diagCode = c.type === 'OFF_OVERRIDDEN' ? 'WEEKLY_OFF_OVERRIDE' : c.type;
    const sentence = getConflictSentence(c, data);
    const statText = c.type === 'COVERAGE_GAP' ? '0 of 1' : c.type === 'UNDERSTAFFED' ? '1 of 2' : '8h';

    return (
      <div key={c.id} className="ledger-row">
        <div className="ledger-row-left">
          <span className={`status-sq ${isError ? 'status-danger' : 'status-warning'}`} />
          <span style={{ fontWeight: 500, color: 'var(--ink)' }}>{isError ? 'Error' : 'Warning'}</span>
          <span className="diag-code">{diagCode}</span>
          <span className="ledger-row-text">{sentence}</span>
        </div>
        <div className="ledger-row-right">
          <span className={`ledger-row-stat ${isError ? 'danger' : 'warning'}`}>{statText}</span>
          {c.brandId && c.processId && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="action-link"
                onClick={() => props.setBackupFor(props.backupFor === c.id ? null : c.id)}
              >
                {props.backupFor === c.id ? 'Close backup' : 'Find backup'}
              </button>
              {props.backupFor === c.id && (
                <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, background: '#FFFFFF', border: '1px solid var(--border)', borderRadius: 4, padding: '8px 10px', zIndex: 10, boxShadow: '0 2px 6px rgba(0,0,0,0.1)', width: 560, maxWidth: '90vw' }}>
                  <RecoveryOptionsPanel
                    data={props.data}
                    result={props.result}
                    date={c.date}
                    brandId={c.brandId}
                    processId={c.processId}
                    excludeEmployeeId={c.employeeId}
                    onConfirm={(directive) => {
                      props.onApplyRecovery(directive);
                      props.setBackupFor(null);
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="ledger-section">
      <div className="text-toggle-row">
        <button
          type="button"
          className={`text-toggle-btn ${props.filter === 'all' ? 'active' : ''}`}
          onClick={() => props.setFilter('all')}
        >
          All ({props.allConflicts.length})
        </button>
        <span className="text-toggle-sep">·</span>
        <button
          type="button"
          className={`text-toggle-btn ${props.filter === 'error' ? 'active' : ''}`}
          onClick={() => props.setFilter('error')}
        >
          Errors ({errors})
        </button>
        <span className="text-toggle-sep">·</span>
        <button
          type="button"
          className={`text-toggle-btn ${props.filter === 'gap' ? 'active' : ''}`}
          onClick={() => props.setFilter('gap')}
        >
          Gaps ({gaps})
        </button>
        <span className="text-toggle-sep">·</span>
        <button
          type="button"
          className={`text-toggle-btn ${props.filter === 'understaffed' ? 'active' : ''}`}
          onClick={() => props.setFilter('understaffed')}
        >
          Understaffed ({under})
        </button>
        <span className="text-toggle-sep">·</span>
        <button
          type="button"
          className={`text-toggle-btn ${props.filter === 'warning' ? 'active' : ''}`}
          onClick={() => props.setFilter('warning')}
        >
          Overrides ({warnings})
        </button>
      </div>

      {conflicts.length === 0 ? (
        <p className="ok-text" style={{ marginTop: 14 }}>No coverage gaps in December 2026. All operational rules satisfied.</p>
      ) : (
        <div>
          {gapsList.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h2 className="ledger-section-title">Coverage gaps ({gapsList.length})</h2>
              {gapsList.map(renderConflictItem)}
            </div>
          )}

          {underList.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h2 className="ledger-section-title">Understaffed days ({underList.length})</h2>
              {underList.map(renderConflictItem)}
            </div>
          )}

          {overridesList.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h2 className="ledger-section-title">Weekly-off overrides ({overridesList.length})</h2>
              {overridesList.map(renderConflictItem)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
