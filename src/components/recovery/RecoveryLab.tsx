import { useEffect, useMemo, useState } from 'react';
import type { RosterData, RosterResult } from '../../lib/engine';
import type { RecoveryAssignment } from '../../data/seed';
import { isHardUnavailable } from '../../lib/engine';
import type { RecoveryCandidate } from '../../lib/recovery';
import { recoveryTypeLabel } from '../../lib/recovery';
import { processLabel } from '../../data/seed';
import {
  buildAbsenceScenario,
  buildProposalSelection,
  buildRecoveryTrace,
  compareShortages,
  targetShortage,
  type RecoveryLabTrace,
  type RecoveryShortageRef,
} from '../../lib/recoveryLab';
import { RecoveryBoard } from './RecoveryBoard';
import { RecoveryExecution } from './RecoveryExecution';
import { RecoveryImpact } from './RecoveryImpact';

interface RecoveryLabProps {
  data: RosterData;
  result: RosterResult;
  onApplyRepair: (
    assignment: RecoveryAssignment,
    absence?: { employeeId: string; date: string },
  ) => void;
}

type LabMode = 'absence' | 'existing';
type LabTab = 'roster' | 'execution' | 'impact';

interface LabContext {
  data: RosterData;
  result: RosterResult;
  target: RecoveryShortageRef;
  impacted: RecoveryShortageRef[];
  excludeEmployeeId?: string;
  mode: LabMode;
  scenarioLabel: string;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  return new Date(`${iso}T12:00:00`).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function targetKey(shortage: RecoveryShortageRef): string {
  return `${shortage.date}|${shortage.brandId}|${shortage.processId}`;
}

function currentAssignment(data: RosterData, result: RosterResult, employeeId: string, date: string): string {
  const entry = result.entries.find((row) => row.employeeId === employeeId && row.date === date);
  if (!entry) {
    const employee = data.employees.find((row) => row.id === employeeId);
    if (employee && isHardUnavailable(employee, date)) return 'Unavailable on this date';
    return 'Reserve / unassigned';
  }
  const brand = data.brands.find((row) => row.id === entry.brandId);
  return `${brand?.name ?? entry.brandId} — ${entry.processes.map((pid) => processLabel(pid)).join(', ')}${entry.overriddenOff ? ' · weekly-off override' : ''}`;
}

export function RecoveryLab(props: RecoveryLabProps) {
  const { data, result } = props;
  const [mode, setMode] = useState<LabMode>('absence');
  const [employeeId, setEmployeeId] = useState(data.employees[0]?.id ?? '');
  const [absenceDate, setAbsenceDate] = useState(result.days[0] ?? '');
  const [existingKey, setExistingKey] = useState('');
  const [context, setContext] = useState<LabContext | null>(null);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<LabTab>('roster');
  const [boardMode, setBoardMode] = useState<'original' | 'simulated'>('original');
  const [playbackStep, setPlaybackStep] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const existingShortages = useMemo(
    () =>
      result.conflicts.filter(
        (conflict) =>
          conflict.severity === 'error' &&
          (conflict.type === 'COVERAGE_GAP' || conflict.type === 'UNDERSTAFFED') &&
          Boolean(conflict.brandId) &&
          Boolean(conflict.processId),
      ),
    [result.conflicts],
  );

  const resolvedEmployeeId = data.employees.some((employee) => employee.id === employeeId)
    ? employeeId
    : data.employees[0]?.id ?? '';
  const resolvedAbsenceDate = result.days.includes(absenceDate)
    ? absenceDate
    : result.days[0] ?? '';
  const resolvedExistingKey = existingShortages.some((shortage) => shortage.id === existingKey)
    ? existingKey
    : existingShortages[0]?.id ?? '';

  const trace = useMemo<RecoveryLabTrace | null>(() => {
    if (!context) return null;
    return buildRecoveryTrace({
      data: context.data,
      result: context.result,
      target: context.target,
      impactedShortages: context.impacted,
      excludeEmployeeId: context.excludeEmployeeId,
      preferredEmployeeId: selectedEmployeeId ?? undefined,
    });
  }, [context, selectedEmployeeId]);

  const activeCandidate: RecoveryCandidate | null = trace
    ? trace.analysis.proposals.find((proposal) => proposal.employeeId === selectedEmployeeId) ??
      trace.selected
    : null;

  const selection = useMemo(() => {
    if (!trace || !activeCandidate) return null;
    return buildProposalSelection(trace.data, trace.result, activeCandidate);
  }, [activeCandidate, trace]);

  const selectedId = selectedEmployeeId ?? trace?.selected?.employeeId ?? null;

  useEffect(() => {
    if (!isPlaying || !trace) return;
    const timer = window.setTimeout(() => {
      setPlaybackStep((step) => {
        const next = Math.min(step + 1, trace.stages.length - 1);
        if (next >= trace.stages.length - 1) setIsPlaying(false);
        return next;
      });
    }, 850);
    return () => window.clearTimeout(timer);
  }, [isPlaying, playbackStep, trace]);

  function runSimulation() {
    setError(null);
    setNotice(null);
    try {
      if (mode === 'absence') {
        if (!resolvedEmployeeId || !resolvedAbsenceDate) {
          setError('Select an employee and a date before running the simulation.');
          return;
        }
        const employee = data.employees.find((row) => row.id === resolvedEmployeeId);
        if (!employee) {
          setError('The selected employee does not exist in the current roster data.');
          return;
        }
        if (isHardUnavailable(employee, resolvedAbsenceDate)) {
          setError(`${employee.name} is already unavailable on ${formatDate(resolvedAbsenceDate)}. Choose another date or employee.`);
          return;
        }
        const scenario = buildAbsenceScenario(data, result, resolvedEmployeeId, resolvedAbsenceDate);
        if (scenario.impacted.length === 0) {
          setContext(null);
          setStarted(false);
          setIsPlaying(false);
          setBoardMode('original');
          setActiveTab('roster');
          setNotice(
            `Marking ${employee.name} unavailable on ${formatDate(resolvedAbsenceDate)} created no new coverage shortage. ` +
              'Existing backup cover absorbed the absence, so there is nothing for the recovery engine to repair in this scenario.',
          );
          return;
        }
        const target = scenario.impacted[0];
        setContext({
          data: scenario.data,
          result: scenario.result,
          target,
          impacted: scenario.impacted,
          excludeEmployeeId: resolvedEmployeeId,
          mode,
          scenarioLabel: `${employee.name} unavailable on ${formatDate(resolvedAbsenceDate)}`,
        });
      } else {
        const conflict = existingShortages.find((row) => row.id === resolvedExistingKey);
        if (!conflict || !conflict.brandId || !conflict.processId) {
          setError('No existing coverage shortage is available on this roster.');
          return;
        }
        const target = targetShortage(data, result, result, conflict.date, conflict.brandId, conflict.processId);
        const impacted = existingShortages
          .filter((row) => row.date === conflict.date && row.brandId && row.processId)
          .map((row) => targetShortage(data, result, result, row.date, row.brandId!, row.processId!))
          .sort(compareShortages);
        setContext({
          data,
          result,
          target,
          impacted,
          excludeEmployeeId: conflict.employeeId,
          mode,
          scenarioLabel: `Existing shortage on ${formatDate(conflict.date)}`,
        });
      }
      setSelectedEmployeeId(null);
      setStarted(true);
      setPlaybackStep(0);
      setIsPlaying(true);
      setActiveTab('execution');
      setBoardMode('original');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The simulation could not be completed.');
      setContext(null);
      setStarted(false);
      setIsPlaying(false);
    }
  }

  function clearScenario() {
    setContext(null);
    setSelectedEmployeeId(null);
    setStarted(false);
    setIsPlaying(false);
    setPlaybackStep(0);
    setBoardMode('original');
    setError(null);
    setNotice(null);
    setActiveTab('roster');
  }

  function selectTarget(shortage: RecoveryShortageRef) {
    if (!context) return;
    if (context.mode === 'existing') {
      const matchingConflict = existingShortages.find(
        (conflict) =>
          conflict.date === shortage.date &&
          conflict.brandId === shortage.brandId &&
          conflict.processId === shortage.processId,
      );
      if (matchingConflict) setExistingKey(matchingConflict.id);
    }
    setContext({ ...context, target: shortage });
    setSelectedEmployeeId(null);
    setStarted(true);
    setPlaybackStep(0);
    setIsPlaying(true);
    setActiveTab('execution');
    setBoardMode('original');
  }

  function selectProposal(employeeIdToSelect: string) {
    setSelectedEmployeeId(employeeIdToSelect);
    if (activeTab === 'roster') setBoardMode('simulated');
  }

  function applyProposal(candidate: RecoveryCandidate): string | null {
    if (!context) return 'The scenario is no longer available. Run the simulation again.';
    const fresh = buildProposalSelection(context.data, context.result, candidate);
    if (!fresh.validation.valid || !fresh.candidate.directive) {
      return fresh.validation.reason || 'The proposal failed revalidation and was not applied.';
    }
    const absence =
      context.mode === 'absence' && context.excludeEmployeeId
        ? { employeeId: context.excludeEmployeeId, date: context.target.date }
        : undefined;
    props.onApplyRepair(fresh.candidate.directive, absence);
    setContext(null);
    setSelectedEmployeeId(null);
    setStarted(false);
    setIsPlaying(false);
    setPlaybackStep(0);
    setBoardMode('original');
    setError(null);
    setActiveTab('roster');
    setNotice(
      `Committed ${candidate.name}’s ${recoveryTypeLabel(candidate.recoveryType)} on ${formatDate(context.target.date)}` +
        `${absence ? ' together with the scenario leave' : ''}. Permanent allocations were not edited.`,
    );
    return null;
  }

  function play() {
    if (!started) {
      runSimulation();
      return;
    }
    if (!trace) return;
    if (playbackStep >= trace.stages.length - 1) setPlaybackStep(0);
    setIsPlaying(true);
  }

  function pause() {
    setIsPlaying(false);
  }

  function previous() {
    setIsPlaying(false);
    setPlaybackStep((step) => Math.max(0, step - 1));
  }

  function next() {
    if (!trace) return;
    setIsPlaying(false);
    setPlaybackStep((step) => Math.min(trace.stages.length - 1, step + 1));
  }

  function resetPlayback() {
    setIsPlaying(false);
    setPlaybackStep(0);
    setStarted(false);
    setBoardMode('original');
  }

  const scenarioEmployee = data.employees.find((employee) => employee.id === resolvedEmployeeId);
  const absenceAssignment = scenarioEmployee
    ? currentAssignment(data, result, scenarioEmployee.id, resolvedAbsenceDate)
    : '';


  return (
    <div className="recovery-lab">
      <section className="recovery-hero">
        <div className="recovery-hero-copy">
          <div className="recovery-section-kicker">Constraint-aware recovery engine</div>
          <h1 className="recovery-hero-title">Recovery Lab</h1>
          <p className="recovery-hero-text">
            Create a real staffing disruption, run the engine, and inspect every decision it makes.
            Everything below comes from the live roster and the existing recovery implementation — nothing is mocked.
          </p>
        </div>
        <div className="recovery-hero-facts">
          <div><span>Roster month</span><strong>{result.days[0]?.slice(0, 7)}</strong></div>
          <div><span>Active errors</span><strong>{result.conflicts.filter((conflict) => conflict.severity === 'error').length}</strong></div>
          <div><span>Engine</span><strong>Lexicographic</strong></div>
        </div>
      </section>

      <section className="recovery-scenario-panel">
        <div className="recovery-scenario-head">
          <div>
            <div className="recovery-section-kicker">Scenario</div>
            <h2 className="recovery-panel-title">Choose a disruption</h2>
          </div>
          <div className="recovery-segmented" role="group" aria-label="Scenario type">
            <button type="button" className={`recovery-segmented-btn ${mode === 'absence' ? 'active' : ''}`} onClick={() => setMode('absence')}>
              Mark employee unavailable
            </button>
            <button type="button" className={`recovery-segmented-btn ${mode === 'existing' ? 'active' : ''}`} onClick={() => setMode('existing')}>
              Existing shortage
            </button>
          </div>
        </div>

        {mode === 'absence' ? (
          <div className="recovery-scenario-form">
            <label className="recovery-field">
              <span>Employee</span>
              <select className="styled-select" value={resolvedEmployeeId} onChange={(event) => setEmployeeId(event.target.value)}>
                {data.employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.id.toUpperCase()} — {employee.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="recovery-field">
              <span>Date</span>
              <select className="styled-select" value={resolvedAbsenceDate} onChange={(event) => setAbsenceDate(event.target.value)}>
                {result.days.map((date) => (
                  <option key={date} value={date}>{formatDate(date)}</option>
                ))}
              </select>
            </label>
            <div className="recovery-scenario-preview">
              <span className="recovery-detail-label">Current assignment</span>
              <span>{absenceAssignment}</span>
            </div>
            <button type="button" className="btn btn-primary" onClick={runSimulation}>Run Simulation</button>
          </div>
        ) : (
          <div className="recovery-scenario-form">
            <label className="recovery-field recovery-field-wide">
              <span>Existing shortage</span>
              <select
                className="styled-select"
                value={resolvedExistingKey}
                onChange={(event) => setExistingKey(event.target.value)}
                disabled={existingShortages.length === 0}
              >
                {existingShortages.length === 0 ? (
                  <option value="">No existing shortages in this roster</option>
                ) : (
                  existingShortages.map((shortage) => {
                    const brand = data.brands.find((row) => row.id === shortage.brandId);
                    return (
                      <option key={shortage.id} value={shortage.id}>
                        {formatDate(shortage.date)} · {brand?.name ?? shortage.brandId} · {processLabel(shortage.processId!)} · {shortage.type === 'COVERAGE_GAP' ? 'no cover' : 'understaffed'}
                      </option>
                    );
                  })
                )}
              </select>
            </label>
            <div className="recovery-scenario-preview">
              <span className="recovery-detail-label">Scenario</span>
              <span>Use a shortage already present in the generated roster, without adding a leave.</span>
            </div>
            <button type="button" className="btn btn-primary" onClick={runSimulation} disabled={existingShortages.length === 0}>
              Run Simulation
            </button>
          </div>
        )}

        {error && <div className="recovery-alert error">{error}</div>}
        {notice && <div className="recovery-alert notice">{notice}</div>}

        {context && (
          <div className="recovery-context-bar">
            <div className="recovery-context-main">
              <span className="recovery-context-dot" />
              <span className="recovery-context-label">{context.scenarioLabel}</span>
              <span className="recovery-context-target">
                Target: {context.target.brandName} · {processLabel(context.target.processId)} · {formatDate(context.target.date)}
              </span>
            </div>
            <div className="recovery-context-actions">
              {context.impacted.length > 1 && context.impacted.map((shortage) => (
                <button
                  key={targetKey(shortage)}
                  type="button"
                  className={`recovery-target-chip ${targetKey(shortage) === targetKey(context.target) ? 'active' : ''}`}
                  onClick={() => selectTarget(shortage)}
                >
                  {shortage.brandName} {shortage.processId}
                </button>
              ))}
              <button type="button" className="action-link" onClick={clearScenario}>Clear scenario</button>
            </div>
          </div>
        )}
      </section>

      <div className="recovery-view-tabs" role="tablist" aria-label="Recovery Lab views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'roster'}
          className={`recovery-view-tab ${activeTab === 'roster' ? 'active' : ''}`}
          onClick={() => setActiveTab('roster')}
        >
          <span className="recovery-view-tab-index">A</span>
          <span>
            <strong>Roster</strong>
            <small>Assignment board and coverage</small>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'execution'}
          className={`recovery-view-tab ${activeTab === 'execution' ? 'active' : ''}`}
          onClick={() => setActiveTab('execution')}
        >
          <span className="recovery-view-tab-index">B</span>
          <span>
            <strong>Execution</strong>
            <small>{trace ? `${trace.stages.length} real engine stages` : 'Animated decision pipeline'}</small>
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'impact'}
          className={`recovery-view-tab ${activeTab === 'impact' ? 'active' : ''}`}
          onClick={() => setActiveTab('impact')}
        >
          <span className="recovery-view-tab-index">C</span>
          <span>
            <strong>Impact</strong>
            <small>{selection ? `${selection.validation.valid ? 'Validated' : 'Validation failed'} · before / after` : 'Proposal effects'}</small>
          </span>
        </button>
      </div>

      {!context ? (
        <section className="recovery-empty-stage">
          <div className="recovery-empty-step-grid">
            <div><span>01</span><strong>Choose a scenario</strong><p>Mark an employee unavailable or pick a shortage already in the roster.</p></div>
            <div><span>02</span><strong>Run the engine</strong><p>The existing recovery engine discovers, rejects, simulates and ranks candidates.</p></div>
            <div><span>03</span><strong>Inspect the repair</strong><p>Play the actual decision timeline and compare the simulated roster to the original.</p></div>
          </div>
          <p className="muted small">
            No simulation has been run yet. The permanent roster will not change while you preview a proposal.
          </p>
        </section>
      ) : activeTab === 'roster' && trace ? (
        <section className="recovery-view-panel">
          <div className="recovery-view-head">
            <div>
              <div className="recovery-section-kicker">A · Roster view</div>
              <h2 className="recovery-panel-title">
                {boardMode === 'simulated' ? 'Simulated assignment board' : 'Current assignment board'}
              </h2>
            </div>
            <div className="recovery-view-head-meta">
              <span className={`chip ${trace.analysis.proposals.length > 0 ? 'ok' : 'bad'}`}>
                {trace.analysis.proposals.length} safe proposal{trace.analysis.proposals.length === 1 ? '' : 's'}
              </span>
              <span className="muted small">{trace.evaluations.length} candidate(s) evaluated</span>
            </div>
          </div>
          <RecoveryBoard
            data={trace.data}
            entries={boardMode === 'simulated' && selection ? selection.simulation.entries : trace.result.entries}
            coverage={boardMode === 'simulated' && selection ? selection.simulatedCoverage : trace.result.coverage.filter((slot) => slot.date === trace.target.date)}
            date={trace.target.date}
            target={trace.target}
            mode={boardMode}
            onModeChange={setBoardMode}
            canShowSimulated={Boolean(selection && selection.simulation.valid)}
            selected={activeCandidate}
          />
        </section>
      ) : activeTab === 'execution' && trace ? (
        <section className="recovery-view-panel">
          <div className="recovery-view-head">
            <div>
              <div className="recovery-section-kicker">B · Execution view</div>
              <h2 className="recovery-panel-title">The engine’s actual decision timeline</h2>
            </div>
            <div className="recovery-view-head-meta">
              <span className="muted small">
                {trace.analysis.poolSize} in pool · {trace.analysis.rejected.length} rejected · {trace.analysis.proposals.length} valid
              </span>
            </div>
          </div>
          <RecoveryExecution
            trace={trace}
            selection={selection}
            step={playbackStep}
            isPlaying={isPlaying}
            started={started}
            onPlay={play}
            onPause={pause}
            onPrev={previous}
            onNext={next}
            onReset={resetPlayback}
            onRun={runSimulation}
            selectedEmployeeId={selectedId}
            onSelectProposal={selectProposal}
          />
        </section>
      ) : activeTab === 'impact' && trace ? (
        <section className="recovery-view-panel">
          <div className="recovery-view-head">
            <div>
              <div className="recovery-section-kicker">C · Impact view</div>
              <h2 className="recovery-panel-title">Before, after and why the engine chose this repair</h2>
            </div>
            <div className="recovery-view-head-meta">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setBoardMode('simulated');
                  setActiveTab('roster');
                }}
              >
                View simulated roster
              </button>
            </div>
          </div>
          <RecoveryImpact
            trace={trace}
            selection={selection}
            selectedEmployeeId={selectedId}
            onSelectProposal={selectProposal}
            onApply={applyProposal}
            applyNote={
              context?.mode === 'absence'
                ? 'Confirming will commit the scenario leave and the date-specific recovery instruction to the committed roster. Permanent allocations are still not edited.'
                : 'Confirming will commit only the date-specific recovery instruction to the committed roster. Permanent allocations are still not edited.'
            }
          />
        </section>
      ) : (
        <section className="recovery-empty-stage">
          <p className="muted">This view is waiting for a completed simulation.</p>
          <button type="button" className="btn btn-primary" onClick={runSimulation}>Run Simulation</button>
        </section>
      )}
    </div>
  );
}
