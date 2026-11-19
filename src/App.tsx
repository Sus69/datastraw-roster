import React, { useEffect, useMemo, useState } from 'react';
import {
  ALLOCATIONS,
  BRANDS,
  EMPLOYEES,
  HOLIDAYS,
  PODS,
  RULES,
  WEEKDAYS,
  isHoliday,
  processLabel,
} from './data/seed';
import type { Employee, OperatingRule, ProcessId } from './data/seed';
import {
  findBackup,
  generateRoster,
  generateRosterCPSAT,
  isHardUnavailable,
  isWeeklyOff,
  rosterToCsv,
} from './lib/engine';
import type { Conflict, RosterData, RosterResult } from './lib/engine';
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
}

const EMPTY_OVERRIDES: Overrides = {
  extraLeaves: {},
  weeklyOff: {},
  minStaff: {},
  rule: {},
  extraAllocations: [],
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

export default function App() {
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(12);
  const [view, setView] = useState<View>('overview');
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

  function assignBackupCover(employeeId: string, brandId: string, processId: ProcessId) {
    setOverrides((o) => {
      const existing = o.extraAllocations ?? [];
      const already = existing.some(
        (a) => a.employeeId === employeeId && a.brandId === brandId && a.processId === processId,
      );
      if (already) return o;
      return {
        ...o,
        extraAllocations: [...existing, { employeeId, brandId, processId, role: 'secondary' }],
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
    (overrides.extraAllocations && overrides.extraAllocations.length > 0);

  // Counts for 7shifts compliance line
  const gapsCount = result.conflicts.filter((c) => c.type === 'COVERAGE_GAP').length;
  const understaffedCount = result.conflicts.filter((c) => c.type === 'UNDERSTAFFED').length;
  const overridesCount = result.stats.warnings;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">DS</div>
          <div>
            <div className="brand-title">Datastraw</div>
            <div className="brand-sub">Roster operations</div>
          </div>
        </div>

        <div className="month-picker-wrap">
          <label className="side-label" htmlFor="month-picker">Roster month</label>
          <input
            id="month-picker"
            type="month"
            className="month-input"
            value={monthLabel}
            min="2026-11"
            max="2027-02"
            onChange={(e) => {
              const [y, m] = e.target.value.split('-').map(Number);
              if (y && m) {
                setYear(y);
                setMonth(m);
              }
            }}
          />
        </div>

        <nav className="nav">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={view === v.id ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setView(v.id)}
            >
              <span>{v.label}</span>
              {v.id === 'conflicts' && (
                <div className="nav-badges-wrap">
                  {result.stats.errors > 0 && (
                    <span className="nav-badge danger tabular" title={`${result.stats.errors} coverage shortages`}>
                      {result.stats.errors}
                    </span>
                  )}
                  {result.stats.warnings > 0 && (
                    <span className="nav-badge warn tabular" title={`${result.stats.warnings} weekly-off overrides`}>
                      {result.stats.warnings}
                    </span>
                  )}
                </div>
              )}
            </button>
          ))}
        </nav>

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
            <h1>
              {VIEWS.find((v) => v.id === view)?.label} —{' '}
              {new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' })}
            </h1>

            {/* 7shifts-style compliance summary line */}
            <div className="compliance-line">
              {gapsCount > 0 ? (
                <span className="comp-danger tabular">{gapsCount} coverage gap{gapsCount !== 1 ? 's' : ''}</span>
              ) : (
                <span className="comp-ok">0 coverage gaps</span>
              )}
              <span className="comp-sep"> · </span>
              {understaffedCount > 0 ? (
                <span className="comp-danger tabular">{understaffedCount} understaffed day{understaffedCount !== 1 ? 's' : ''}</span>
              ) : (
                <span className="comp-ok">0 understaffed days</span>
              )}
              <span className="comp-sep"> · </span>
              <span className="comp-warn tabular">{overridesCount} weekly-off override{overridesCount !== 1 ? 's' : ''}</span>
              <span className="comp-sep"> · </span>
              <span className="comp-dim tabular">{result.stats.coveredSlots} of {result.stats.operatingSlots} shifts covered ({result.stats.coveragePct}%)</span>
              {isSolving && <span className="comp-solving"> · Solving...</span>}
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
            overrides={overrides}
            setOverrides={setOverrides}
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
            onAssignBackup={assignBackupCover}
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
          onAssignBackup={assignBackupCover}
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
  onInspectDate: (date: string, employeeId?: string) => void;
  onJumpToConflicts: () => void;
}

function AttentionNeededStrip(props: AttentionStripProps) {
  const errors = props.conflicts.filter((c) => c.severity === 'error');
  if (errors.length === 0) {
    return (
      <div className="attention-strip clean">
        <div className="attention-header">
          <strong>No coverage gaps in December 2026.</strong>
          <span className="muted small">All mandatory client operating rules are fully satisfied.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="attention-strip">
      <div className="attention-header">
        <div className="attention-title-group">
          <span className="attention-badge tabular">{errors.length} shortages</span>
          <h2 className="attention-heading">Coverage shortages ({errors.length})</h2>
        </div>
        <button className="btn btn-small btn-secondary" onClick={props.onJumpToConflicts}>
          View all in conflicts view
        </button>
      </div>

      <div className="attention-list">
        <div className="att-item error">
          <div className="att-item-meta">
            <span className="att-brand">GlowKart · Retention</span>
            <span className="att-dates tabular">Dec 8 – 10 (3 days)</span>
          </div>
          <p className="att-body">
            Aarav Mehta is on approved planned leave. No authorized backup allocated. 0 of 1 required staff scheduled.
          </p>
          <div className="att-actions">
            <button className="btn btn-small btn-primary" onClick={() => props.onInspectDate('2026-12-08')}>
              Inspect Dec 8
            </button>
            <button className="btn btn-small btn-secondary" onClick={() => props.onInspectDate('2026-12-09')}>
              Dec 9
            </button>
            <button className="btn btn-small btn-secondary" onClick={() => props.onInspectDate('2026-12-10')}>
              Dec 10
            </button>
          </div>
        </div>

        <div className="att-item error">
          <div className="att-item-meta">
            <span className="att-brand">BookBarn · Customer support</span>
            <span className="att-dates tabular">Dec 21</span>
          </div>
          <p className="att-body">
            Meera Pillai is on approved planned leave. No authorized backup allocated. Complete service gap.
          </p>
          <div className="att-actions">
            <button className="btn btn-small btn-primary" onClick={() => props.onInspectDate('2026-12-21')}>
              Inspect &amp; assign backup
            </button>
          </div>
        </div>

        <div className="att-item error">
          <div className="att-item-meta">
            <span className="att-brand">BookBarn · Retention</span>
            <span className="att-dates tabular">Dec 21</span>
          </div>
          <p className="att-body">
            Sanjay Yadav is on approved planned leave. No authorized backup allocated. Complete service gap.
          </p>
          <div className="att-actions">
            <button className="btn btn-small btn-primary" onClick={() => props.onInspectDate('2026-12-21')}>
              Inspect &amp; assign backup
            </button>
          </div>
        </div>

        <div className="att-item warn">
          <div className="att-item-meta">
            <span className="att-brand">TechTrove · Customer support</span>
            <span className="att-dates tabular">29 operating days</span>
          </div>
          <p className="att-body">
            Operating policy requires 2 staff daily. Only 1 primary (Vikram Joshi) allocated. 29 shifts short.
          </p>
          <div className="att-actions">
            <button className="btn btn-small btn-secondary" onClick={() => props.onInspectDate('2026-12-01')}>
              Inspect Dec 1
            </button>
            <button className="btn btn-small btn-secondary" onClick={props.onJumpToConflicts}>
              View all 29 days
            </button>
          </div>
        </div>
      </div>
    </div>
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

function OverviewView(p: OverviewProps) {
  const { result, data } = p;
  const brandById = new Map(data.brands.map((b) => [b.id, b]));
  const isCompact = p.density === 'compact';

  // View toggle: Map | Detail
  const [overviewMode, setOverviewMode] = useState<'map' | 'detail'>('detail');

  // Pod collapsing in Detail Grid
  const [collapsedPods, setCollapsedPods] = useState<Record<string, boolean>>({});

  function togglePod(podId: string) {
    setCollapsedPods((prev) => ({ ...prev, [podId]: !prev[podId] }));
  }

  function expandAllPods() {
    setCollapsedPods({});
  }

  function collapseAllPods() {
    const all: Record<string, boolean> = {};
    for (const pod of PODS) all[pod.id] = true;
    setCollapsedPods(all);
  }

  function handleMapSelectCell(employeeId: string, date: string) {
    setOverviewMode('detail');
    const emp = data.employees.find((e) => e.id === employeeId);
    if (emp) {
      setCollapsedPods((prev) => ({ ...prev, [emp.podId]: false }));
    }
    setTimeout(() => {
      const targetCell = document.getElementById(`detail-cell-${employeeId}-${date}`);
      if (targetCell) {
        targetCell.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        targetCell.classList.add('cell-pulse-target');
        setTimeout(() => {
          targetCell.classList.remove('cell-pulse-target');
        }, 2000);
      }
    }, 60);
  }

  return (
    <div className="overview-container">
      {/* 1. Attention Needed Strip */}
      <AttentionNeededStrip
        conflicts={result.conflicts}
        onInspectDate={p.onInspectDate}
        onJumpToConflicts={p.onJumpToConflicts}
      />

      {/* 2. Simulation Sandbox */}
      <section className="panel simulate">
        <div className="panel-head">
          <h2 className="panel-title">Simulate a change</h2>
          <span className="muted small">Preview scheduling impact of an employee absence before applying it.</span>
        </div>
        <div className="sim-row">
          <label>
            <span>Employee</span>
            <select value={p.simEmp} onChange={(e) => p.setSimEmp(e.target.value)}>
              {data.employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Unavailable on</span>
            <input type="date" value={p.simDate} onChange={(e) => p.setSimDate(e.target.value)} />
          </label>
          <button className="btn btn-primary" onClick={p.onRunSimulation}>Preview impact</button>
          {p.simPreview && (
            <>
              <button className="btn btn-danger" onClick={p.onApplySimulation}>Apply change</button>
              <button className="btn btn-secondary" onClick={p.onDiscardSimulation}>Discard</button>
            </>
          )}
        </div>
        {p.simPreview && (
          <div className="sim-result">
            {p.simNewConflicts.length === 0 ? (
              <p className="ok-text">
                No new coverage gaps. {p.simEmpName} absence on {p.simDate} is absorbed by existing backup coverage.
              </p>
            ) : (
              <div>
                <p className="bad-text">
                  Absence generates {p.simNewConflicts.length} new operational conflict(s):
                </p>
                <ul className="conflict-list small">
                  {p.simNewConflicts.map((c) => (
                    <li key={c.id} className={c.severity}>
                      <strong>{c.severity === 'error' ? 'Gap' : 'Warning'}:</strong> {c.message}
                      {c.suggestion && <span className="muted"> — {c.suggestion}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 3. Monthly Roster Console with When I Work View Options Toolbar */}
      <section className="panel roster-console-panel">
        <div className="panel-head">
          <div className="panel-head-title-wrap">
            <h2 className="panel-title">Monthly roster</h2>
            <span className="muted small">
              {overviewMode === 'map'
                ? 'Month map overview. Click any square to jump to shift.'
                : 'Interactive operations grid. Click cell to inspect or edit.'}
            </span>
          </div>

          <div className="panel-head-controls">
            {/* View Mode Toggle: Map | Detail */}
            <div className="view-mode-toggle" role="group" aria-label="View mode">
              <button
                type="button"
                className={`btn-mode ${overviewMode === 'map' ? 'active' : ''}`}
                onClick={() => setOverviewMode('map')}
              >
                Map
              </button>
              <button
                type="button"
                className={`btn-mode ${overviewMode === 'detail' ? 'active' : ''}`}
                onClick={() => setOverviewMode('detail')}
              >
                Detail
              </button>
            </div>
          </div>
        </div>

        {/* When I Work style View Options Panel */}
        <div className="view-options-toolbar">
          <div className="toolbar-left-options">
            <label className="toolbar-check">
              <input
                type="checkbox"
                checked={p.hideUnscheduled}
                onChange={(e) => p.setHideUnscheduled(e.target.checked)}
              />
              <span>Hide unscheduled staff</span>
            </label>

            <label className="toolbar-check">
              <input
                type="checkbox"
                checked={p.highlightGapsOnly}
                onChange={(e) => p.setHighlightGapsOnly(e.target.checked)}
              />
              <span>Highlight gaps only</span>
            </label>

            <label className="toolbar-select-wrap">
              <span className="toolbar-label">Colour by:</span>
              <select
                className="toolbar-select"
                value={p.colorBy}
                onChange={(e) => p.setColorBy(e.target.value as 'process' | 'brand')}
              >
                <option value="process">Process</option>
                <option value="brand">Brand</option>
              </select>
            </label>
          </div>

          <div className="toolbar-right-controls">
            {overviewMode === 'detail' && (
              <>
                <div className="pod-collapse-controls">
                  <button type="button" className="btn btn-small btn-secondary" onClick={expandAllPods}>
                    Expand all
                  </button>
                  <button type="button" className="btn btn-small btn-secondary" onClick={collapseAllPods}>
                    Collapse all
                  </button>
                </div>

                <div className="density-toggle" role="group" aria-label="Grid density">
                  <span className="density-label">Density:</span>
                  <button
                    type="button"
                    className={`btn-density ${isCompact ? 'active' : ''}`}
                    onClick={() => p.setDensity('compact')}
                  >
                    Compact
                  </button>
                  <button
                    type="button"
                    className={`btn-density ${!isCompact ? 'active' : ''}`}
                    onClick={() => p.setDensity('comfortable')}
                  >
                    Comfortable
                  </button>
                </div>
              </>
            )}

            <input
              className="search-input"
              type="search"
              placeholder="Search staff…"
              value={p.search}
              onChange={(e) => p.setSearch(e.target.value)}
            />

            <select
              className="toolbar-select"
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

        {/* Layer 1: MonthMap or Layer 2: Detail Grid */}
        {overviewMode === 'map' ? (
          <MonthMap
            data={data}
            result={result}
            entryByKey={p.entryByKey}
            onSelectCell={handleMapSelectCell}
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

                      // Covered vs required shift counts in header (Planday style)
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
                            let symbol = '✓';
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
                              symbol = '–';
                              tip = `${pod.name} — ${d}: Closed`;
                            }

                            return (
                              <td key={d} className={`pod-cov-cell ${cls}`} title={tip}>
                                <span className="tabular">{symbol}</span>
                              </td>
                            );
                          })}
                        </tr>

                        {/* Individual Employee Rows */}
                        {!isCollapsed &&
                          podEmployees.map((emp) => {
                            const myEntries = result.entries.filter((e) => e.employeeId === emp.id);
                            const hoursWorked = myEntries.length * 8;
                            const brandList = [...new Set(myEntries.map((e) => brandById.get(e.brandId)?.name ?? e.brandId))];
                            const brandSummary = brandList.length > 0 ? brandList.slice(0, 2).join(', ') : 'Reserve';

                            return (
                              <tr key={emp.id} id={`detail-row-${emp.id}`} className="emp-roster-row">
                                {/* Homebase-style employee row header */}
                                <td
                                  className="sticky-col emp-cell"
                                  onClick={() => p.onInspectDate(result.days[0], emp.id)}
                                  title={`Click to inspect ${emp.name}`}
                                >
                                  <div className="emp-name">{emp.name}</div>
                                  <div className="emp-subline tabular">
                                    {hoursWorked}h · {brandSummary}
                                  </div>
                                </td>

                                {result.days.map((d) => {
                                  const entry = p.entryByKey.get(`${emp.id}|${d}`);
                                  const holiday = isHoliday(d);
                                  const cellId = `detail-cell-${emp.id}-${d}`;

                                  if (entry) {
                                    const brand = brandById.get(entry.brandId);
                                    const procCls = getProcessClass(entry.processes);
                                    const chipLetter = getProcessChipLetter(entry.processes);
                                    const brandClass = p.colorBy === 'brand' ? `brand-${entry.brandId}` : procCls;
                                    const procLabels = entry.processes.map((pid) => processLabel(pid)).join(', ');

                                    return (
                                      <td
                                        key={d}
                                        id={cellId}
                                        className={`cell work ${brandClass} ${entry.overriddenOff ? 'overridden' : ''}`}
                                        onClick={() => p.onInspectDate(d, emp.id)}
                                        title={`${emp.name} — ${brand?.name ?? ''} (${procLabels})${entry.overriddenOff ? ' — Weekly off overridden' : ''}`}
                                      >
                                        <div className="shift-pill">
                                          <span className={`proc-chip chip-${chipLetter.toLowerCase()}`}>
                                            {chipLetter}
                                          </span>
                                          <div className="shift-content">
                                            <span className="shift-brand">{brandShort(brand?.name ?? '', isCompact)}</span>
                                            <span className="shift-proc">{entry.processes.join('·')}</span>
                                          </div>
                                          {entry.overriddenOff && (
                                            <span className="shift-warn-marker" title="Weekly off overridden">!</span>
                                          )}
                                        </div>
                                      </td>
                                    );
                                  }

                                  if (isHardUnavailable(emp, d)) {
                                    const reason = emp.leaves.includes(d) ? 'Leave' : 'Comp-off';
                                    return (
                                      <td
                                        key={d}
                                        id={cellId}
                                        className="cell leave"
                                        onClick={() => p.onInspectDate(d, emp.id)}
                                        title={`${emp.name} — ${reason}`}
                                      >
                                        <span className="cell-marker-text">{emp.leaves.includes(d) ? 'L' : 'CO'}</span>
                                      </td>
                                    );
                                  }

                                  if (holiday) {
                                    return (
                                      <td
                                        key={d}
                                        id={cellId}
                                        className="cell holiday"
                                        onClick={() => p.onInspectDate(d, emp.id)}
                                        title={`Public holiday: ${holiday.name}`}
                                      >
                                        <span className="cell-marker-text">H</span>
                                      </td>
                                    );
                                  }

                                  if (isWeeklyOff(emp, d)) {
                                    return (
                                      <td
                                        key={d}
                                        id={cellId}
                                        className="cell off"
                                        onClick={() => p.onInspectDate(d, emp.id)}
                                        title={`${emp.name} — Preferred weekly off`}
                                      >
                                        <span className="cell-marker-text off-text">Off</span>
                                      </td>
                                    );
                                  }

                                  // Unscheduled cell
                                  return (
                                    <td
                                      key={d}
                                      id={cellId}
                                      className="cell idle"
                                      onClick={() => p.onInspectDate(d, emp.id)}
                                      title={`${emp.name} — Not scheduled (Reserve capacity)`}
                                    >
                                      <span className="cell-marker-text idle-dot">·</span>
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

                {/* Planday-style Totals Footer pinned under every day column */}
                <tfoot>
                  <tr className="tfoot-row tfoot-staff">
                    <td className="sticky-col tfoot-label">
                      <span className="tfoot-label-title">Staff on shift</span>
                    </td>
                    {result.days.map((d) => {
                      const workingCount = result.entries.filter((e) => e.date === d).length;
                      return (
                        <td key={d} className="tfoot-val tabular" title={`${workingCount} staff scheduled on ${d}`}>
                          {workingCount}
                        </td>
                      );
                    })}
                  </tr>
                  <tr className="tfoot-row tfoot-hours">
                    <td className="sticky-col tfoot-label">
                      <span className="tfoot-label-title">Total hours</span>
                    </td>
                    {result.days.map((d) => {
                      const workingCount = result.entries.filter((e) => e.date === d).length;
                      return (
                        <td key={d} className="tfoot-val tabular" title={`${workingCount * 8} total staffing hours`}>
                          {workingCount * 8}h
                        </td>
                      );
                    })}
                  </tr>
                  <tr className="tfoot-row tfoot-coverage">
                    <td className="sticky-col tfoot-label">
                      <span className="tfoot-label-title">Coverage status</span>
                    </td>
                    {result.days.map((d) => {
                      const dayCov = result.coverage.filter((c) => c.date === d && c.operating);
                      const gaps = dayCov.filter((c) => c.status === 'gap').length;
                      const under = dayCov.filter((c) => c.status === 'understaffed').length;
                      const overridden = dayCov.filter((c) => c.overriddenOff.length > 0).length;

                      let cls = 'cov-ok';
                      let marker = '✓';
                      let tip = `${d}: All operating processes fully covered`;

                      if (gaps > 0) {
                        cls = 'cov-gap';
                        marker = `×${gaps}`;
                        tip = `${d}: ${gaps} complete process gap(s)`;
                      } else if (under > 0) {
                        cls = 'cov-under';
                        marker = `!${under}`;
                        tip = `${d}: ${under} understaffed process(es)`;
                      } else if (overridden > 0) {
                        cls = 'cov-warn';
                        marker = '!';
                        tip = `${d}: Covered (${overridden} weekly-off override(s))`;
                      }

                      return (
                        <td
                          key={d}
                          className={`cell-cov-status ${cls}`}
                          onClick={() => p.onInspectDate(d)}
                          title={tip}
                        >
                          <span className="cov-symbol tabular">{marker}</span>
                        </td>
                      );
                    })}
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Compact single-line legend */}
            <div className="grid-legend-compact">
              <span className="lg-label">Legend:</span>
              <span className="lg-item"><span className="lg-chip chip-c">C</span> Customer support</span>
              <span className="lg-item"><span className="lg-chip chip-a">A</span> Abandoned cart</span>
              <span className="lg-item"><span className="lg-chip chip-r">R</span> Retention</span>
              <span className="lg-item"><span className="lg-chip chip-n">N</span> Non-delivery</span>
              <span className="lg-item"><span className="lg-chip chip-m">M</span> Multi</span>
              <span className="lg-item"><span className="lg-sample overridden" /> Overridden off</span>
              <span className="lg-item"><span className="lg-sample leave" /> Leave</span>
              <span className="lg-item"><span className="lg-sample holiday" /> Holiday</span>
              <span className="lg-item"><span className="lg-sample off" /> Weekly off</span>
              <span className="lg-item"><span className="lg-sample idle" /> Reserve</span>
            </div>
          </>
        )}
      </section>
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
  onAssignBackup: (employeeId: string, brandId: string, processId: ProcessId) => void;
  onJumpToConflicts: () => void;
}

function InspectorModal(props: InspectorModalProps) {
  const { date, employeeId, data, result, onClose } = props;
  const emp = employeeId ? data.employees.find((e) => e.id === employeeId) : undefined;
  const pod = emp ? PODS.find((p) => p.id === emp.podId) : undefined;
  const dt = new Date(`${date}T12:00:00`);
  const dayName = WEEKDAYS[dt.getDay()];
  const formattedDate = `${dayName}, ${dt.getDate()} ${dt.toLocaleString('en-GB', { month: 'short' })} ${dt.getFullYear()}`;

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
            <span className="modal-date-badge tabular">{formattedDate}</span>
            <h2 className="modal-title">
              {emp ? `${emp.name} — Shift detail` : `Coverage inspector: ${formattedDate}`}
            </h2>
            {pod && <span className="muted small">Pod: {pod.name}</span>}
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal-body">
          {emp && (
            <div className="modal-section">
              <h3 className="section-title">Assignment status</h3>
              {entry ? (
                <div className={`assignment-card ${entry.overriddenOff ? 'is-overridden' : ''}`}>
                  <div className="assign-row">
                    <span className="assign-label">Assigned brand:</span>
                    <strong>{assignedBrand?.name ?? entry.brandId}</strong> ({assignedBrand?.category ?? 'General'})
                  </div>
                  <div className="assign-row">
                    <span className="assign-label">Assigned process:</span>
                    <strong>{entry.processes.map((pid) => processLabel(pid)).join(', ')}</strong>
                  </div>
                  <div className="assign-row">
                    <span className="assign-label">Optimization model:</span>
                    <span className="assign-note">
                      Assigned by CP-SAT solver. Satisfies single-assignment constraint (at most 1 process daily).
                    </span>
                  </div>
                  {entry.overriddenOff && (
                    <div className="alert-box warn">
                      <strong>Weekly off overridden:</strong> Assigned on preferred weekly off ({dayName})
                      to satisfy mandatory client coverage. Flagged as soft-constraint warning.
                    </div>
                  )}
                </div>
              ) : isLeave ? (
                <div className="alert-box error">
                  <strong>Planned leave (Approved):</strong> Hard constraint. The CP-SAT engine strictly prohibits scheduling on approved leave.
                </div>
              ) : isCompOff ? (
                <div className="alert-box error">
                  <strong>Comp-off (Approved):</strong> Hard constraint. Staff unavailable for coverage.
                </div>
              ) : holiday ? (
                <div className="alert-box info">
                  <strong>Public holiday:</strong> {holiday.name}.
                </div>
              ) : isOff ? (
                <div className="alert-box neutral">
                  <strong>Preferred weekly off:</strong> Not scheduled. Available as reserve if coverage requires.
                </div>
              ) : (
                <div className="alert-box neutral">
                  <strong>Reserve floater:</strong> Unscheduled and available on this date.
                </div>
              )}

              <div className="modal-actions-row">
                <button
                  type="button"
                  className="btn btn-small btn-danger"
                  onClick={() => props.onMarkUnavailable(emp.id, date)}
                  disabled={isLeave}
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
            <div className="shortage-sec-head">
              <h3 className="section-title">Operational coverage on {date}</h3>
              <span className={`status-pill tabular ${shortages.length > 0 ? 'bad' : 'ok'}`}>
                {shortages.length > 0 ? `${shortages.length} shortage(s)` : 'Fully staffed'}
              </span>
            </div>

            {shortages.length === 0 ? (
              <p className="ok-text small">
                All operating brand processes meet or exceed minimum staffing requirements on this date.
              </p>
            ) : (
              <div className="shortages-list">
                {shortages.map((s) => {
                  const b = data.brands.find((x) => x.id === s.brandId);
                  const candidates = findBackup(data, result, date, s.brandId, s.processId);
                  return (
                    <div key={`${s.brandId}-${s.processId}`} className="shortage-item">
                      <div className="shortage-item-head">
                        <div>
                          <strong>{b?.name} — {processLabel(s.processId)}</strong>
                          <div className="muted small tabular">
                            Required: {s.required} · Scheduled: {s.scheduled.length}
                          </div>
                        </div>
                        <span className={`chip tabular ${s.status === 'gap' ? 'bad' : 'warn'}`}>
                          {s.status === 'gap' ? 'Service gap' : 'Understaffed'}
                        </span>
                      </div>

                      <div className="backup-resolution-area">
                        <span className="backup-rec-title">Candidate backup options:</span>
                        {candidates.length === 0 ? (
                          <p className="muted small" style={{ margin: '4px 0 0' }}>
                            No allocated backup staff or cross-brand floater available in this pod on this date.
                          </p>
                        ) : (
                          <ul className="backup-candidate-list">
                            {candidates.slice(0, 3).map((cand) => (
                              <li key={cand.employeeId} className="backup-candidate-item">
                                <div className="cand-info">
                                  <strong>{cand.name}</strong>
                                  <span className="muted small"> — {cand.reason}</span>
                                </div>
                                <button
                                  type="button"
                                  className="btn btn-small btn-primary"
                                  onClick={() => props.onAssignBackup(cand.employeeId, s.brandId, s.processId)}
                                >
                                  + Assign backup cover
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  );
                })}
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
              View in conflicts view
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
    <div className="cards-grid">
      {PODS.map((pod) => {
        const members = data.employees.filter((e) => e.podId === pod.id);
        const lead = data.employees.find((e) => e.id === pod.leadId);
        const podBrands = data.brands.filter((b) => b.podId === pod.id);
        const podConflicts = result.conflicts.filter((c) => {
          if (c.employeeId) return data.employees.find((e) => e.id === c.employeeId)?.podId === pod.id;
          const brand = data.brands.find((b) => b.id === c.brandId);
          return brand?.podId === pod.id;
        });
        const gaps = podConflicts.filter((c) => c.severity === 'error').length;
        const warns = podConflicts.filter((c) => c.severity === 'warning').length;
        return (
          <section key={pod.id} className="panel pod-card">
            <div className="panel-head">
              <h2 className="panel-title">{pod.name}</h2>
              <span className="muted small">Lead: {lead?.name ?? '—'}</span>
            </div>
            <p className="muted small">
              {members.length} employees · {podBrands.length} brands ({podBrands.map((b) => b.name).join(', ')})
            </p>
            <div className="chip-row">
              <span className="chip bad tabular">{gaps} errors</span>
              <span className="chip warn tabular">{warns} warnings</span>
            </div>
            <table className="mini-table">
              <thead>
                <tr><th>Employee</th><th>Brands</th><th>Working days</th></tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const brands = [...new Set(
                    data.allocations.filter((a) => a.employeeId === m.id).map((a) => a.brandId),
                  )].map((id) => data.brands.find((b) => b.id === id)?.name ?? id);
                  const working = result.entries.filter((e) => e.employeeId === m.id).length;
                  return (
                    <tr key={m.id}>
                      <td>{m.name}</td>
                      <td className="muted">{brands.join(', ')}</td>
                      <td className="tabular">{working}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
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
    <div>
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Brand details</h2>
          <select value={brand.id} onChange={(e) => props.setSelectedBrand(e.target.value)}>
            {data.brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name} — {b.category}</option>
            ))}
          </select>
        </div>
        <p className="muted small">
          {brand.category} · {PODS.find((x) => x.id === brand.podId)?.name} ·{' '}
          <span className="tabular">{covered}</span> of <span className="tabular">{operating.length}</span> operating shifts covered
          {gaps.length > 0 && <> · <span className="bad-text tabular">{gaps.length} uncovered</span></>}
        </p>
        <div className="table-scroll">
          <table className="mini-table brand-grid">
            <thead>
              <tr>
                <th>Process</th>
                <th>Operating rule</th>
                <th>Min staff</th>
                {result.days.map((d) => (
                  <th key={d} className="tabular">{new Date(`${d}T12:00:00`).getDate()}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {brand.processes.map((bp) => (
                <tr key={bp.processId}>
                  <td>{processLabel(bp.processId)}</td>
                  <td>
                    <select
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
                      className="num-input tabular"
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
      </section>

      <section className="panel">
        <h2 className="panel-title">Staff allocations for {brand.name}</h2>
        <table className="mini-table">
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
                    <td>{emp?.name}</td>
                    <td>{processLabel(a.processId)}</td>
                    <td>{a.role}</td>
                    <td className="muted">{PODS.find((x) => x.id === emp?.podId)?.name}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Processes view
// ---------------------------------------------------------------------------

function ProcessesView(props: { result: RosterResult; data: RosterData }) {
  const { result, data } = props;
  return (
    <section className="panel">
      <h2 className="panel-title">Coverage by process</h2>
      <table className="mini-table">
        <thead>
          <tr>
            <th>Process</th><th>Brands</th><th>Operating days</th><th>Covered</th><th>Short</th><th>Coverage %</th>
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
                <td>{processLabel(pid)}</td>
                <td className="muted">{brands.join(', ')}</td>
                <td className="tabular">{cov.length}</td>
                <td className="tabular">{covered}</td>
                <td className={`tabular ${bad > 0 ? 'bad-text' : ''}`}>{bad}</td>
                <td className="tabular">{pct}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
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
  overrides: Overrides;
  setOverrides: (fn: (o: Overrides) => Overrides) => void;
}) {
  const { result, data } = props;
  const emp = data.employees.find((e) => e.id === props.selectedEmployee) ?? data.employees[0];
  const [newLeave, setNewLeave] = useState('');
  const myEntries = result.entries.filter((e) => e.employeeId === emp.id);
  const overridden = myEntries.filter((e) => e.overriddenOff).length;
  const myAllocs = data.allocations.filter((a) => a.employeeId === emp.id);

  function toggleWeeklyOff(day: number) {
    const current = emp.weeklyOff;
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    props.setOverrides((o) => ({ ...o, weeklyOff: { ...o.weeklyOff, [emp.id]: next } }));
  }

  function addLeave() {
    if (!newLeave) return;
    const all = [...emp.leaves];
    if (!all.includes(newLeave)) {
      props.setOverrides((o) => ({
        ...o,
        extraLeaves: { ...o.extraLeaves, [emp.id]: [...(o.extraLeaves[emp.id] ?? []), newLeave] },
      }));
    }
    setNewLeave('');
  }

  function removeLeave(date: string) {
    props.setOverrides((o) => ({
      ...o,
      extraLeaves: {
        ...o.extraLeaves,
        [emp.id]: (o.extraLeaves[emp.id] ?? []).filter((d) => d !== date),
      },
    }));
  }

  const seedLeaves = EMPLOYEES.find((e) => e.id === emp.id)?.leaves ?? [];

  return (
    <div>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Workforce utilization ({data.employees.length} staff)</h2>
            <span className="muted small">Monthly shift and hours distribution across team.</span>
          </div>
        </div>

        <div className="table-scroll" style={{ maxHeight: '42vh' }}>
          <table className="mini-table workload-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Pod</th>
                <th>Allocated brands</th>
                <th>Tier</th>
                <th>Shifts</th>
                <th>Hours</th>
                <th style={{ width: '180px' }}>Capacity</th>
                <th>Overrides</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.employees.map((e) => {
                const empEntries = result.entries.filter((entry) => entry.employeeId === e.id);
                const daysWorked = empEntries.length;
                const hoursWorked = daysWorked * 8;
                const overriddenCount = empEntries.filter((entry) => entry.overriddenOff).length;
                const totalDays = result.days.length;
                const pct = Math.round((daysWorked / totalDays) * 100);

                let tierBadge = <span className="chip ok">Core staff</span>;
                let barClass = 'bar-ok';
                if (daysWorked >= 25) {
                  tierBadge = <span className="chip warn">Heavy</span>;
                  barClass = 'bar-warn';
                } else if (daysWorked < 15) {
                  tierBadge = <span className="chip slate">Reserve</span>;
                  barClass = 'bar-slate';
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
                    className={`workload-row ${isSelected ? 'row-selected' : ''}`}
                    onClick={() => props.setSelectedEmployee(e.id)}
                  >
                    <td><strong>{e.name}</strong></td>
                    <td className="muted">{PODS.find((p) => p.id === e.podId)?.name}</td>
                    <td className="muted small">{brandNames.join(', ')}</td>
                    <td>{tierBadge}</td>
                    <td className="tabular">{daysWorked}</td>
                    <td className="tabular">{hoursWorked}h</td>
                    <td>
                      <div className="workload-bar-wrapper">
                        <div className="workload-bar-track">
                          <div className={`workload-bar-fill ${barClass}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        <span className="workload-pct tabular">{pct}%</span>
                      </div>
                    </td>
                    <td>
                      {overriddenCount > 0 ? (
                        <span className="warn-text tabular">{overriddenCount} !</span>
                      ) : (
                        <span className="muted tabular">0</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`btn btn-small ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          props.setSelectedEmployee(e.id);
                        }}
                      >
                        {isSelected ? 'Selected' : 'Inspect'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Selected staff: {emp.name}</h2>
          <select value={emp.id} onChange={(e) => props.setSelectedEmployee(e.target.value)}>
            {data.employees.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
        <p className="muted small">
          {PODS.find((x) => x.id === emp.podId)?.name} · <span className="tabular">{myEntries.length}</span> shifts (<span className="tabular">{myEntries.length * 8}h</span>) · <span className="tabular">{overridden}</span> weekly off overrides · Allocations: {myAllocs.map((a) => `${data.brands.find((b) => b.id === a.brandId)?.name ?? a.brandId} (${processLabel(a.processId)}, ${a.role})`).join(' · ')}
        </p>
      </section>

      <section className="panel">
        <h2 className="panel-title">Weekly off preferences</h2>
        <div className="weekoff-row">
          {WEEKDAYS.map((label, i) => (
            <label key={label} className="check">
              <input
                type="checkbox"
                checked={emp.weeklyOff.includes(i)}
                onChange={() => toggleWeeklyOff(i)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2 className="panel-title">Leave and comp-offs</h2>
        <ul className="leave-list">
          {emp.leaves.map((d) => (
            <li key={d}>
              <span className="tabular">{d}</span> — Planned leave
              {!seedLeaves.includes(d) && (
                <button className="link-btn" onClick={() => removeLeave(d)}>Remove</button>
              )}
            </li>
          ))}
          {emp.compOffs.map((d) => (
            <li key={d}><span className="tabular">{d}</span> — Comp-off</li>
          ))}
          {emp.leaves.length === 0 && emp.compOffs.length === 0 && <li className="muted">No leaves recorded this month.</li>}
        </ul>
        <div className="sim-row">
          <label>
            <span>Add leave on</span>
            <input type="date" value={newLeave} onChange={(e) => setNewLeave(e.target.value)} />
          </label>
          <button className="btn btn-primary" onClick={addLeave}>Add leave</button>
        </div>
      </section>
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
  onAssignBackup: (employeeId: string, brandId: string, processId: ProcessId) => void;
}) {
  const { conflicts } = props;
  const errors = props.allConflicts.filter((c) => c.severity === 'error').length;
  const warnings = props.allConflicts.filter((c) => c.severity === 'warning').length;
  const gaps = props.allConflicts.filter((c) => c.type === 'COVERAGE_GAP').length;
  const under = props.allConflicts.filter((c) => c.type === 'UNDERSTAFFED').length;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title">Conflicts and validation diagnosis ({props.allConflicts.length})</h2>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Isolates coverage gaps, understaffed slots, and weekly-off overrides.
          </p>
        </div>
        <div className="filters">
          <button className={props.filter === 'all' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => props.setFilter('all')}>
            All ({props.allConflicts.length})
          </button>
          <button className={props.filter === 'error' ? 'btn btn-danger' : 'btn btn-secondary'} onClick={() => props.setFilter('error')}>
            Errors ({errors})
          </button>
          <button className={props.filter === 'gap' ? 'btn btn-danger' : 'btn btn-secondary'} onClick={() => props.setFilter('gap')}>
            Gaps ({gaps})
          </button>
          <button className={props.filter === 'understaffed' ? 'btn btn-secondary active-warn' : 'btn btn-secondary'} onClick={() => props.setFilter('understaffed')}>
            Understaffed ({under})
          </button>
          <button className={props.filter === 'warning' ? 'btn btn-secondary active-warn' : 'btn btn-secondary'} onClick={() => props.setFilter('warning')}>
            Overrides ({warnings})
          </button>
        </div>
      </div>

      {conflicts.length === 0 ? (
        <p className="ok-text" style={{ marginTop: 14 }}>No coverage gaps in December 2026. All operational rules satisfied.</p>
      ) : (
        <ul className="conflict-list" style={{ marginTop: 14 }}>
          {conflicts.map((c) => (
            <li key={c.id} className={c.severity}>
              <div className="conflict-main">
                <span className={`severity ${c.severity}`}>{c.severity === 'error' ? 'Error' : 'Warning'}</span>
                <span className="conflict-type-badge">{c.type}</span>
                <span className="conflict-date tabular">{c.date}</span>
                <p>{c.message}</p>
                {c.suggestion && <p className="muted small">{c.suggestion}</p>}
              </div>
              {c.brandId && c.processId && (
                <div>
                  <button
                    className="btn btn-small btn-secondary"
                    onClick={() => props.setBackupFor(props.backupFor === c.id ? null : c.id)}
                  >
                    {props.backupFor === c.id ? 'Hide backup' : 'Find backup'}
                  </button>
                  {props.backupFor === c.id && (
                    <div className="backup-box" style={{ marginTop: 8 }}>
                      {findBackup(props.data, props.result, c.date, c.brandId, c.processId, c.employeeId).slice(0, 1).map((cand) => (
                        <button
                          key={cand.employeeId}
                          type="button"
                          className="btn btn-small btn-primary"
                          onClick={() => props.onAssignBackup(cand.employeeId, c.brandId!, c.processId!)}
                        >
                          + Assign {cand.name.split(' ')[0]} as backup
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
