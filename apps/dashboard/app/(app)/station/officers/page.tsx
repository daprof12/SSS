'use client';
// Board "Station officers": everyone at this station, what they are doing and how they are rated.
import { api, ApiError } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';
import { naira } from '@/components/Dash';

interface Officer {
  id: string;
  name: string;
  badgeNo: string;
  role: string;
  status: 'available' | 'busy' | 'off' | 'invited';
  onDuty: boolean;
  doingNow: string;
  rating: number | null;
  acceptS: number | null;
  joined: string;
  verified: boolean;
  answeredMonth: number;
  rewardsMonthKobo: number;
  lastComment: string | null;
}
interface Team {
  stats: { onDuty: number; total: number; available: number; busy: number; rating: number | null };
  officers: Officer[];
}
interface Q {
  id: string;
  type: string;
  state: string;
  postcode: string | null;
}
const STATUS: Record<Officer['status'], [string, string]> = {
  available: ['Available', 'var(--color-signal-text)'],
  busy: ['Busy', 'var(--color-warning-text)'],
  off: ['Off duty', 'var(--color-text-secondary)'],
  invited: ['Invited', 'var(--color-warning-text)'],
};
type F = 'all' | 'on' | 'available' | 'busy' | 'off';

export default function StationOfficers() {
  const [t, setT] = useState<Team | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<F>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [messaging, setMessaging] = useState(false);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<Team>('/me/station/team')
      .then((x) => {
        setT(x);
        setSel((s) => s ?? x.officers[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load officers.'));
  }, []);
  useEffect(load, [load]);
  const list = (t?.officers ?? []).filter((o) => (f === 'all' ? true : f === 'on' ? o.onDuty : f === 'available' ? o.status === 'available' : f === 'busy' ? o.status === 'busy' : !o.onDuty));
  const o = t?.officers.find((x) => x.id === sel) ?? null;
  const duty = async (on: boolean) => {
    if (!o) return;
    try {
      setToast((await api<{ message: string }>(`/me/station/officers/${o.id}/duty`, { method: 'POST', body: JSON.stringify({ on }) })).message);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not change duty.');
    }
  };
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Officers</h1>
          <p className="lede">Everyone at this station, what they are doing and how they are rated.</p>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>On duty</span>
          <strong className="success">{t?.stats.onDuty ?? '—'}</strong>
          <small>{t ? `Of ${t.stats.total} officers` : ''}</small>
        </div>
        <div className="stat">
          <span>Available</span>
          <strong className="info">{t?.stats.available ?? '—'}</strong>
          <small>Can take a report now</small>
        </div>
        <div className="stat">
          <span>On a report</span>
          <strong className="warning">{t?.stats.busy ?? '—'}</strong>
          <small>Right now</small>
        </div>
        <div className="stat">
          <span>Average rating</span>
          <strong>{t?.stats.rating ?? '—'}</strong>
          <small>From citizens</small>
        </div>
      </div>
      <div className="segmented tabs" role="tablist">
        {(
          [
            ['all', 'All'],
            ['on', 'On duty'],
            ['available', 'Available'],
            ['busy', 'Busy'],
            ['off', 'Off duty'],
          ] as [F, string][]
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={f === k} aria-pressed={f === k} onClick={() => setF(k)}>
            {l}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(300px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          {!t && !error ? (
            <div style={{ padding: 20 }}>
              <div className="skeleton" />
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Officer</th>
                  <th>Role</th>
                  <th>Doing now</th>
                  <th>Rating</th>
                  <th>Accept time</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((x) => (
                  <tr key={x.id} className="link" onClick={() => setSel(x.id)} aria-selected={sel === x.id} style={sel === x.id ? { background: 'var(--color-signal-soft)' } : undefined}>
                    <td>
                      <strong>{x.name}</strong>
                      <div className="muted">{x.badgeNo}</div>
                    </td>
                    <td>{x.role}</td>
                    <td>{x.doingNow}</td>
                    <td>{x.rating ?? (x.verified ? '—' : 'New')}</td>
                    <td>{x.acceptS != null ? `${x.acceptS}s` : '—'}</td>
                    <td>
                      <strong style={{ color: STATUS[x.status][1] }}>{STATUS[x.status][0]}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {o && (
          <section className="card" aria-labelledby="sel">
            <h2 id="sel" style={{ marginTop: 0 }}>
              Selected: {o.name}
            </h2>
            <div className="chips" style={{ marginBottom: 12 }}>
              <span className="chip neutral">{o.role}</span>
              <span className={`chip ${o.verified ? 'success' : 'warning'}`}>{o.verified ? 'Verified' : 'Badge check'}</span>
              <span className="chip neutral">Joined {new Date(o.joined).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</span>
            </div>
            <dl className="facts">
              <div>
                <dt>Reports answered this month</dt>
                <dd>{o.answeredMonth}</dd>
              </div>
              <div>
                <dt>Average time to accept</dt>
                <dd>{o.acceptS != null ? `${o.acceptS}s` : '—'}</dd>
              </div>
              <div>
                <dt>Average rating</dt>
                <dd>{o.rating ?? '—'}</dd>
              </div>
              <div>
                <dt>Rewards earned this month</dt>
                <dd>{naira(o.rewardsMonthKobo)}</dd>
              </div>
            </dl>
            {o.lastComment && (
              <div className="card" style={{ margin: '12px 0' }}>
                <span className="muted">Latest citizen comment</span>
                <p style={{ margin: '4px 0 0' }}>“{o.lastComment}”</p>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              <button className="btn signal" type="button" disabled={o.status !== 'available'} onClick={() => setAssigning(true)}>
                Assign a report
              </button>
              <button className="btn" type="button" onClick={() => setMessaging(true)}>
                Message
              </button>
              {o.verified && (
                <button className="btn" type="button" onClick={() => duty(!o.onDuty)}>
                  {o.onDuty ? 'Set off duty' : 'Set on duty'}
                </button>
              )}
            </div>
          </section>
        )}
      </div>
      {assigning && o && <AssignReport officer={o} onClose={() => setAssigning(false)} onDone={(m) => (setAssigning(false), setToast(m), load())} />}
      {messaging && o && <QuickMessage officer={o} onClose={() => setMessaging(false)} onDone={(m) => (setMessaging(false), setToast(m))} />}
    </>
  );
}

/** Reports that need a unit (escalated) or a second unit (taken): offer or send this officer. */
function AssignReport({ officer, onClose, onDone }: { officer: Officer; onClose: () => void; onDone: (m: string) => void }) {
  const [q, setQ] = useState<Q[] | null>(null);
  const [pick, setPick] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Q[]>('/me/queue')
      .then((xs) => setQ(xs.filter((x) => ['escalated', 'accepted', 'en_route', 'on_scene'].includes(x.state))))
      .catch(() => setQ([]));
  }, []);
  const chosen = q?.find((x) => x.id === pick);
  return (
    <Sheet
      open
      title={`Assign ${officer.name}`}
      description="An escalated report is offered to them; a report already taken gets them as the second unit."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!chosen || busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                if (chosen!.state === 'escalated') {
                  await api(`/incidents/${chosen!.id}/assign`, { method: 'POST', body: JSON.stringify({ officerId: officer.id }) });
                  onDone(`Offered to ${officer.name}.`);
                } else {
                  onDone((await api<{ message: string }>(`/incidents/${chosen!.id}/reinforce`, { method: 'POST', body: JSON.stringify({ officerId: officer.id }) })).message);
                }
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : 'Could not assign.');
                setBusy(false);
              }
            }}
          >
            {chosen?.state === 'escalated' ? 'Offer the report' : 'Send as second unit'}
          </button>
        </>
      }
    >
      {err && (
        <div className="banner critical" role="alert" style={{ margin: 0 }}>
          {err}
        </div>
      )}
      {!q && <div className="skeleton" />}
      {q?.length === 0 && <p className="muted">No open report needs an officer right now.</p>}
      <div style={{ display: 'grid', gap: 8 }}>
        {q?.map((x) => (
          <button key={x.id} type="button" className="choice-card" aria-pressed={pick === x.id} onClick={() => setPick(x.id)}>
            <strong style={{ textTransform: 'capitalize' }}>
              {x.type}, {x.postcode ?? 'GPS'}
            </strong>
            <div className="muted" style={{ fontSize: 13 }}>
              {x.state === 'escalated' ? 'Nobody has accepted it' : 'Taken; add a second unit'}
            </div>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

function QuickMessage({ officer, onClose, onDone }: { officer: Officer; onClose: () => void; onDone: (m: string) => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Sheet
      open
      title={`Message ${officer.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={async () => {
              try {
                onDone((await api<{ message: string }>('/me/station/messages', { method: 'POST', body: JSON.stringify({ audience: 'officer', officerId: officer.id, title: title || 'Message from the station', body }) })).message);
              } catch (e) {
                setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not send.');
              }
            }}
          >
            Send
          </button>
        </>
      }
    >
      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Message from the station" />
      </label>
      <label className="field" data-invalid={!!err}>
        <span>Message</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} aria-invalid={!!err} />
        {err && <span className="field-error">{err}</span>}
      </label>
    </Sheet>
  );
}
