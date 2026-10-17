'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Sheet } from './Sheet';

type Kind = 'assign' | 'transfer' | 'reassign' | 'close';

interface Officer {
  id: string;
  name: string;
  badgeNo: string;
  onDuty: boolean;
  badgeVerified: boolean;
  currentTask: string | null;
  distanceM: number | null;
  available: boolean;
}
interface Station {
  id: string;
  name: string;
  agency: string;
}

const TRANSFER_REASONS = ['Needs another service', 'Outside our area', 'Needs a specialist unit', 'Other'];
const REASSIGN_REASONS = ['Officer cannot reach', 'Officer needed elsewhere', 'Wrong unit for this report', 'Other'];
const OUTCOMES_VALID = [
  ['arrest', 'Arrest made'],
  ['suspect_fled', 'Suspect fled'],
  ['victim_assisted', 'Victim assisted'],
  ['fire_extinguished', 'Fire put out'],
  ['patient_transported', 'Patient taken to hospital'],
  ['resolved_on_scene', 'Resolved on scene'],
] as const;

const distance = (m: number | null) => (m == null ? '' : m < 1000 ? `${m} m away` : `${(m / 1000).toFixed(1)} km away`);

/** Station action sheets — Assign unit, Transfer, Reassign, Close report (Gap Analysis S-1). */
export function StationActions({ incidentId, state, actions, onDone }: { incidentId: string; state: string; actions: string[]; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState<Kind | null>(null);
  const can = {
    assign: actions.includes('assign'),
    reassign: actions.includes('officer_drop'),
    transfer: actions.includes('transfer'),
    close: actions.includes('begin_close') || actions.includes('close_valid'),
  };
  const close = useCallback(() => setOpen(null), []);
  const done = (msg: string) => {
    setOpen(null);
    onDone(msg);
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {can.assign && (
          <button className="btn signal" type="button" onClick={() => setOpen('assign')}>
            Assign unit
          </button>
        )}
        {can.reassign && (
          <button className="btn" type="button" onClick={() => setOpen('reassign')}>
            Reassign
          </button>
        )}
        {can.transfer && (
          <button className="btn" type="button" onClick={() => setOpen('transfer')}>
            Transfer
          </button>
        )}
        {can.close && (
          <button className="btn" type="button" onClick={() => setOpen('close')}>
            Close report
          </button>
        )}
        {!can.assign && !can.reassign && !can.transfer && !can.close && (
          <span style={{ color: 'var(--color-text-secondary)', fontSize: 14 }}>No station actions at this stage.</span>
        )}
      </div>
      {open === 'assign' && <AssignSheet incidentId={incidentId} onClose={close} onDone={done} />}
      {open === 'transfer' && <TransferSheet incidentId={incidentId} onClose={close} onDone={done} />}
      {open === 'reassign' && <ReassignSheet incidentId={incidentId} onClose={close} onDone={done} />}
      {open === 'close' && <CloseSheet incidentId={incidentId} state={state} onClose={close} onDone={done} />}
    </>
  );
}

interface SheetProps {
  incidentId: string;
  onClose: () => void;
  onDone: (msg: string) => void;
}

function useSubmit() {
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
function focusFirstError() {
  requestAnimationFrame(() => document.querySelector<HTMLElement>('.sheet [aria-invalid="true"], .sheet [data-invalid="true"] button')?.focus());
}

function ErrorBox({ error }: { error: string | null }) {
  return error ? (
    <div className="banner critical" role="alert" style={{ margin: 0 }}>
      {error}
    </div>
  ) : null;
}

function AssignSheet({ incidentId, onClose, onDone }: SheetProps) {
  const [officers, setOfficers] = useState<Officer[] | null>(null);
  const [pick, setPick] = useState<string>('');
  const s = useSubmit();

  useEffect(() => {
    api<Officer[]>(`/me/station/officers?near=${incidentId}`)
      .then((o) => {
        setOfficers(o);
        setPick(o.find((x) => x.available)?.id ?? '');
      })
      .catch((e: ApiError) => s.setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

  const chosen = officers?.find((o) => o.id === pick);
  return (
    <Sheet
      open
      title="Assign unit"
      description="The officer gets the offer and has to accept it in time."
      onClose={onClose}
      busy={s.busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
            Cancel
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={!chosen || s.busy}
            onClick={() =>
              s.run(async () => {
                await api(`/incidents/${incidentId}/assign`, { method: 'POST', body: JSON.stringify({ officerId: pick }) });
                onDone(`Offered to ${chosen!.name}.`);
              })
            }
          >
            {s.busy ? 'Sending offer…' : chosen ? `Offer to ${chosen.name}` : 'Choose an officer'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      {officers === null && !s.error && [0, 1].map((i) => <div key={i} className="skeleton" />)}
      {officers?.length === 0 && <p className="sheet-desc">No officers yet. Invite officers to start receiving reports.</p>}
      <div role="radiogroup" aria-label="Officers" style={{ display: 'grid', gap: 8 }}>
        {officers?.map((o) => {
          const why = !o.onDuty ? 'Off duty' : !o.badgeVerified ? 'Badge not verified' : o.currentTask ? `On ${o.currentTask}` : distance(o.distanceM) || 'Available';
          return (
            <label key={o.id} className="choice">
              <input type="radio" name="officer" value={o.id} checked={pick === o.id} disabled={!o.available} onChange={() => setPick(o.id)} />
              <span className="meta">
                <strong>{o.name}</strong>
                <span>
                  Badge {o.badgeNo} · {why}
                </span>
              </span>
              {o.available ? <span className="chip success">Free</span> : <span className="chip neutral">Busy</span>}
            </label>
          );
        })}
      </div>
    </Sheet>
  );
}

function ReasonChips({ options, value, onChange, label }: { options: string[]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={value === o} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  );
}

function TransferSheet({ incidentId, onClose, onDone }: SheetProps) {
  const [stations, setStations] = useState<Station[] | null>(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();

  useEffect(() => {
    api<Station[]>('/me/station/transfer-targets')
      .then(setStations)
      .catch((e: ApiError) => s.setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const station = stations?.find((x) => x.id === target);
  const fullReason = reason === 'Other' ? note.trim() : [reason, note.trim()].filter(Boolean).join('. ');
  const invalid = { target: !target, reason: !fullReason };

  return (
    <Sheet
      open
      title="Transfer report"
      description="The report moves to the other station. Your units on it are released."
      onClose={onClose}
      busy={s.busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
            Cancel
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={s.busy}
            onClick={() => {
              setTried(true);
              if (invalid.target || invalid.reason) return focusFirstError();
              void s.run(async () => {
                await api(`/incidents/${incidentId}/actions`, { method: 'POST', body: JSON.stringify({ event: 'transfer', targetStationId: target, reason: fullReason }) });
                onDone(`Transferred to ${station!.name}.`);
              });
            }}
          >
            {s.busy ? 'Transferring…' : station ? `Transfer to ${station.name}` : 'Transfer'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <label className="field" data-invalid={tried && invalid.target}>
        <span>Station</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)} aria-invalid={tried && invalid.target}>
          <option value="">{stations === null ? 'Loading…' : stations.length ? 'Choose a station' : 'No other stations available'}</option>
          {stations?.map((st) => (
            <option key={st.id} value={st.id}>
              {st.name} — {st.agency}
            </option>
          ))}
        </select>
        {tried && invalid.target && <span className="field-error">Choose a station.</span>}
      </label>
      <div className="field" data-invalid={tried && invalid.reason}>
        <span>Why</span>
        <ReasonChips label="Transfer reason" options={TRANSFER_REASONS} value={reason} onChange={setReason} />
        <textarea placeholder="Add a note for the next station (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={400} aria-label="Note" />
        {tried && invalid.reason && <span className="field-error">Say why you are transferring.</span>}
      </div>
    </Sheet>
  );
}

function ReassignSheet({ incidentId, onClose, onDone }: SheetProps) {
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const s = useSubmit();
  return (
    <Sheet
      open
      title="Reassign report"
      description="The current officer is taken off. The report is offered to the next free officer, and the reporter is told a new team is coming."
      onClose={onClose}
      busy={s.busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={s.busy}>
            Keep officer
          </button>
          <button
            className="btn signal"
            type="button"
            disabled={s.busy}
            onClick={() => {
              setTried(true);
              if (!reason) return focusFirstError();
              void s.run(async () => {
                await api(`/incidents/${incidentId}/actions`, { method: 'POST', body: JSON.stringify({ event: 'officer_drop', reason }) });
                onDone('Reassigning to the next free officer.');
              });
            }}
          >
            {s.busy ? 'Reassigning…' : 'Reassign report'}
          </button>
        </>
      }
    >
      <ErrorBox error={s.error} />
      <div className="field" data-invalid={tried && !reason}>
        <span>Why</span>
        <ReasonChips label="Reassign reason" options={REASSIGN_REASONS} value={reason} onChange={setReason} />
        {tried && !reason && <span className="field-error">A reason is required.</span>}
      </div>
    </Sheet>
  );
}

function CloseSheet({ incidentId, state, onClose, onDone }: SheetProps & { state: string }) {
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
