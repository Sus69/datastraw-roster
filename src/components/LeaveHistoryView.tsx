import { PODS, processLabel } from '../data/seed';
import type { Employee, ProcessId } from '../data/seed';
import type { RosterData, RosterResult } from '../lib/engine';

export interface LeaveRow {
  id: string;
  employee: Employee;
  podName: string;
  kind: 'leave' | 'comp-off';
  dates: string[];
  startDate: string;
  endDate: string;
  primary: { brandId: string; brandName: string; processId: ProcessId }[];
  days: Array<{
    date: string;
    slots: Array<{
      brandName: string;
      processId: ProcessId;
      operating: boolean;
      status: 'covered' | 'understaffed' | 'gap' | 'not-operating';
      required: number;
      coverNames: string[];
      overriddenNames: string[];
    }>;
  }>;
  gapCount: number;
  overriddenNames: string[];
}

function nextDay(iso: string): string {
  const dt = new Date(`${iso}T12:00:00`);
  dt.setDate(dt.getDate() + 1);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function groupConsecutive(dates: string[]): string[][] {
  const groups: string[][] = [];
  for (const date of dates) {
    const current = groups[groups.length - 1];
    if (current && nextDay(current[current.length - 1]) === date) {
      current.push(date);
    } else {
      groups.push([date]);
    }
  }
  return groups;
}

/**
 * Derive leave episodes from the merged roster data and the active result.
 * Only dates inside the visible roster month are used, so every episode has
 * coverage data that can be inspected.
 */
export function buildLeaveRows(data: RosterData, result: RosterResult): LeaveRow[] {
  const monthDays = new Set(result.days);
  const rows: LeaveRow[] = [];
  const employeeName = (id: string) => data.employees.find((e) => e.id === id)?.name ?? id;

  for (const employee of data.employees) {
    const podName = PODS.find((p) => p.id === employee.podId)?.name ?? employee.podId;

    const kinds: Array<{ kind: LeaveRow['kind']; dates: string[] }> = [
      { kind: 'leave', dates: employee.leaves },
      { kind: 'comp-off', dates: employee.compOffs },
    ];

    for (const { kind, dates } of kinds) {
      const visible = [...new Set(dates.filter((d) => monthDays.has(d)))].sort();
      for (const episodeDates of groupConsecutive(visible)) {
        const primary = employeeNormalAllocations(data, result, employee.id, episodeDates);
        const days: LeaveRow['days'] = episodeDates.map((date) => {
          const slots = primary.map((allocation) => {
            const coverage = result.coverage.find(
              (c) => c.date === date && c.brandId === allocation.brandId && c.processId === allocation.processId,
            );
            return {
              brandName: allocation.brandName,
              processId: allocation.processId,
              operating: coverage?.operating ?? false,
              status: coverage?.status ?? 'not-operating',
              required: coverage?.required ?? 0,
              coverNames: (coverage?.scheduled ?? []).map(employeeName),
              overriddenNames: (coverage?.overriddenOff ?? []).map(employeeName),
            };
          });
          return { date, slots };
        });

        const gapCount = days.reduce(
          (total, day) => total + day.slots.filter((s) => s.operating && s.status !== 'covered').length,
          0,
        );
        const overriddenNames = [
          ...new Set(days.flatMap((day) => day.slots.flatMap((slot) => slot.overriddenNames))),
        ];

        rows.push({
          id: `${employee.id}|${kind}|${episodeDates[0]}`,
          employee,
          podName,
          kind,
          dates: episodeDates,
          startDate: episodeDates[0],
          endDate: episodeDates[episodeDates.length - 1],
          primary,
          days,
          gapCount,
          overriddenNames,
        });
      }
    }
  }

  return rows.sort((a, b) => {
    if (a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate);
    return a.employee.name.localeCompare(b.employee.name);
  });
}

function employeeNormalAllocations(
  data: RosterData,
  result: RosterResult,
  employeeId: string,
  dates: string[],
): LeaveRow['primary'] {
  // Prefer the employee's primary allocations. A few shared/backup staff have
  // no primary record (for example Karan Bhatia or the comp-off specialists);
  // for them use the first allocation that actually operates during the
  // episode, so the row names the brand they normally cover on those dates.
  const all = data.allocations.filter((allocation) => allocation.employeeId === employeeId);
  const primary = all.filter((allocation) => allocation.role === 'primary');
  let relevant = primary;
  if (relevant.length === 0) {
    const operating = all.filter((allocation) =>
      dates.some((date) =>
        result.coverage.some(
          (c) =>
            c.date === date &&
            c.brandId === allocation.brandId &&
            c.processId === allocation.processId &&
            c.operating,
        ),
      ),
    );
    relevant = (operating.length > 0 ? operating : all).slice(0, 1);
  }
  const seen = new Set<string>();
  const rows: LeaveRow['primary'] = [];
  for (const allocation of relevant) {
    const key = `${allocation.brandId}|${allocation.processId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      brandId: allocation.brandId,
      brandName: data.brands.find((b) => b.id === allocation.brandId)?.name ?? allocation.brandId,
      processId: allocation.processId,
    });
  }
  return rows;
}

function formatDay(iso: string): string {
  const dt = new Date(`${iso}T12:00:00`);
  return `${dt.toLocaleString('en-GB', { month: 'short' })} ${dt.getDate()}`;
}

function formatRange(row: LeaveRow): string {
  const start = new Date(`${row.startDate}T12:00:00`);
  const end = new Date(`${row.endDate}T12:00:00`);
  if (row.startDate === row.endDate) {
    return `${formatDay(row.startDate)}, ${start.getFullYear()}`;
  }
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${start.toLocaleString('en-GB', { month: 'short' })} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`;
  }
  return `${formatDay(row.startDate)} – ${formatDay(row.endDate)}, ${end.getFullYear()}`;
}

function normalCoverSentence(row: LeaveRow): string {
  const byBrand = new Map<string, ProcessId[]>();
  for (const allocation of row.primary) {
    const list = byBrand.get(allocation.brandName) ?? [];
    list.push(allocation.processId);
    byBrand.set(allocation.brandName, list);
  }
  if (byBrand.size === 0) return 'No primary allocation.';
  return [...byBrand.entries()]
    .map(([brand, processes]) => `${brand} — ${processes.map((p) => `${p} (${processLabel(p)})`).join(', ')}`)
    .join('; ');
}

function coverSentence(day: LeaveRow['days'][number]): string {
  const parts = day.slots.map((slot) => {
    if (!slot.operating) return `${slot.processId} not operating`;
    if (slot.coverNames.length === 0) return `${slot.processId} no cover`;
    const count = slot.status === 'covered' ? '' : ` (${slot.coverNames.length} of ${slot.required})`;
    return `${slot.processId} ${slot.coverNames.join(', ')}${count}`;
  });
  return parts.join('; ');
}

interface LeaveHistoryViewProps {
  rows: LeaveRow[];
  onInspect: (date: string, employeeId: string) => void;
}

export function LeaveHistoryView(props: LeaveHistoryViewProps) {
  const { rows } = props;
  const leaveRows = rows.filter((r) => r.kind === 'leave');
  const people = new Set(leaveRows.map((r) => r.employee.id)).size;
  const leaveDays = leaveRows.reduce((n, r) => n + r.dates.length, 0);
  const compOffs = rows.filter((r) => r.kind === 'comp-off').length;
  const gaps = rows.reduce((n, r) => n + r.gapCount, 0);
  const coveragePhrase = gaps === 0 ? 'all covered' : `${gaps} uncovered`;

  return (
    <div className="ledger-section leave-history">
      <p className="compliance-line leave-history-summary tabular">
        {people} {people === 1 ? 'person' : 'people'}, {leaveDays} leave-day{leaveDays !== 1 ? 's' : ''},{' '}
        {compOffs} comp-off{compOffs !== 1 ? 's' : ''}, {coveragePhrase}, {gaps} gap{gaps !== 1 ? 's' : ''}.
      </p>

      {rows.length === 0 ? (
        <p className="muted" style={{ marginTop: 14 }}>
          No leave or comp-off episodes in this month.
        </p>
      ) : (
        rows.map((row) => (
          <div
            key={row.id}
            className="ledger-row leave-history-row"
            role="button"
            tabIndex={0}
            onClick={() => props.onInspect(row.startDate, row.employee.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                props.onInspect(row.startDate, row.employee.id);
              }
            }}
            title={`Open ${row.employee.name}'s shift detail for ${formatRange(row)}`}
          >
            <div className="ledger-row-left leave-history-main">
              <div className="leave-history-head">
                <span className="leave-history-person">{row.employee.name}</span>
                <span className="muted small">{row.podName}</span>
                <span className="leave-history-sep">·</span>
                <span className="leave-history-date tabular">{formatRange(row)}</span>
                <span className="leave-history-sep">·</span>
                <span className="leave-history-type">{row.kind === 'comp-off' ? 'Comp-off' : 'Planned leave'}</span>
              </div>
              <div className="leave-history-fact">Normally covers: {normalCoverSentence(row)}</div>
              {row.days.map((day) => (
                <div key={day.date} className="leave-history-fact leave-history-cover">
                  Cover on {formatDay(day.date)}: {coverSentence(day)}
                </div>
              ))}
              <div className="leave-history-fact">
                Weekly-off override: {row.overriddenNames.length === 0
                  ? 'none'
                  : `yes — ${row.overriddenNames.join(', ')}`}
              </div>
            </div>
            <div className="ledger-row-right">
              <span className="leave-history-status tabular">
                <span className={`status-sq ${row.gapCount === 0 ? 'status-success' : 'status-danger'}`} />
                {row.gapCount === 0 ? 'Covered' : `${row.gapCount} gap${row.gapCount !== 1 ? 's' : ''}`}
              </span>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
