'use client';

import { useState } from 'react';
import { api, ApiError } from './api';
import { Sheet } from './Sheet';

// Close a report with an outcome (SRS DISP-6, TRUST-2). Used by station staff
// on the dashboard and by officers in the app. Unfounded/malicious starts the
// false-alarm process, so it needs evidence and shows the yellow warning.

const OUTCOMES_VALID = [
  ['arrest', 'Arrest made'],
  ['suspect_fled', 'Suspect fled'],
  ['victim_assisted', 'Victim assisted'],
  ['fire_extinguished', 'Fire put out'],
  ['patient_transported', 'Patient taken to hospital'],
  ['resolved_on_scene', 'Resolved on scene'],
] as const;

export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

/** States doc: after a failed submit, focus moves to the first field in error. */
export function focusFirstError() {
  requestAnimationFrame(() => document.querySelector<HTMLElement>('.sheet [aria-invalid="true"], .sheet [data-invalid="true"] button')?.focus());
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? (
    <div className="banner critical" role="alert" style={{ margin: 0 }}>
      {error}
    </div>
  ) : null;
}

export function CloseReportSheet({ incidentId, state, onClose, onDone }: { incidentId: string; state: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [verdict, setVerdict] = useState<'valid' | 'unfounded' | 'malicious'>('valid');
  const [outcome, setOutcome] = useState('');
  const [evidence, setEvidence] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();
  const valid = verdict === 'valid';
  const invalid = { outcome: valid && !outcome, evidence: !valid && evidence.trim().length < 20 };

  return (
    <Sheet
      open
      title="Close report"
      description="Closing needs an outcome. The reporter is asked to rate the response."
      onClose={onClose}
      busy={s.busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
            Keep open
          </button>
          <button
            className={`btn ${valid ? 'signal' : 'danger'}`}
            type="button"
            disabled={s.busy}
            onClick={() => {
              setTried(true);
              if (invalid.outcome || invalid.evidence) return focusFirstError();
              void s.run(async () => {
                if (state !== 'closing') await api(`/incidents/${incidentId}/actions`, { method: 'POST', body: JSON.stringify({ event: 'begin_close' }) });
                await api(`/incidents/${incidentId}/actions`, {
                  method: 'POST',
                  body: JSON.stringify(
                    valid ? { event: 'close_valid', outcomeCode: outcome } : { event: 'close_unfounded', outcomeCode: verdict, reason: evidence.trim() },
                  ),
                });
                onDone(valid ? 'Report closed.' : 'Report closed as unfounded.');
              });
            }}
          >
            {s.busy ? 'Closing…' : valid ? 'Close as resolved' : verdict === 'malicious' ? 'Mark malicious' : 'Mark unfounded'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <div className="segmented" role="group" aria-label="Was this a real emergency?">
        {(
          [
            ['valid', 'Real emergency'],
            ['unfounded', 'Unfounded'],
            ['malicious', 'Malicious'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" aria-pressed={verdict === k} onClick={() => setVerdict(k)}>
            {l}
          </button>
        ))}
      </div>
      {valid ? (
        <label className="field" data-invalid={tried && invalid.outcome}>
          <span>Outcome</span>
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-invalid={tried && invalid.outcome}>
            <option value="">Choose an outcome</option>
            {OUTCOMES_VALID.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          {tried && invalid.outcome && <span className="field-error">Choose an outcome before closing.</span>}
        </label>
      ) : (
        <>
          {/* Yellow box only when the action costs trust or money (States doc). */}
          <div className="banner warning" style={{ margin: 0 }}>
            <strong>This starts the false-alarm process</strong>
            The reporter's trust score drops and a warning or fine may follow. They can appeal. People who joined a confirmed incident are never fined.
          </div>
          <label className="field" data-invalid={tried && invalid.evidence}>
            <span>What you found</span>
            <textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={500} aria-invalid={tried && invalid.evidence} placeholder="Describe what officers found at the place" />
            {tried && invalid.evidence && <span className="field-error">Add what you found, at least 20 characters.</span>}
          </label>
        </>
      )}
    </Sheet>
  );
}
