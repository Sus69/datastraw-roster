import { useState } from 'react';
import { processLabel } from '../../data/seed';
import type { RecoveryLabSelection, RecoveryLabStage, RecoveryLabTrace } from '../../lib/recoveryLab';
import { rankingComparison } from '../../lib/recoveryLab';
import { RecoveryCandidates } from './RecoveryCandidates';

interface RecoveryExecutionProps {
  trace: RecoveryLabTrace;
  selection: RecoveryLabSelection | null;
  step: number;
  isPlaying: boolean;
  started: boolean;
  onPlay: () => void;
  onPause: () => void;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
  onRun: () => void;
  selectedEmployeeId: string | null;
  onSelectProposal: (employeeId: string) => void;
}

function statusLabel(status: RecoveryLabStage['status']): string {
  switch (status) {
    case 'completed': return 'Completed';
    case 'running': return 'Running';
    case 'rejected': return 'Rejected';
    case 'failed': return 'Failed';
    default: return 'Pending';
  }
}

function stageStatus(
  stage: RecoveryLabStage,
  index: number,
  step: number,
  isPlaying: boolean,
): RecoveryLabStage['status'] {
  if (index < step) return stage.status;
  if (index === step) {
    if (isPlaying && index < 8) return 'running';
    return stage.status;
  }
  return 'pending';
}

export function RecoveryExecution(props: RecoveryExecutionProps) {
  const { trace, selection } = props;
  const [expanded, setExpanded] = useState<string | null>('detect');
  const lastStage = trace.stages.length - 1;

  return (
    <div className="recovery-execution">
      <div className="recovery-playback">
        <div className="recovery-playback-left">
          <button type="button" className="btn btn-primary" onClick={props.onRun}>Run Simulation</button>
          <span className="recovery-playback-divider" />
          <button type="button" className="btn btn-secondary" onClick={props.onPrev} disabled={!props.started || props.step <= 0}>
            Previous Step
          </button>
          {props.isPlaying ? (
            <button type="button" className="btn btn-secondary" onClick={props.onPause}>Pause</button>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={props.onPlay} disabled={!props.started}>
              Play
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={props.onNext} disabled={!props.started || props.step >= lastStage}>
            Next Step
          </button>
          <button type="button" className="btn btn-secondary" onClick={props.onReset}>Reset</button>
        </div>
        <div className="recovery-playback-right">
          <span className={`recovery-playback-state ${props.isPlaying ? 'running' : ''}`}>
            {props.started ? `Stage ${Math.min(props.step + 1, trace.stages.length)} of ${trace.stages.length}` : 'Not started'}
            {props.isPlaying ? ' · playing' : ''}
          </span>
          <div className="recovery-progress-track" aria-hidden="true">
            <div
              className="recovery-progress-fill"
              style={{ width: props.started ? `${((props.step + 1) / trace.stages.length) * 100}%` : '0%' }}
            />
          </div>
        </div>
      </div>

      <div className="recovery-stage-list">
        {trace.stages.map((stage, index) => {
          const status = props.started ? stageStatus(stage, index, props.step, props.isPlaying) : 'pending';
          const isOpen = expanded === stage.id;
          return (
            <section key={stage.id} className={`recovery-stage stage-${status} ${isOpen ? 'expanded' : ''}`}>
              <button
                type="button"
                className="recovery-stage-head"
                onClick={() => setExpanded(isOpen ? null : stage.id)}
                aria-expanded={isOpen}
              >
                <span className="recovery-stage-index">{String(index + 1).padStart(2, '0')}</span>
                <span className={`recovery-stage-dot ${status}`} />
                <span className="recovery-stage-title-wrap">
                  <span className="recovery-stage-title">{stage.title}</span>
                  <span className="recovery-stage-description">{stage.description}</span>
                </span>
                <span className={`recovery-stage-status ${status}`}>{statusLabel(status)}</span>
                <span className="recovery-expand-mark">{isOpen ? '−' : '+'}</span>
              </button>

              {(isOpen || status === 'running' || index < props.step) && (
                <div className="recovery-stage-body">
                  <p className={`recovery-stage-summary ${status}`}>{stage.summary}</p>
                  {stage.metrics.length > 0 && (
                    <div className="recovery-stage-metrics">
                      {stage.metrics.map((metric) => (
                        <div key={metric.label} className={`recovery-stage-metric ${metric.tone ?? ''}`}>
                          <span>{metric.label}</span>
                          <strong className="tabular">{metric.value}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                  {isOpen && (
                    <StageDetails
                      stage={stage}
                      trace={trace}
                      selection={selection}
                      selectedEmployeeId={props.selectedEmployeeId}
                    />
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      <RecoveryCandidates
        evaluations={trace.evaluations}
        selectedEmployeeId={props.selectedEmployeeId}
        onSelect={props.onSelectProposal}
      />
    </div>
  );
}

function evaluationCodeList(
  trace: RecoveryLabTrace,
  codes: string[],
): typeof trace.evaluations {
  return trace.evaluations.filter(
    (evaluation) => evaluation.rejectionCode && codes.includes(evaluation.rejectionCode),
  );
}

function StageDetails(props: {
  stage: RecoveryLabStage;
  trace: RecoveryLabTrace;
  selection: RecoveryLabSelection | null;
  selectedEmployeeId: string | null;
}) {
  const { stage, trace, selection } = props;

  if (stage.id === 'detect') {
    return (
      <div className="recovery-stage-detail">
        <div className="recovery-detail-label">Impacted shortages in this scenario</div>
        <div className="recovery-shortage-list">
          {trace.impactedShortages.map((shortage) => (
            <div key={`${shortage.brandId}-${shortage.processId}`} className="recovery-shortage-row">
              <span className="recovery-shortage-name">{shortage.brandName} — {processLabel(shortage.processId)}</span>
              <span className="tabular">{shortage.beforeScheduled} → {shortage.afterScheduled} / {shortage.required}</span>
              <span className={`chip ${shortage.status === 'gap' ? 'bad' : 'warn'}`}>{shortage.status}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (stage.id === 'discover') {
    return (
      <div className="recovery-stage-detail">
        <div className="recovery-detail-label">Discovered pool ({trace.evaluations.length} evaluated)</div>
        <div className="recovery-discovery-grid">
          {trace.evaluations.map((evaluation) => (
            <div key={evaluation.employeeId} className="recovery-discovery-row">
              <span className="recovery-person-id">{evaluation.employeeId.toUpperCase()}</span>
              <span>{evaluation.name}</span>
              <span className="muted small">
                {evaluation.final?.currentAssignment
                  ? `${evaluation.final.currentAssignment.brandName} (${evaluation.final.currentAssignment.processes.join(', ')})`
                  : 'Reserve / unassigned'}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (stage.id === 'availability') {
    const rejected = evaluationCodeList(trace, ['ON_LEAVE_OR_COMP_OFF', 'CANDIDATE_DOUBLE_BOOKED', 'UNKNOWN_EMPLOYEE']);
    return (
      <div className="recovery-stage-detail">
        <div className="recovery-detail-label">Availability decisions</div>
        <div className="recovery-check-list">
          {trace.evaluations.map((evaluation) => {
            const failure = rejected.find((row) => row.employeeId === evaluation.employeeId);
            return (
              <div key={evaluation.employeeId} className={`recovery-check-row ${failure ? 'failed' : 'passed'}`}>
                <span className="recovery-check-mark">{failure ? '×' : '✓'}</span>
                <span className="recovery-check-name">{evaluation.name}</span>
                <span className="muted small">
                  {failure ? failure.rejectionReason : 'Available on this date'}
                </span>
                {failure?.rejectionCode && <span className="diag-code">{failure.rejectionCode}</span>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (stage.id === 'authorization') {
    return (
      <div className="recovery-stage-detail">
        <div className="recovery-detail-label">Authorization checks</div>
        <div className="recovery-check-list">
          {trace.evaluations.map((evaluation) => {
            const failed = evaluation.rejectionCode === 'NO_DESTINATION_AUTHORIZATION'
              || evaluation.rejectionCode === 'NO_CROSS_POD_AUTHORIZATION'
              || evaluation.rejectionCode === 'NO_COMPATIBLE_PROCESS_ALLOCATION';
            return (
              <div key={evaluation.employeeId} className={`recovery-check-row ${failed ? 'failed' : 'passed'}`}>
                <span className="recovery-check-mark">{failed ? '×' : '✓'}</span>
                <span className="recovery-check-name">{evaluation.name}</span>
                <span className="muted small">
                  {failed
                    ? evaluation.rejectionReason
                    : `${evaluation.eligibility.destinationAuthorized ? 'destination authorized' : 'same-pod process authorization'}${
                        evaluation.eligibility.crossPodRequired
                          ? evaluation.eligibility.crossPodAuthorized
                            ? ' · cross-pod grant present'
                            : ' · cross-pod grant absent'
                          : ' · same pod'
                      }`}
                </span>
                {failed && <span className="diag-code">{evaluation.rejectionCode}</span>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (stage.id === 'eligibility') {
    const validationCodes = ['REASSIGNMENT_CAUSES_UNDERSTAFFING', 'TARGET_NOT_COVERED', 'ALREADY_ASSIGNED_TARGET', 'INCOMPATIBLE_DUTY', 'TARGET_NOT_OPERATING', 'SIMULATION_INVALID'];
    return (
      <div className="recovery-stage-detail">
        <div className="recovery-detail-label">Reassignment eligibility</div>
        <div className="recovery-check-list">
          {trace.evaluations.map((evaluation) => {
            const failed = evaluation.rejectionCode && validationCodes.includes(evaluation.rejectionCode);
            return (
              <div key={evaluation.employeeId} className={`recovery-check-row ${failed ? 'failed' : 'passed'}`}>
                <span className="recovery-check-mark">{failed ? '×' : '✓'}</span>
                <span className="recovery-check-name">{evaluation.name}</span>
                <span className="muted small">
                  {failed ? evaluation.rejectionReason : evaluation.rejectionCode ? 'Rejected earlier in the pipeline' : 'All eligibility checks passed'}
                </span>
                {failed && <span className="diag-code">{evaluation.rejectionCode}</span>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (stage.id === 'simulate') {
    return (
      <div className="recovery-stage-detail">
        <div className="recovery-detail-label">Simulated directives</div>
        {trace.analysis.proposals.length === 0 ? (
          <p className="muted small">No simulated directive survived the whole-day coverage check.</p>
        ) : (
          <div className="recovery-sim-list">
            {trace.analysis.proposals.map((proposal) => (
              <div key={proposal.employeeId} className="recovery-sim-row">
                <span className="recovery-check-name">{proposal.name}</span>
                <span className="muted small">
                  {proposal.removedAssignments.length > 0
                    ? proposal.removedAssignments.map((assignment) => `${assignment.brandName} (${assignment.processes.join(', ')})`).join(' + ')
                    : 'No source removal (temporary backup)'}
                  {' → '}
                  {proposal.addedAssignments.map((assignment) => `${assignment.brandName} (${assignment.processes.join(', ')})`).join(' + ')}
                </span>
                <span className="chip ok">simulation valid</span>
              </div>
            ))}
          </div>
        )}
        {selection?.simulation && !selection.simulation.valid && (
          <div className="recovery-rejection-box">
            {selection.simulation.issues.map((issue) => (
              <span key={issue.code}><span className="diag-code">{issue.code}</span> {issue.message}</span>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (stage.id === 'source-impact') {
    return (
      <div className="recovery-stage-detail">
        <div className="recovery-detail-label">Source coverage impact</div>
        {trace.analysis.proposals.length === 0 ? (
          <p className="muted small">No source-impact evaluation was reached.</p>
        ) : (
          <div className="table-wrap">
            <table className="ledger-table recovery-compact-table">
              <thead>
                <tr><th>Employee</th><th>Source</th><th>Before</th><th>After</th><th>Slack</th><th>Still covered</th></tr>
              </thead>
              <tbody>
                {trace.analysis.proposals.flatMap((proposal) =>
                  proposal.sourceImpact.length === 0
                    ? [(
                      <tr key={`${proposal.employeeId}-none`}>
                        <td>{proposal.name}</td>
                        <td colSpan={5} className="muted">No source assignment — temporary backup</td>
                      </tr>
                    )]
                    : proposal.sourceImpact.map((impact) => (
                      <tr key={`${proposal.employeeId}-${impact.brandId}-${impact.processId}`}>
                        <td>{proposal.name}</td>
                        <td>{impact.brandName} {impact.processId}</td>
                        <td className="num tabular">{impact.beforeScheduled}/{impact.required}</td>
                        <td className="num tabular">{impact.afterScheduled}/{impact.required}</td>
                        <td className="num tabular">{impact.remainingSlack}</td>
                        <td className={impact.remainsCovered ? 'ok-text' : 'bad-text'}>{impact.remainsCovered ? 'Yes' : 'No'}</td>
                      </tr>
                    )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  if (stage.id === 'rank') {
    return (
      <div className="recovery-stage-detail">
        <div className="recovery-detail-label">Lexicographical order</div>
        <div className="recovery-rank-list">
          {trace.analysis.proposals.map((proposal, index) => (
            <div
              key={proposal.employeeId}
              className={`recovery-rank-row ${proposal.employeeId === props.selectedEmployeeId ? 'selected' : ''}`}
            >
              <span className={`recovery-rank ${index === 0 ? 'first' : ''}`}>{index + 1}</span>
              <span className="recovery-check-name">{proposal.name}</span>
              <span className="diag-code">[{proposal.rankingKey.join('/')}]</span>
              <span className="muted small">
                {index === 0 ? 'Selected by the engine.' : rankingComparison(trace.analysis.proposals[0], proposal)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="recovery-stage-detail">
      <div className="recovery-detail-label">Independent validator</div>
      {!selection ? (
        <p className="muted small">No proposal was selected for validation.</p>
      ) : (
        <div className={`recovery-validation-box ${selection.validation.valid ? 'valid' : 'invalid'}`}>
          <div className="recovery-validation-title">
            {selection.validation.valid ? 'Validation passed' : 'Validation failed'}
          </div>
          <p>{selection.validation.reason}</p>
          {selection.validation.failures.length > 0 && (
            <ul>
              {selection.validation.failures.map((failure, index) => (
                <li key={`${failure.code}-${index}`}>
                  <span className="diag-code">{failure.code}</span> {failure.message}
                </li>
              ))}
            </ul>
          )}
          <div className="recovery-validation-meta">
            <span>Directive: {selection.candidate.directive?.type}</span>
            <span>Permanent allocations unchanged</span>
            <span>{selection.validation.coverageImpact.length} coverage slot(s) compared</span>
          </div>
        </div>
      )}
    </div>
  );
}
