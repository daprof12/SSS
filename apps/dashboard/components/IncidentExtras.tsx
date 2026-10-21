'use client';
// Station incident detail extras: the false-alarm review (B8 step 1) and the statement (B7).
import { api, ApiError } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

interface Review {
  incidentId: string;
  officer: string;
  officerNote: string | null;
  dueAt: string;
}

/** Confirm or overturn an officer's false-alarm closure. Silence for 48 hours confirms it. */
export function FalseAlarmReview({ incidentId, onDone }: { incidentId: string; onDone: (m: string) => void }) {
  const [r, setR] = useState<Review | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Review[]>('/me/station/false-alarms')
      .then((xs) => setR(xs.find((x) => x.incidentId === incidentId) ?? null))
      .catch(() => setR(null));
  }, [incidentId]);
  useEffect(load, [load]);
  if (!r) return null;
  const hours = Math.max(0, Math.round((+new Date(r.dueAt) - Date.now()) / 3_600_000));
  const decide = async (decision: 'confirm' | 'overturn') => {
    setBusy(true);
    setErr(null);
    try {
      const x = await api<{ message: string }>(`/me/station/false-alarms/${incidentId}/review`, { method: 'POST', body: JSON.stringify({ decision, note: note.trim() || undefined }) });
      onDone(x.message);
      setR(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="fa" style={{ borderLeft: '4px solid var(--color-warning)' }}>
      <h2 id="fa">Confirm the false alarm</h2>
      <p style={{ margin: '0 0 8px' }}>
        {r.officer} closed this as a false alarm{r.officerNote ? `: “${r.officerNote}”` : '.'} Nothing reaches the reporter until you decide. In {hours} {hours === 1 ? 'hour' : 'hours'} it goes ahead on its own.
      </p>
      <label className="field" data-invalid={!!err}>
        <span>Note (needed to overturn)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="For example, a neighbour confirmed a break-in." />
      </label>
      {err && (
        <span className="field-error" role="alert">
          {err}
        </span>
      )}
      <div className="btn-row" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn" type="button" disabled={busy} onClick={() => decide('overturn')}>
          Overturn
        </button>
        <button className="btn primary" type="button" disabled={busy} onClick={() => decide('confirm')}>
          Confirm false alarm
        </button>
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        Confirming gives the reporter a warning the first time, then a fine they can appeal. People who joined a confirmed incident are never fined.
      </p>
    </section>
  );
}

interface St {
  id: string;
  number: string;
  state: string;
  stateLabel: string;
  versions: number;
  signedAt: string | null;
}

/** Ask the reporter for a statement, and open it once signed. */
export function StatementCard({ incidentId, state, onDone }: { incidentId: string; state: string; onDone: (m: string) => void }) {
  const [list, setList] = useState<St[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<St[]>(`/incidents/${incidentId}/statements`)
      .then(setList)
      .catch(() => setList([]));
  }, [incidentId]);
  useEffect(load, [load, state]);
  const canAsk = ['on_scene', 'closing', 'resolved'].includes(state) && list?.length === 0;
  if (!list) return null;
  return (
    <section className="card" aria-labelledby="stmt">
      <h2 id="stmt">Statement</h2>
      {!list.length && !canAsk && <p className="muted">You can ask the reporter for a statement once a unit is on scene.</p>}
      {list.map((s) => (
        <div className="row" key={s.id}>
          <div className="label">
            <strong>
              <Link href={`/statements/${s.id}`}>{s.number}</Link>
            </strong>
            <span>{s.versions ? `Signed, version ${s.versions}` : s.stateLabel === 'Waiting for you' ? 'Waiting for the reporter' : s.stateLabel}</span>
          </div>
          <span className={`chip ${s.versions ? 'success' : 'warning'}`}>{s.versions ? 'Signed' : 'Waiting'}</span>
        </div>
      ))}
      {canAsk && (
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              onDone((await api<{ message: string }>(`/incidents/${incidentId}/statements`, { method: 'POST', body: JSON.stringify({}) })).message);
              load();
            } catch (e) {
              onDone(e instanceof ApiError ? e.message : 'Could not ask. Try again.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Asking…' : 'Ask the reporter for a statement'}
        </button>
      )}
    </section>
  );
}

interface FreeOfficer {
  id: string;
  name: string;
  badgeNo: string;
  available: boolean;
  currentTask: string | null;
  distanceM: number | null;
}

/** "Reinforce": send a second officer from the station; they are told at once. */
export function ReinforceSheet({ incidentId, onClose, onDone }: { incidentId: string; onClose: () => void; onDone: (m: string) => void }) {
  const [list, setList] = useState<FreeOfficer[] | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<FreeOfficer[]>(`/me/station/officers?near=${incidentId}`)
      .then((xs) => {
        setList(xs);
        setPick(xs.find((x) => x.available)?.id ?? '');
      })
      .catch(() => setList([]));
  }, [incidentId]);
  return (
    <Sheet
      open
      title="Send reinforcement"
      description="A second officer joins the unit already on this report."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={busy || !pick}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                onDone((await api<{ message: string }>(`/incidents/${incidentId}/reinforce`, { method: 'POST', body: JSON.stringify({ officerId: pick }) })).message);
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : 'Could not send. Try again.');
                setBusy(false);
              }
            }}
          >
            Send officer
          </button>
        </>
      }
    >
      {err && (
        <div className="banner critical" role="alert" style={{ margin: 0 }}>
          {err}
        </div>
      )}
      {!list && <div className="skeleton" />}
      {list?.length === 0 && <p className="muted">No officers at your station.</p>}
      <div style={{ display: 'grid', gap: 8 }}>
        {list?.map((o) => (
          <button key={o.id} type="button" className="choice-card" aria-pressed={pick === o.id} disabled={!o.available} onClick={() => setPick(o.id)} style={{ opacity: o.available ? 1 : 0.5 }}>
            <strong>{o.name}</strong> <span className="muted">{o.badgeNo}</span>
            <div className="muted" style={{ fontSize: 13 }}>
              {o.available ? (o.distanceM != null ? `${(o.distanceM / 1000).toFixed(1)} km away, free` : 'Free') : o.currentTask ? `On ${o.currentTask}` : 'Off duty'}
            </div>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

interface Dup {
  id: string;
  label: string;
  distanceM: number;
  reports: number;
  at: string;
  why: string;
}

/** "Possible duplicates": close by or a related type, but not certain enough to merge on its own. */
export function Duplicates({ incidentId, version, onDone }: { incidentId: string; version: string; onDone: (m: string) => void }) {
  const [list, setList] = useState<Dup[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Dup[]>(`/incidents/${incidentId}/duplicates`)
      .then(setList)
      .catch(() => setList([]));
  }, [incidentId]);
  useEffect(load, [load, version]);
  if (!list?.length) return null;
  const act = async (otherId: string, path: 'merge' | 'keep-separate') => {
    setBusy(otherId);
    try {
      onDone((await api<{ message: string }>(`/incidents/${incidentId}/${path}`, { method: 'POST', body: JSON.stringify({ otherId }) })).message);
      load();
    } catch (e) {
      onDone(e instanceof ApiError ? e.message : 'Could not do that.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card" aria-labelledby="dups">
      <h2 id="dups">Possible duplicates</h2>
      {list.map((d) => (
        <div key={d.id} className="card" style={{ margin: '0 0 8px' }}>
          <strong>
            <Link href={`/incidents/${d.id}`}>{d.label}</Link>, {d.distanceM} m away
          </strong>
          <p className="muted" style={{ margin: '4px 0 8px' }}>
            Reported {new Date(d.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. {d.why}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn signal" type="button" disabled={busy === d.id} onClick={() => act(d.id, 'merge')}>
              Merge
            </button>
            <button className="btn" type="button" disabled={busy === d.id} onClick={() => act(d.id, 'keep-separate')}>
              Keep separate
            </button>
          </div>
        </div>
      ))}
      <p className="muted" style={{ marginBottom: 0 }}>
        Suggested when a report is close by or a related type, but not certain enough to merge on its own. Merging sends one response; its reporters are told.
      </p>
    </section>
  );
}
