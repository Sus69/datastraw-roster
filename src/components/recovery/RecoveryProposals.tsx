import type { RecoveryLabTrace } from '../../lib/recoveryLab';
import { proposalCriteria, rankingComparison } from '../../lib/recoveryLab';
import { recoveryTypeLabel } from '../../lib/recovery';

interface RecoveryProposalsProps {
  trace: RecoveryLabTrace;
  selectedEmployeeId: string | null;
  onSelect: (employeeId: string) => void;
  dense?: boolean;
}

export function RecoveryProposals(props: RecoveryProposalsProps) {
  const { trace } = props;
  const proposals = trace.analysis.proposals;
  const selected =
    proposals.find((proposal) => proposal.employeeId === props.selectedEmployeeId) ?? proposals[0];

  if (proposals.length === 0) {
    return (
      <div className="recovery-empty-state">
        <strong>No valid proposals were generated.</strong>
        <p>{trace.analysis.explanation || 'The engine rejected every candidate for this slot.'}</p>
      </div>
    );
  }

  return (
    <div className="recovery-proposals">
      <div className="table-wrap">
        <table className="ledger-table recovery-proposal-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Employee</th>
              <th>Route</th>
              <th>Type</th>
              <th className="num">Key</th>
              <th className="num">Changes</th>
              <th className="num">Source loss</th>
              <th className="num">At min</th>
              <th className="num">Primary</th>
              <th className="num">Off</th>
              <th className="num">Add. staff</th>
              <th className="num">Load</th>
            </tr>
          </thead>
          <tbody>
            {proposals.map((proposal, index) => {
              const isSelected = proposal.employeeId === selected?.employeeId;
              return (
                <tr
                  key={proposal.employeeId}
                  className={isSelected ? 'recovery-proposal-selected' : ''}
                  onClick={() => props.onSelect(proposal.employeeId)}
                >
                  <td className="recovery-rank-cell">
                    <span className={`recovery-rank ${index === 0 ? 'first' : ''}`}>{index + 1}</span>
                  </td>
                  <td>
                    <button type="button" className="recovery-row-button">
                      {proposal.name}
                    </button>
                  </td>
                  <td className="muted small">
                    {proposal.currentAssignment
                      ? `${proposal.currentAssignment.brandName} → ${proposal.targetAssignment.brandName}`
                      : `Unassigned → ${proposal.targetAssignment.brandName}`}
                  </td>
                  <td className="small">{recoveryTypeLabel(proposal.recoveryType)}</td>
                  <td className="num tabular">{proposal.rankingKey.join('/')}</td>
                  <td className="num tabular">{proposal.changedAssignments}</td>
                  <td className="num tabular">{proposal.sourceCoverageLoss}</td>
                  <td className="num tabular">{proposal.sourceProcessesAtMinimum}</td>
                  <td className="num tabular">{proposal.primaryDisruption}</td>
                  <td className="num tabular">{proposal.weeklyOffOverrides}</td>
                  <td className="num tabular">{proposal.additionalStaffing}</td>
                  <td className="num tabular">{proposal.currentWorkload}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="recovery-ranking-detail">
          <div className="recovery-ranking-detail-head">
            <div>
              <div className="recovery-section-kicker">Selected proposal</div>
              <div className="recovery-ranking-detail-title">
                {selected.name} → {selected.targetAssignment.brandName} {selected.targetAssignment.processName}
              </div>
              <div className="recovery-ranking-detail-sub">{selected.rankingExplanation}</div>
            </div>
            <span className={`recovery-validation-mini ${selected.valid ? 'ok' : 'bad'}`}>
              {selected.valid ? 'Engine-valid' : 'Rejected'}
            </span>
          </div>

          <div className="recovery-criteria-grid">
            {proposalCriteria(selected).map((criterion) => (
              <div key={criterion.label} className="recovery-criterion">
                <span className="recovery-criterion-label">{criterion.label}</span>
                <span className="recovery-criterion-value tabular">{criterion.value}</span>
                <span className="recovery-criterion-hint">{criterion.hint}</span>
              </div>
            ))}
          </div>

          <div className="recovery-why">
            <div className="recovery-section-kicker">Why this proposal ranks first</div>
            <p>{selected.reasons.join(' ')}</p>
            <ul>
              {proposals.slice(1).map((alternative) => (
                <li key={alternative.employeeId}>
                  <strong>{alternative.name}</strong>: {rankingComparison(selected, alternative)}
                </li>
              ))}
            </ul>
            <p className="muted small">
              Ranking is lexicographical, not a weighted score. The key reads left to right; the first
              differing criterion decides the order, with employee id as the deterministic tie-break.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
