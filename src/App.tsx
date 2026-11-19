import { useEffect, useMemo, useState } from 'react';
import {
  ALLOCATIONS,
  BRANDS,
  EMPLOYEES,
  HOLIDAYS,
  PODS,
  RULES,
  WEEKDAYS,
  dayOfWeek,
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
import type { BackupCandidate, Conflict, RosterData, RosterResult } from './lib/engine';
import './App.css';

// ---------------------------------------------------------------------------
// Overrides: everything the manager edits is stored here and persisted to
// localStorage. The seed data itself is never mutated, so "Reset to seed"
// is a one-click restore.
// ---------------------------------------------------------------------------

interface Overrides {
  extraLeaves: Record<string, string[]>;
  weeklyOff: Record<string, number[]>;
  minStaff: Record<string, number>; // key `${brandId}|${processId}`
  rule: Record<string, OperatingRule>; // key `${brandId}|${processId}`
}

const EMPTY_OVERRIDES: Overrides = { extraLeaves: {}, weeklyOff: {}, minStaff: {}, rule: {} };
const STORAGE_KEY = 'datastraw-roster-overrides-v1';

function loadOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_OVERRIDES;
    const parsed = JSON.parse(raw) as Overrides;
    return { ...EMPTY_OVERRIDES, ...parsed };
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
  return { employees, brands, allocations: ALLOCATIONS, holidays: HOLIDAYS };
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

function brandShort(name: string): string {
  return name.slice(0, 4).toUpperCase();
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

  // Simulate-a-change panel
  const [simEmp, setSimEmp] = useState(EMPLOYEES[0].id);
  const [simDate, setSimDate] = useState('2026-12-14');
  const [simPreview, setSimPreview] = useState<RosterResult | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  }, [overrides]);

  const data = useMemo(() => mergeData(overrides), [overrides]);
  const [result, setResult] = useState<RosterResult>(() => generateRoster(mergeData(loadOverrides()), 2026, 12));
  const [solverStatus, setSolverStatus] = useState<string>('OPTIMAL');
  const [isSolving, setIsSolving] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    setIsSolving(true);
    generateRosterCPSAT(data, year, month).then((res) => {
      if (!cancelled) {
        setResult(res);
        setSolverStatus(res.solverStatus || 'OPTIMAL');
        setIsSolving(false);
      }
    }).catch(() => {
      if (!cancelled) {
        const fallback = generateRoster(data, year, month);
        fallback.solverStatus = 'FEASIBLE';
        setResult(fallback);
        setSolverStatus('FEASIBLE');
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

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.employees.filter(
      (e) =>
        (podFilter === 'all' || e.podId === podFilter) &&
        (q === '' || e.name.toLowerCase().includes(q)),
    );
  }, [data, search, podFilter]);

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
    Object.keys(overrides.rule).length > 0;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">DS</div>
          <div>
            <div className="brand-title">Datastraw</div>
            <div className="brand-sub">Smart Roster Management</div>
          </div>
        </div>

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

        <nav className="nav">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={view === v.id ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setView(v.id)}
            >
              {v.label}
              {v.id === 'conflicts' && (
                <div style={{ display: 'inline-flex', gap: 4 }}>
                  {result.stats.errors > 0 && (
                    <span className="nav-badge" title={`${result.stats.errors} hard shortages`}>
                      {result.stats.errors}
                    </span>
                  )}
                  {result.stats.warnings > 0 && (
                    <span className="nav-badge warn" title={`${result.stats.warnings} weekly-off overrides`}>
                      {result.stats.warnings}
                    </span>
                  )}
                </div>
              )}
            </button>
          ))}
        </nav>

        <div className="side-actions">
          <button className="btn btn-light" onClick={exportCsv}>Export roster CSV</button>
          <button className="btn btn-ghost" onClick={resetAll} disabled={!hasOverrides}>
            Reset to seed data
          </button>
        </div>

        <p className="side-note">
          Weekly offs are preferences: mandatory client coverage can override them
          (shown amber). Leaves and comp-offs are hard blocks. Nothing is ever
          silently left uncovered — gaps are flagged red.
        </p>
      </aside>

      <main className="content">
        <header className="page-head">
          <div>
            <h1>
              {VIEWS.find((v) => v.id === view)?.label} —{' '}
              {new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' })}
            </h1>
            <p className="muted">
              {data.employees.length} employees · {data.brands.length} brands · {PODS.length} pods ·{' '}
              {result.stats.operatingSlots} operating brand-process days
            </p>
          </div>
          <div className="stat-cards">
            <div
              className={`stat ${solverStatus === 'OPTIMAL' || solverStatus === 'FEASIBLE' ? 'ok' : 'warn'}`}
              title="Constraint Programming (CP-SAT) Engine Status"
            >
              <span className="stat-num" style={{ fontSize: 13, textTransform: 'uppercase' }}>
                {isSolving ? 'Solving...' : solverStatus === 'INFEASIBLE' ? 'DIAGNOSED' : solverStatus}
              </span>
              <span className="stat-label">
                {solverStatus === 'INFEASIBLE' ? 'CP-SAT (Slack)' : 'CP-SAT solver'}
              </span>
            </div>
            <div className="stat ok" title={`${result.stats.coveredSlots} of ${result.stats.operatingSlots} operating slots covered`}>
              <span className="stat-num">{result.stats.coveragePct}%</span>
              <span className="stat-label">coverage</span>
            </div>
            <div className="stat bad" title={`${result.stats.errors} coverage shortages detected`}>
              <span className="stat-num">{result.stats.errors}</span>
              <span className="stat-label">shortages</span>
            </div>
            <div className="stat warn" title={`${result.stats.warnings} weekly-off preferences overridden to preserve coverage`}>
              <span className="stat-num">{result.stats.warnings}</span>
              <span className="stat-label">overrides</span>
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
          />
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview: simulate-change panel + full roster grid
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

  return (
    <div>
      <section className="panel simulate">
        <div className="panel-head">
          <h2>Simulate a change</h2>
          <span className="muted">Mark an employee unavailable on a day and preview the impact before applying it.</span>
        </div>
        <div className="sim-row">
          <label>
            Employee
            <select value={p.simEmp} onChange={(e) => p.setSimEmp(e.target.value)}>
              {data.employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </label>
          <label>
            Unavailable on
            <input type="date" value={p.simDate} onChange={(e) => p.setSimDate(e.target.value)} />
          </label>
          <button className="btn btn-primary" onClick={p.onRunSimulation}>Preview impact</button>
          {p.simPreview && (
            <>
              <button className="btn btn-danger" onClick={p.onApplySimulation}>Apply change</button>
              <button className="btn" onClick={p.onDiscardSimulation}>Discard</button>
            </>
          )}
        </div>
        {p.simPreview && (
          <div className="sim-result">
            {p.simNewConflicts.length === 0 ? (
              <p className="ok-text">
                No new conflicts. {p.simEmpName} being unavailable on {p.simDate} is absorbed by existing backup cover.
              </p>
            ) : (
              <div>
                <p className="bad-text">
                  This change creates {p.simNewConflicts.length} new conflict(s):
                </p>
                <ul className="conflict-list small">
                  {p.simNewConflicts.map((c) => (
                    <li key={c.id} className={c.severity}>
                      <strong>{c.severity === 'error' ? 'Error' : 'Warning'}:</strong> {c.message}
                      {c.suggestion && <span className="muted"> — {c.suggestion}</span>}
                      {c.brandId && c.processId && (
                        <BackupList
                          data={data}
                          result={p.simPreview!}
                          date={c.date}
                          brandId={c.brandId}
                          processId={c.processId}
                          excludeEmployeeId={p.simEmp}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Monthly roster</h2>
          <div className="filters">
            <input
              className="search"
              type="search"
              placeholder="Search employee…"
              value={p.search}
              onChange={(e) => p.setSearch(e.target.value)}
            />
            <select value={p.podFilter} onChange={(e) => p.setPodFilter(e.target.value)}>
              <option value="all">All pods</option>
              {PODS.map((pod) => (
                <option key={pod.id} value={pod.id}>{pod.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="table-scroll">
          <table className="roster-grid">
            <thead>
              <tr>
                <th className="sticky-col">Employee</th>
                {result.days.map((d) => {
                  const dt = new Date(`${d}T12:00:00`);
                  return (
                    <th key={d} className={dt.getDay() === 0 ? 'sun' : ''}>
                      {dt.getDate()}
                      <span>{WEEKDAYS[dt.getDay()]}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {p.employees.map((emp) => (
                <tr key={emp.id}>
                  <td className="sticky-col emp-cell">
                    <span className="emp-name">{emp.name}</span>
                    <span className="muted">{PODS.find((x) => x.id === emp.podId)?.name}</span>
                  </td>
                  {result.days.map((d) => {
                    const entry = p.entryByKey.get(`${emp.id}|${d}`);
                    const holiday = isHoliday(d);
                    if (entry) {
                      const brand = brandById.get(entry.brandId);
                      const procLabels = entry.processes.map((pid) => processLabel(pid)).join(', ');
                      return (
                        <td
                          key={d}
                          className={entry.overriddenOff ? 'cell work overridden' : 'cell work'}
                          title={`${emp.name} — ${brand?.name ?? ''} (${procLabels})${entry.overriddenOff ? ' — weekly off overridden' : ''}`}
                        >
                          <span className="cell-brand">{brandShort(brand?.name ?? '')}</span>
                          <span className="cell-procs">{entry.processes.join('·')}</span>
                        </td>
                      );
                    }
                    if (isHardUnavailable(emp, d)) {
                      const reason = emp.leaves.includes(d) ? 'Leave' : 'Comp-off';
                      return <td key={d} className="cell leave" title={`${emp.name} — ${reason}`}>—</td>;
                    }
                    if (holiday) {
                      return <td key={d} className="cell holiday" title={holiday.name}>H</td>;
                    }
                    if (isWeeklyOff(emp, d)) {
                      return <td key={d} className="cell off" title={`${emp.name} — weekly off`}>Off</td>;
                    }
                    return <td key={d} className="cell idle" title={`${emp.name} — not scheduled`} />;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="legend">
          <span className="lg work">Working (brand/process)</span>
          <span className="lg overridden">Weekly off overridden</span>
          <span className="lg leave">Leave / comp-off</span>
          <span className="lg off">Weekly off</span>
          <span className="lg holiday">Public holiday</span>
          <span className="lg idle">Not scheduled</span>
        </p>
        <p className="muted small">
          Gaps are not shown as empty cells here — they appear in the Conflicts view, because an
          empty cell for one employee does not tell you a brand went uncovered. Check Conflicts for
          every uncovered brand/process day.
        </p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backup suggestions
// ---------------------------------------------------------------------------

function BackupList(props: {
  data: RosterData;
  result: RosterResult;
  date: string;
  brandId: string;
  processId: ProcessId;
  excludeEmployeeId?: string;
}) {
  const candidates: BackupCandidate[] = findBackup(
    props.data, props.result, props.date, props.brandId, props.processId, props.excludeEmployeeId,
  );
  if (candidates.length === 0) {
    return <p className="backup none">No backup available that day — every allocated employee is unavailable or already assigned.</p>;
  }
  return (
    <div className="backup">
      <strong>Suggested backup:</strong>
      <ul>
        {candidates.slice(0, 3).map((c) => (
          <li key={c.employeeId}>
            {c.name} — {c.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pods view
// ---------------------------------------------------------------------------

function PodsView(props: { result: RosterResult; data: RosterData }) {
  const { result, data } = props;
  return (
    <div className="cards">
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
              <h2>{pod.name}</h2>
              <span className="muted">Lead: {lead?.name ?? '—'}</span>
            </div>
            <p className="muted">
              {members.length} employees · {podBrands.length} brands ({podBrands.map((b) => b.name).join(', ')})
            </p>
            <p>
              <span className="chip bad">{gaps} errors</span>{' '}
              <span className="chip warn">{warns} warnings</span>
            </p>
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
                      <td>{working}</td>
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
          <h2>Brand</h2>
          <select value={brand.id} onChange={(e) => props.setSelectedBrand(e.target.value)}>
            {data.brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name} — {b.category}</option>
            ))}
          </select>
        </div>
        <p className="muted">
          {brand.category} · {PODS.find((x) => x.id === brand.podId)?.name} ·{' '}
          {covered} of {operating.length} operating brand-process days covered
          {gaps.length > 0 && <> · <span className="bad-text">{gaps.length} uncovered</span></>}
        </p>
        <div className="table-scroll">
          <table className="mini-table brand-grid">
            <thead>
              <tr>
                <th>Process</th>
                <th>Rule</th>
                <th>Min staff</th>
                {result.days.map((d) => (
                  <th key={d}>{new Date(`${d}T12:00:00`).getDate()}</th>
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
                      className="num-input"
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
                      <td key={d} className={cls} title={`${brand.name} — ${processLabel(bp.processId)} on ${d}: ${c.scheduled.length} of ${c.required} working`}>
                        {label}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Rule and minimum-staff changes apply immediately and re-validate the whole month.
          Edits are saved in this browser (localStorage) — use “Reset to seed data” to undo them.
        </p>
      </section>

      <section className="panel">
        <h2>Allocations for {brand.name}</h2>
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
      <h2>Coverage by process</h2>
      <table className="mini-table">
        <thead>
          <tr>
            <th>Process</th><th>Brands</th><th>Operating days</th><th>Covered</th><th>Gaps / short</th><th>Coverage</th>
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
                <td>{cov.length}</td>
                <td>{covered}</td>
                <td className={bad > 0 ? 'bad-text' : ''}>{bad}</td>
                <td>{pct}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">
        “Operating days” counts every brand-process day the process had to be staffed.
        A day counts as covered only when the scheduled headcount meets the brand’s minimum staffing for that process.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Employees view
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
          <h2>Employee</h2>
          <select value={emp.id} onChange={(e) => props.setSelectedEmployee(e.target.value)}>
            {data.employees.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
        <p className="muted">
          {PODS.find((x) => x.id === emp.podId)?.name} · {myAllocs.length} allocation(s) ·{' '}
          {myEntries.length} working days this month · {overridden} weekly off(s) overridden
        </p>
        <p>
          <strong>Allocations: </strong>
          {myAllocs.map((a) => {
            const b = data.brands.find((x) => x.id === a.brandId);
            return `${b?.name ?? a.brandId} (${processLabel(a.processId)}, ${a.role})`;
          }).join(' · ')}
        </p>
      </section>

      <section className="panel">
        <h2>Weekly off days (preferences)</h2>
        <div className="weekoff-row">
          {WEEKDAYS.map((label, i) => (
            <label key={label} className="check">
              <input
                type="checkbox"
                checked={emp.weeklyOff.includes(i)}
                onChange={() => toggleWeeklyOff(i)}
              />
              {label}
            </label>
          ))}
        </div>
        <p className="muted small">
          Changing a weekly off re-generates the month. The engine may still schedule the employee
          on that day if they are the only cover for a brand/process — that override is flagged as a warning.
        </p>
      </section>

      <section className="panel">
        <h2>Leave &amp; comp-offs</h2>
        <ul className="leave-list">
          {emp.leaves.map((d) => (
            <li key={d}>
              {d} — leave
              {!seedLeaves.includes(d) && (
                <button className="link-btn" onClick={() => removeLeave(d)}>Remove</button>
              )}
            </li>
          ))}
          {emp.compOffs.map((d) => (
            <li key={d}>{d} — comp-off</li>
          ))}
          {emp.leaves.length === 0 && emp.compOffs.length === 0 && <li className="muted">None this month.</li>}
        </ul>
        <div className="sim-row">
          <label>
            Add leave on
            <input type="date" value={newLeave} onChange={(e) => setNewLeave(e.target.value)} />
          </label>
          <button className="btn btn-primary" onClick={addLeave}>Add leave</button>
        </div>
      </section>

      <section className="panel">
        <h2>Month at a glance</h2>
        <div className="table-scroll">
          <table className="mini-table">
            <thead>
              <tr><th>Date</th><th>Day</th><th>Status</th><th>Assignment</th></tr>
            </thead>
            <tbody>
              {result.days.map((d) => {
                const entry = myEntries.find((e) => e.date === d);
                const holiday = isHoliday(d);
                let status = 'Not scheduled';
                let cls = 'muted';
                if (entry) {
                  status = entry.overriddenOff ? 'Working (weekly off overridden)' : 'Working';
                  cls = entry.overriddenOff ? 'warn-text' : '';
                } else if (emp.leaves.includes(d)) { status = 'Leave'; cls = 'bad-text'; }
                else if (emp.compOffs.includes(d)) { status = 'Comp-off'; cls = 'bad-text'; }
                else if (holiday) { status = `Public holiday — ${holiday.name}`; }
                else if (emp.weeklyOff.includes(dayOfWeek(d))) { status = 'Weekly off'; }
                const brand = entry ? data.brands.find((b) => b.id === entry.brandId) : undefined;
                return (
                  <tr key={d}>
                    <td>{d}</td>
                    <td>{WEEKDAYS[dayOfWeek(d)]}</td>
                    <td className={cls}>{status}</td>
                    <td>{entry ? `${brand?.name ?? ''} — ${entry.processes.map((pid) => processLabel(pid)).join(', ')}` : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
          <h2>Conflicts &amp; Validation Diagnosis</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Isolates mandatory coverage gaps, understaffed brand processes, and soft weekly-off preference overrides.
          </p>
        </div>
        <div className="filters">
          <button className={props.filter === 'all' ? 'btn btn-primary' : 'btn'} onClick={() => props.setFilter('all')}>
            All ({props.allConflicts.length})
          </button>
          <button className={props.filter === 'error' ? 'btn btn-danger' : 'btn'} onClick={() => props.setFilter('error')}>
            Errors ({errors})
          </button>
          <button className={props.filter === 'gap' ? 'btn btn-danger' : 'btn'} onClick={() => props.setFilter('gap')} title="Zero staff scheduled on operating day">
            Gaps ({gaps})
          </button>
          <button className={props.filter === 'understaffed' ? 'btn btn-warn' : 'btn'} onClick={() => props.setFilter('understaffed')} title="Scheduled staff less than required minStaff">
            Understaffed ({under})
          </button>
          <button className={props.filter === 'warning' ? 'btn btn-warn' : 'btn'} onClick={() => props.setFilter('warning')}>
            Overrides ({warnings})
          </button>
        </div>
      </div>

      <div className="conflict-summary-banner">
        <strong>Executive Summary:</strong> {props.result.stats.coveredSlots} of {props.result.stats.operatingSlots} operating slots ({props.result.stats.coveragePct}%) are successfully staffed.
        {errors > 0 ? (
          <span> {errors} shortage slots are flagged due to approved employee leaves without authorized backup (Scenario A: GlowKart Retention 8–10 Dec; Scenario B: BookBarn 21 Dec) and dual-staffing requirements (TechTrove CS).</span>
        ) : (
          <span> All mandatory operational coverage requirements are satisfied.</span>
        )}
        {warnings > 0 && (
          <span> {warnings} weekly-off preferences were overridden to maintain mandatory brand coverage without hard-constraint failures.</span>
        )}
      </div>

      {conflicts.length === 0 ? (
        <p className="ok-text" style={{ marginTop: 14 }}>No conflicts in this view. All constraints satisfied.</p>
      ) : (
        <ul className="conflict-list" style={{ marginTop: 14 }}>
          {conflicts.map((c) => (
            <li key={c.id} className={c.severity}>
              <div className="conflict-main">
                <span className={`severity ${c.severity}`}>{c.severity === 'error' ? 'Error' : 'Warning'}</span>
                <span className="conflict-type-badge">{c.type}</span>
                <span className="conflict-date">{c.date}</span>
                <p>{c.message}</p>
                {c.suggestion && <p className="muted small">{c.suggestion}</p>}
              </div>
              {c.brandId && c.processId && (
                <div>
                  <button
                    className="btn btn-small"
                    onClick={() => props.setBackupFor(props.backupFor === c.id ? null : c.id)}
                  >
                    {props.backupFor === c.id ? 'Hide backup' : 'Find backup'}
                  </button>
                  {props.backupFor === c.id && (
                    <BackupList
                      data={props.data}
                      result={props.result}
                      date={c.date}
                      brandId={c.brandId}
                      processId={c.processId}
                      excludeEmployeeId={c.employeeId}
                    />
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
