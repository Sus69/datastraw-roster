import { useMemo, useState } from 'react';
import { isHoliday, processLabel } from '../../data/seed';
import type { DayCoverage, RosterData, RosterEntry } from '../../lib/engine';
import type { RecoveryCandidate } from '../../lib/recovery';
import type { RecoveryShortageRef } from '../../lib/recoveryLab';
import { isHardUnavailable } from '../../lib/engine';

type BoardMode = 'original' | 'simulated';

interface RecoveryBoardProps {
  data: RosterData;
  entries: RosterEntry[];
  coverage: DayCoverage[];
  date: string;
  target: RecoveryShortageRef;
  mode: BoardMode;
  onModeChange: (mode: BoardMode) => void;
  canShowSimulated: boolean;
  selected?: RecoveryCandidate | null;
}

function employeeCode(employeeId: string): string {
  return employeeId.toUpperCase();
}

function coverageLabel(status: DayCoverage['status']): string {
  if (status === 'covered') return 'Covered';
  if (status === 'gap') return 'No cover';
  if (status === 'understaffed') return 'Understaffed';
  return 'Closed';
}

export function RecoveryBoard(props: RecoveryBoardProps) {
  const { data, entries, coverage, date, target, selected } = props;
  const [onlyAffected, setOnlyAffected] = useState(false);

  const affectedBrandIds = useMemo(() => {
    const ids = new Set<string>([target.brandId]);
    for (const impact of selected?.coverageImpact ?? []) ids.add(impact.brandId);
    for (const impact of selected?.sourceImpact ?? []) ids.add(impact.brandId);
    if (selected?.currentAssignment) ids.add(selected.currentAssignment.brandId);
    return ids;
  }, [selected, target.brandId]);

  const brands = data.brands.filter((brand) => {
    if (onlyAffected && !affectedBrandIds.has(brand.id)) return false;
    return brand.processes.some((bp) => {
      const slot = coverage.find((c) => c.brandId === brand.id && c.processId === bp.processId);
      return slot?.operating ?? false;
    });
  });

  const unavailable = data.employees.filter((employee) => isHardUnavailable(employee, date));
  const holiday = isHoliday(date);

  return (
    <div className="recovery-board-wrap">
      <div className="recovery-board-toolbar">
        <div className="recovery-segmented" role="group" aria-label="Roster version">
          <button
            type="button"
            className={`recovery-segmented-btn ${props.mode === 'original' ? 'active' : ''}`}
            onClick={() => props.onModeChange('original')}
          >
            Original roster
          </button>
          <button
            type="button"
            className={`recovery-segmented-btn ${props.mode === 'simulated' ? 'active' : ''}`}
            onClick={() => props.onModeChange('simulated')}
            disabled={!props.canShowSimulated}
            title={props.canShowSimulated ? 'Show the simulated roster' : 'Run a simulation and select a proposal first'}
          >
            Simulated roster
          </button>
        </div>

        <div className="recovery-board-toolbar-right">
          <label className="recovery-check">
            <input
              type="checkbox"
              checked={onlyAffected}
              onChange={(event) => setOnlyAffected(event.target.checked)}
            />
            Affected brands only
          </label>
          <span className="muted small tabular">{brands.length} brands · {date}</span>
        </div>
      </div>

      <div className="recovery-board-note">
        {props.mode === 'simulated' && selected ? (
          <span>
            Preview only — {selected.name} is moved for {date} in this simulation. Permanent allocations are unchanged.
          </span>
        ) : (
          <span>
            One employee covers every allocated process at their brand for the day. Process rows show who is covering each requirement.
          </span>
        )}
      </div>

      {unavailable.length > 0 && (
        <div className="recovery-unavailable-strip">
          <span className="recovery-strip-label">Unavailable</span>
          <div className="recovery-unavailable-list">
            {unavailable.map((employee) => (
              <span
                key={employee.id}
                className={`recovery-person-chip unavailable ${
                  selected?.employeeId === employee.id ? 'scenario-absent' : ''
                }`}
                title={`${employee.name} — ${employee.leaves.includes(date) ? 'planned leave' : 'comp-off'}`}
              >
                <span className="recovery-person-id">{employeeCode(employee.id)}</span>
                {employee.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {holiday && (
        <div className="recovery-board-note muted">Public holiday: {holiday.name}. Closed processes are not shown as shortages.</div>
      )}

      {brands.length === 0 ? (
        <div className="recovery-empty-state">No operating brand processes match this view on {date}.</div>
      ) : (
        <div className="recovery-brand-grid">
          {brands.map((brand) => {
            const pod = data.brands.find((b) => b.id === brand.id)?.podId;
            const processRows = brand.processes
              .filter((bp) => {
                const slot = coverage.find((c) => c.brandId === brand.id && c.processId === bp.processId);
                return slot?.operating ?? false;
              })
              .map((bp) => {
                const slot = coverage.find((c) => c.brandId === brand.id && c.processId === bp.processId);
                const assigned = entries.filter(
                  (entry) =>
                    entry.date === date &&
                    entry.brandId === brand.id &&
                    entry.processes.includes(bp.processId),
                );
                return { bp, slot, assigned };
              });
            const badCopies = processRows.filter((row) => row.slot && row.slot.status !== 'covered').length;
            const isTargetBrand = brand.id === target.brandId;
            const hasMoveTarget = selected?.targetAssignment.brandId === brand.id;
            const hasMoveSource = selected?.currentAssignment?.brandId === brand.id;

            return (
              <section
                key={brand.id}
                className={`recovery-brand-card ${badCopies > 0 ? 'has-shortage' : ''} ${
                  isTargetBrand ? 'is-target' : ''
                } ${hasMoveTarget ? 'is-destination' : ''} ${hasMoveSource ? 'is-source' : ''}`}
                aria-label={`${brand.name} assignments`}
              >
                <header className="recovery-brand-head">
                  <div className="recovery-brand-title-wrap">
                    <span className="recovery-brand-name">{brand.name}</span>
                    <span className="recovery-brand-sub">{brand.category} · {pod ?? brand.podId}</span>
                  </div>
                  <div className="recovery-brand-badges">
                    {hasMoveSource && <span className="recovery-mini-badge source">move source</span>}
                    {hasMoveTarget && <span className="recovery-mini-badge destination">destination</span>}
                    {badCopies > 0 ? (
                      <span className="recovery-mini-badge danger">{badCopies} shortage{badCopies === 1 ? '' : 's'}</span>
                    ) : (
                      <span className="recovery-mini-badge ok">covered</span>
                    )}
                  </div>
                </header>

                <div className="recovery-process-list">
                  {processRows.map(({ bp, slot, assigned }) => {
                    if (!slot) return null;
                    const isTargetProcess =
                      brand.id === target.brandId && bp.processId === target.processId;
                    return (
                      <div
                        key={bp.processId}
                        className={`recovery-process-row status-${slot.status} ${
                          isTargetProcess ? 'is-target-process' : ''
                        }`}
                      >
                        <div className="recovery-process-name">
                          <span className={`recovery-process-swatch proc-${bp.processId.toLowerCase()}`} />
                          {processLabel(bp.processId)}
                          {isTargetProcess && <span className="recovery-target-tag">target</span>}
                        </div>
                        <div className={`recovery-process-requirement ${slot.status !== 'covered' ? 'bad-text' : 'muted'}`}>
                          <span className="tabular">{slot.scheduled.length}/{slot.required}</span>
                          <span className="recovery-process-status">{coverageLabel(slot.status)}</span>
                        </div>
                        <div className="recovery-chip-row">
                          {assigned.length === 0 ? (
                            <span className="recovery-no-cover">No one assigned</span>
                          ) : (
                            assigned.map((entry) => {
                              const employee = data.employees.find((e) => e.id === entry.employeeId);
                              const moved =
                                props.mode === 'simulated' &&
                                selected?.employeeId === entry.employeeId &&
                                selected.targetAssignment.brandId === brand.id;
                              return (
                                <span
                                  key={`${entry.employeeId}-${bp.processId}`}
                                  className={`recovery-person-chip ${moved ? 'moved-in' : ''} ${
                                    entry.overriddenOff ? 'override' : ''
                                  }`}
                                  title={`${employee?.name ?? entry.employeeId} — covers ${entry.processes
                                    .map((pid) => processLabel(pid))
                                    .join(', ')}${entry.overriddenOff ? ' · weekly-off override' : ''}`}
                                >
                                  <span className="recovery-person-id">{employeeCode(entry.employeeId)}</span>
                                  <span className="recovery-person-name">{employee?.name ?? entry.employeeId}</span>
                                  {entry.overriddenOff && <span className="recovery-chip-mark">OFF</span>}
                                </span>
                              );
                            })
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <div className="recovery-board-legend">
        <span className="recovery-legend-item"><span className="recovery-legend-sq covered" /> Covered requirement</span>
        <span className="recovery-legend-item"><span className="recovery-legend-sq under" /> Understaffed</span>
        <span className="recovery-legend-item"><span className="recovery-legend-sq gap" /> No cover</span>
        <span className="recovery-legend-item"><span className="recovery-legend-chip moved" /> Moved in simulation</span>
        <span className="recovery-legend-item"><span className="recovery-legend-chip absent" /> Unavailable</span>
      </div>
    </div>
  );
}
