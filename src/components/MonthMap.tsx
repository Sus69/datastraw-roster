import React from 'react';
import { PODS, WEEKDAYS, isHoliday, processLabel } from '../data/seed';
import type { ProcessId } from '../data/seed';
import type { RosterData, RosterResult } from '../lib/engine';
import { isHardUnavailable, isWeeklyOff } from '../lib/engine';

export interface MonthMapProps {
  data: RosterData;
  result: RosterResult;
  entryByKey: Map<string, { brandId: string; processes: ProcessId[]; overriddenOff: boolean }>;
  onSelectCell: (employeeId: string, date: string) => void;
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

export function MonthMap(props: MonthMapProps) {
  const { data, result, entryByKey, onSelectCell } = props;
  const brandById = new Map(data.brands.map((b) => [b.id, b]));

  return (
    <div className="month-map-wrapper">
      <div className="month-map-head">
        <div>
          <h3 className="month-map-title">Month map ({data.employees.length} staff · {result.days.length} days)</h3>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            Full workforce overview. Click any cell to jump to that shift in the detail grid.
          </p>
        </div>
      </div>

      <div className="month-map-container">
        <table className="month-map-table">
          <thead>
            <tr>
              <th className="map-sticky-col map-header-corner">Pod / employee</th>
              {result.days.map((d) => {
                const dt = new Date(`${d}T12:00:00`);
                const isSun = dt.getDay() === 0;
                return (
                  <th
                    key={d}
                    className={`map-day-header ${isSun ? 'map-sun' : ''}`}
                    title={`${d} (${WEEKDAYS[dt.getDay()]})`}
                  >
                    <span className="map-day-num">{dt.getDate()}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {PODS.map((pod) => {
              const podEmployees = data.employees.filter((e) => e.podId === pod.id);
              if (podEmployees.length === 0) return null;

              return (
                <React.Fragment key={pod.id}>
                  {/* Pod Group Header Row */}
                  <tr className="map-pod-group-row">
                    <td className="map-sticky-col map-pod-name" colSpan={result.days.length + 1}>
                      <span className="map-pod-tag">{pod.name}</span>
                      <span className="map-pod-count">({podEmployees.length} staff)</span>
                    </td>
                  </tr>

                  {/* Employee Rows under Pod */}
                  {podEmployees.map((emp) => (
                    <tr key={emp.id} className="map-emp-row">
                      <td
                        className="map-sticky-col map-emp-label"
                        onClick={() => onSelectCell(emp.id, result.days[0])}
                        title={`Click to view ${emp.name} in detail grid`}
                      >
                        <span className="map-emp-name-text">{emp.name}</span>
                      </td>

                      {result.days.map((d) => {
                        const entry = entryByKey.get(`${emp.id}|${d}`);
                        const holiday = isHoliday(d);

                        if (entry) {
                          const brand = brandById.get(entry.brandId);
                          const procCls = getProcessClass(entry.processes);
                          const procNames = entry.processes.map((p) => processLabel(p)).join(', ');
                          const isOverridden = entry.overriddenOff;
                          const tip = `${emp.name} — ${d}: ${brand?.name ?? entry.brandId} (${procNames})${
                            isOverridden ? ' [Weekly off overridden]' : ''
                          }`;

                          return (
                            <td
                              key={d}
                              className="map-cell-td"
                              onClick={() => onSelectCell(emp.id, d)}
                            >
                              <div
                                className={`map-square work ${procCls} ${isOverridden ? 'overridden' : ''}`}
                                title={tip}
                              />
                            </td>
                          );
                        }

                        if (isHardUnavailable(emp, d)) {
                          const reason = emp.leaves.includes(d) ? 'Planned leave' : 'Comp-off';
                          const tip = `${emp.name} — ${d}: ${reason}`;
                          return (
                            <td
                              key={d}
                              className="map-cell-td"
                              onClick={() => onSelectCell(emp.id, d)}
                            >
                              <div className="map-square leave" title={tip} />
                            </td>
                          );
                        }

                        if (holiday) {
                          const tip = `${emp.name} — ${d}: Public holiday (${holiday.name})`;
                          return (
                            <td
                              key={d}
                              className="map-cell-td"
                              onClick={() => onSelectCell(emp.id, d)}
                            >
                              <div className="map-square holiday" title={tip} />
                            </td>
                          );
                        }

                        if (isWeeklyOff(emp, d)) {
                          const tip = `${emp.name} — ${d}: Preferred weekly off`;
                          return (
                            <td
                              key={d}
                              className="map-cell-td"
                              onClick={() => onSelectCell(emp.id, d)}
                            >
                              <div className="map-square off" title={tip} />
                            </td>
                          );
                        }

                        const tip = `${emp.name} — ${d}: Not scheduled (Reserve capacity)`;
                        return (
                          <td
                            key={d}
                            className="map-cell-td"
                            onClick={() => onSelectCell(emp.id, d)}
                          >
                            <div className="map-square idle" title={tip} />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="map-legend">
        <span className="lg-label">Legend:</span>
        <span className="lg-item"><span className="map-sq-sample work proc-cs" /> Customer support</span>
        <span className="lg-item"><span className="map-sq-sample work proc-acc" /> Abandoned cart</span>
        <span className="lg-item"><span className="map-sq-sample work proc-ret" /> Retention</span>
        <span className="lg-item"><span className="map-sq-sample work proc-ndr" /> Non-delivery</span>
        <span className="lg-item"><span className="map-sq-sample work proc-multi" /> Multi</span>
        <span className="lg-item"><span className="map-sq-sample work overridden" /> Override</span>
        <span className="lg-item"><span className="map-sq-sample leave" /> Leave</span>
        <span className="lg-item"><span className="map-sq-sample holiday" /> Holiday</span>
        <span className="lg-item"><span className="map-sq-sample off" /> Weekly off</span>
        <span className="lg-item"><span className="map-sq-sample idle" /> Reserve</span>
      </div>
    </div>
  );
}
