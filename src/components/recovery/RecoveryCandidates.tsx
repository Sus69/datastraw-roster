import { useMemo, useState } from 'react';
import type { RecoveryCandidateEvaluation } from '../../lib/recoveryLab';
import { recoveryTypeLabel } from '../../lib/recovery';

type CandidateFilter = 'all' | 'eligible' | 'rejected';

interface RecoveryCandidatesProps {
  evaluations: RecoveryCandidateEvaluation[];
  selectedEmployeeId: string | null;
  onSelect?: (employeeId: string) => void;
}

const AVAILABILITY_CODES = ['ON_LEAVE_OR_COMP_OFF', 'CANDIDATE_DOUBLE_BOOKED', 'UNKNOWN_EMPLOYEE'];

function category(evaluation: RecoveryCandidateEvaluation): string {
  if (evaluation.outcome !== 'rejected') return evaluation.outcome === 'selected' ? 'Selected' : 'Eligible';
  if (!evaluation.rejectionCode) return 'Rejected';
  if (AVAILABILITY_CODES.includes(evaluation.rejectionCode)) return 'Unavailable';
  if (evaluation.rejectionCode === 'NO_DESTINATION_AUTHORIZATION' || evaluation.rejectionCode === 'NO_CROSS_POD_AUTHORIZATION' || evaluation.rejectionCode === 'NO_COMPATIBLE_PROCESS_ALLOCATION') {
    return 'Authorization';
  }
  return 'Eligibility / simulation';
}

function currentAssignmentText(evaluation: RecoveryCandidateEvaluation): string {
  const assignment = evaluation.final?.currentAssignment ?? evaluation.eligibility.currentAssignment;
  if (!assignment) return 'Unassigned';
  return `${assignment.brandName} (${assignment.processes.join(', ')})`;
}

export function RecoveryCandidates(props: RecoveryCandidatesProps) {
  const [filter, setFilter] = useState<CandidateFilter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return props.evaluations.filter((evaluation) => {
      if (filter === 'eligible') return evaluation.outcome !== 'rejected';
      if (filter === 'rejected') return evaluation.outcome === 'rejected';
      return true;
    });
  }, [filter, props.evaluations]);

  const rejectedCount = props.evaluations.filter((evaluation) => evaluation.outcome === 'rejected').length;
  const eligibleCount = props.evaluations.length - rejectedCount;

  if (props.evaluations.length === 0) {
    return (
      <div className="recovery-empty-state">
        No candidates entered evaluation. The discovered pool is empty for this target.
      </div>
    );
  }

  return (
    <div className="recovery-candidate-panel">
      <div className="recovery-panel-head">
        <div>
          <div className="recovery-section-kicker">Candidate evaluation panel</div>
          <h3 className="recovery-panel-title">Every considered employee and the engine’s actual decision</h3>
        </div>
        <div className="text-toggle-row" style={{ marginBottom: 0 }}>
          <button type="button" className={`text-toggle-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
            All ({props.evaluations.length})
          </button>
          <span className="text-toggle-sep">·</span>
          <button type="button" className={`text-toggle-btn ${filter === 'eligible' ? 'active' : ''}`} onClick={() => setFilter('eligible')}>
            Passed ({eligibleCount})
          </button>
          <span className="text-toggle-sep">·</span>
          <button type="button" className={`text-toggle-btn ${filter === 'rejected' ? 'active' : ''}`} onClick={() => setFilter('rejected')}>
            Rejected ({rejectedCount})
          </button>
        </div>
      </div>

      <div className="recovery-candidate-list">
        {filtered.map((evaluation) => {
          const isExpanded = expanded === evaluation.employeeId;
          const selected = props.selectedEmployeeId === evaluation.employeeId;
          const outcomeLabel = selected ? 'selected' : evaluation.outcome;
          return (
            <div
              key={evaluation.employeeId}
              className={`recovery-candidate-row ${outcomeLabel} ${selected ? 'is-selected' : ''}`}
            >
              <button
                type="button"
                className="recovery-candidate-summary"
                onClick={() => setExpanded(isExpanded ? null : evaluation.employeeId)}
                aria-expanded={isExpanded}
              >
                <span className={`recovery-candidate-dot ${outcomeLabel}`} />
                <span className="recovery-candidate-name">
                  <span className="recovery-person-id">{evaluation.employeeId.toUpperCase()}</span>
                  {evaluation.name}
                </span>
                <span className="recovery-candidate-category">{category(evaluation)}</span>
                <span className="recovery-candidate-assignment muted small">
                  {currentAssignmentText(evaluation)}
                </span>
                <span className={`recovery-candidate-outcome ${outcomeLabel}`}>{outcomeLabel}</span>
                <span className="recovery-expand-mark">{isExpanded ? '−' : '+'}</span>
              </button>

              {isExpanded && (
                <div className="recovery-candidate-detail">
                  <div className="recovery-candidate-checks">
                    <div><span>Availability</span><strong>{evaluation.eligibility.rejectionCode === 'ON_LEAVE_OR_COMP_OFF' ? 'Failed' : 'Passed'}</strong></div>
                    <div><span>Destination brand/process</span><strong>{evaluation.eligibility.destinationAuthorized ? 'Authorized' : 'Not authorized'}</strong></div>
                    <div><span>Process allocation</span><strong>{evaluation.eligibility.processAuthorized ? 'Present' : 'Missing'}</strong></div>
                    <div><span>Pod boundary</span><strong>{evaluation.eligibility.crossPodRequired ? (evaluation.eligibility.crossPodAuthorized ? 'Explicitly authorized' : 'Requires authorization') : 'Same pod'}</strong></div>
                    <div><span>Target assignment</span><strong>{evaluation.eligibility.targetAuthorized ? 'Allocated' : 'Not directly allocated'}</strong></div>
                    <div><span>Recovery type</span><strong>{evaluation.eligibility.recoveryType ? recoveryTypeLabel(evaluation.eligibility.recoveryType) : '—'}</strong></div>
                  </div>

                  {evaluation.rejectionCode ? (
                    <div className="recovery-rejection-box">
                      <span className="diag-code">{evaluation.rejectionCode}</span>
                      <span>{evaluation.rejectionReason}</span>
                    </div>
                  ) : (
                    <div className="recovery-success-box">
                      All required checks passed. The proposal remains subject to simulation and independent validation.
                    </div>
                  )}

                  {evaluation.final && (
                    <div className="recovery-candidate-metrics">
                      <span>Changes <strong>{evaluation.final.changedAssignments}</strong></span>
                      <span>Source loss <strong>{evaluation.final.sourceCoverageLoss}</strong></span>
                      <span>At minimum <strong>{evaluation.final.sourceProcessesAtMinimum}</strong></span>
                      <span>Primary disruption <strong>{evaluation.final.primaryDisruption}</strong></span>
                      <span>Weekly-off override <strong>{evaluation.final.weeklyOffOverrides}</strong></span>
                      <span>Workload <strong>{evaluation.final.currentWorkload}</strong></span>
                    </div>
                  )}

                  {props.onSelect && evaluation.outcome !== 'rejected' && (
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => props.onSelect?.(evaluation.employeeId)}>
                      Select proposal
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
