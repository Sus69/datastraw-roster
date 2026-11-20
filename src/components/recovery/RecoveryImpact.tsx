import { processLabel } from '../../data/seed';
import type { RecoveryLabSelection, RecoveryLabTrace } from '../../lib/recoveryLab';
import { recoveryTypeLabel } from '../../lib/recovery';
import { RecoveryProposals } from './RecoveryProposals';

interface RecoveryImpactProps {
  trace: RecoveryLabTrace;
  selection: RecoveryLabSelection | null;
  selectedEmployeeId: string | null;
  onSelectProposal: (employeeId: string) => void;
}

function effectLabel(effect: 'resolved' | 'introduced' | 'changed'): string {
  if (effect === 'resolved') return 'Resolved';
  if (effect === 'introduced') return 'Introduced';
  return 'Changed';
}

function MovementStage(props: { selection: RecoveryLabSelection }) {
  const { candidate } = props.selection;
  const source = candidate.currentAssignment;
  const destination = candidate.targetAssignment;
  const destinationProcesses = candidate.addedAssignments[0]?.processes ?? [destination.processId];
  const sourceLabel = source ? source.brandName : 'Unassigned reserve';
  const sourceDetail = source
    ? source.processes.map((pid) => processLabel(pid)).join(', ')
    : 'Not scheduled on this date';

  return (
    <div className="recovery-movement" key={`${candidate.employeeId}-${destination.brandId}-${destination.processId}`}>
      <div className="recovery-movement-head">
        <div>
          <div className="recovery-section-kicker">Assignment movement</div>
          <h3 className="recovery-panel-title">
            {candidate.name} moves for one date â€” permanent allocations are untouched
          </h3>
        </div>
        <span className="chip slate">{recoveryTypeLabel(candidate.recoveryType)}</span>
      </div>

      <div className="recovery-movement-track">
        <div className={`recovery-movement-group source ${source ? '' : 'unassigned'}`}>
          <div className="recovery-movement-group-label">Original assignment</div>
          <div className="recovery-movement-group-name">{sourceLabel}</div>
          <div className="recovery-movement-group-sub">{sourceDetail}</div>
          <div className="recovery-movement-chip-wrap">
            <span className="recovery-movement-chip ghost">
              <span className="recovery-person-id">{candidate.employeeId.toUpperCase()}</span>
              {candidate.name}
            </span>
          </div>
        </div>

        <div className="recovery-movement-arrow" aria-hidden="true">
          <span className="recovery-movement-arrow-line" />
          <span className="recovery-movement-arrow-head">â†’</span>
          <span className="recovery-movement-arrow-label">simulated move</span>
        </div>

        <div className="recovery-movement-group destination">
          <div className="recovery-movement-group-label">Simulated destination</div>
          <div className="recovery-movement-group-name">{destination.brandName}</div>
          <div className="recovery-movement-group-sub">
            {destinationProcesses.map((pid) => processLabel(pid)).join(', ')}
          </div>
          <div className="recovery-movement-chip-wrap">
            <span className="recovery-movement-chip arrival">
              <span className="recovery-person-id">{candidate.employeeId.toUpperCase()}</span>
              {candidate.name}
            </span>
          </div>
        </div>

        <span className="recovery-movement-flyer" aria-hidden="true">
          <span className="recovery-person-id">{candidate.employeeId.toUpperCase()}</span>
          {candidate.name}
        </span>
      </div>

      <div className="recovery-movement-notes">
        <span>
          <strong>Removed:</strong>{' '}
          {candidate.removedAssignments.length === 0
            ? 'none â€” unassigned employee'
            : candidate.removedAssignments.map((assignment) => `${assignment.brandName} (${assignment.processes.join(', ')})`).join(' + ')}
        </span>
        <span>
          <strong>Added:</strong>{' '}
          {candidate.addedAssignments.map((assignment) => `${assignment.brandName} (${assignment.processes.join(', ')})`).join(' + ')}
        </span>
      </div>
    </div>
  );
}

export function RecoveryImpact(props: RecoveryImpactProps) {
  const { trace, selection } = props;
  if (!selection) {
    const reasons = [...new Set(trace.analysis.rejected.map((candidate) => candidate.rejectionReason).filter(Boolean))];
    return (
      <div className="recovery-empty-state recovery-empty-impact">
        <strong>No valid proposal to visualize.</strong>
        <p>{trace.analysis.explanation || 'The engine did not produce a proposal that passed simulation and validation.'}</p>
        {reasons.length > 0 && (
          <ul>
            {reasons.slice(0, 6).map((reason) => (
              <li key={reason} className="muted small">{reason}</li>
            ))}
          </ul>
        )}
        <p className="muted small">Open the Execution view to inspect every candidate’s actual rejection decision.</p>
      </div>
    );
  }

  const { candidate, validation } = selection;
  const coverageRows = validation.coverageImpact;
  const sourceRows = candidate.sourceImpact;
  const added = candidate.addedAssignments;
  const removed = candidate.removedAssignments;

  return (
    <div className="recovery-impact">
      <div className={`recovery-impact-hero ${validation.valid ? 'valid' : 'invalid'}`}>
        <div>
          <div className="recovery-section-kicker">Selected recovery proposal</div>
          <h2 className="recovery-impact-title">
            {candidate.name} â†’ {candidate.targetAssignment.brandName} {candidate.targetAssignment.processName}
          </h2>
          <p className="recovery-impact-sub">
            {candidate.currentAssignment
              ? `From ${candidate.currentAssignment.brandName} (${candidate.currentAssignment.processes.map((pid) => processLabel(pid)).join(', ')})`
              : 'From the unassigned reserve'}
            {' Â· '}
            {candidate.targetAssignment.processName} on {trace.target.date}
            {' Â· '}
            {recoveryTypeLabel(candidate.recoveryType)}
          </p>
        </div>
        <div className="recovery-impact-status">
          <span className={`recovery-validation-badge ${validation.valid ? 'ok' : 'bad'}`}>
            {validation.valid ? 'Independent validation passed' : 'Independent validation failed'}
          </span>
          <span className="muted small">{validation.reason}</span>
        </div>
      </div>

      <MovementStage selection={selection} />

      <div className="recovery-impact-grid">
        <section className="recovery-impact-panel">
          <div className="recovery-panel-head">
            <div>
              <div className="recovery-section-kicker">Coverage comparison</div>
              <h3 className="recovery-panel-title">Before and after, recomputed by the validator</h3>
            </div>
            <span className="muted small">{coverageRows.length} affected slot(s)</span>
          </div>

          {coverageRows.length === 0 ? (
            <p className="muted small">The validator reported no coverage delta for this proposal.</p>
          ) : (
            <div className="table-wrap">
              <table className="ledger-table recovery-compact-table">
                <thead>
                  <tr>
                    <th>Brand / process</th>
                    <th className="num">Required</th>
                    <th className="num">Before</th>
                    <th className="num">After</th>
                    <th>Effect</th>
                  </tr>
                </thead>
                <tbody>
                  {coverageRows.map((row) => (
                    <tr key={`${row.brandId}-${row.processId}`}>
                      <td>
                        <strong>{row.brandName}</strong>{' '}
                        <span className="muted">{processLabel(row.processId)}</span>
                      </td>
                      <td className="num tabular">{row.required}</td>
                      <td className={`num tabular ${row.beforeStatus !== 'covered' ? 'bad-text' : ''}`}>
                        {row.beforeScheduled}/{row.required}
                      </td>
                      <td className={`num tabular ${row.afterStatus !== 'covered' ? 'bad-text' : 'ok-text'}`}>
                        {row.afterScheduled}/{row.required}
                      </td>
                      <td>
                        <span className={`recovery-effect ${row.effect}`}>{effectLabel(row.effect)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="recovery-impact-panel">
          <div className="recovery-panel-head">
            <div>
              <div className="recovery-section-kicker">Changed assignments</div>
              <h3 className="recovery-panel-title">What the directive actually changes</h3>
            </div>
          </div>
          <div className="recovery-change-list">
            {removed.length === 0 && (
              <div className="recovery-change-row muted">
                <span className="recovery-change-marker">â€”</span>
                <span>No assignment removed (temporary backup from reserve).</span>
              </div>
            )}
            {removed.map((assignment) => (
              <div key={`removed-${assignment.brandId}`} className="recovery-change-row removed">
                <span className="recovery-change-marker">âˆ’</span>
                <span>
                  <strong>{candidate.name}</strong> removed from {assignment.brandName}{' '}
                  <span className="muted">({assignment.processes.map((pid) => processLabel(pid)).join(', ')})</span>
                </span>
              </div>
            ))}
            {added.map((assignment) => (
              <div key={`added-${assignment.brandId}`} className="recovery-change-row added">
                <span className="recovery-change-marker">+</span>
                <span>
                  <strong>{candidate.name}</strong> added to {assignment.brandName}{' '}
                  <span className="muted">({assignment.processes.map((pid) => processLabel(pid)).join(', ')})</span>
                </span>
              </div>
            ))}
            <div className="recovery-change-row unchanged">
              <span className="recovery-change-marker">Â·</span>
              <span>{candidate.name}â€™s other dated entries and all permanent allocations are unchanged.</span>
            </div>
          </div>
        </section>
      </div>

      <div className="recovery-impact-grid">
        <section className="recovery-impact-panel">
          <div className="recovery-panel-head">
            <div>
              <div className="recovery-section-kicker">Source coverage impact</div>
              <h3 className="recovery-panel-title">What the move leaves behind</h3>
            </div>
            <span className={`chip ${candidate.sourceCoverageLoss === 0 ? 'ok' : 'warn'}`}>
              {candidate.sourceCoverageLoss} seat(s) lost
            </span>
          </div>

          {sourceRows.length === 0 ? (
            <p className="muted small">The candidate had no source assignment on this date.</p>
          ) : (
            <div className="table-wrap">
              <table className="ledger-table recovery-compact-table">
                <thead>
                  <tr>
                    <th>Source process</th>
                    <th className="num">Before</th>
                    <th className="num">After</th>
                    <th className="num">Slack</th>
                    <th>Covered by</th>
                    <th>Primary</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceRows.map((row) => (
                    <tr key={`${row.brandId}-${row.processId}`}>
                      <td>
                        <strong>{row.brandName}</strong>{' '}
                        <span className="muted">{processLabel(row.processId)}</span>
                      </td>
                      <td className="num tabular">{row.beforeScheduled}/{row.required}</td>
                      <td className={`num tabular ${row.remainsCovered ? 'ok-text' : 'bad-text'}`}>
                        {row.afterScheduled}/{row.required}
                      </td>
                      <td className="num tabular">{row.remainingSlack}</td>
                      <td>{row.coveredByOtherEmployees ? 'Another employee' : 'No cover'}</td>
                      <td>{row.primaryOwnedByCandidate ? 'Disrupted' : 'â€”'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="recovery-impact-facts">
            <div><span>Weekly-off override</span><strong>{candidate.weeklyOffOverrides > 0 ? 'Yes â€” flagged in validation' : 'None'}</strong></div>
            <div><span>Additional staffing</span><strong>{candidate.additionalStaffing > 0 ? 'Temporary authorization required' : 'None'}</strong></div>
            <div><span>Source processes at minimum</span><strong>{candidate.sourceProcessesAtMinimum}</strong></div>
            <div><span>Primary disruptions</span><strong>{candidate.primaryDisruption}</strong></div>
          </div>
        </section>

        <section className="recovery-impact-panel">
          <div className="recovery-panel-head">
            <div>
              <div className="recovery-section-kicker">Validation</div>
              <h3 className="recovery-panel-title">Independent validator result</h3>
            </div>
          </div>
          <div className={`recovery-validation-box ${validation.valid ? 'valid' : 'invalid'}`}>
            <div className="recovery-validation-title">
              {validation.valid ? 'All hard constraints remain satisfied' : 'The selected proposal failed validation'}
            </div>
            <p>{validation.reason}</p>
            {validation.failures.length > 0 ? (
              <ul>
                {validation.failures.map((failure, index) => (
                  <li key={`${failure.code}-${index}`}>
                    <span className="diag-code">{failure.code}</span> {failure.message}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="recovery-validation-meta">
                <span>Permanent allocations not mutated</span>
                <span>Unrelated roster entries unchanged</span>
                <span>Recomputed from baseline directive</span>
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="recovery-impact-panel recovery-impact-ranking">
        <div className="recovery-panel-head">
          <div>
            <div className="recovery-section-kicker">Proposal ranking</div>
            <h3 className="recovery-panel-title">All valid repairs, in the engineâ€™s lexicographical order</h3>
          </div>
        </div>
        <RecoveryProposals
          trace={trace}
          selectedEmployeeId={props.selectedEmployeeId}
          onSelect={props.onSelectProposal}
        />
      </section>
    </div>
  );
}
