'use client';
// Board "Admin agencies and stations": agencies by type, their stations and the area each covers,
// and the approval card for agencies waiting for review (Approve / Ask for more / Decline).
import { api, ApiError } from '@erp/web-ui/api';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';

interface Board {
  kinds: { code: string; label: string }[];
  stats: { live: number; waiting: number; stations: number; noArea: number };
  agencies: { id: string; name: string; kind: string; status: string; statusLabel: string; waiting: boolean; postcode: string | null; stations: number; officers: number; open: number; submittedAt: string | null }[];
  stations: { id: string; name: string; agency: string; kind: string; status: string; postcode: string | null; areas: string | null; officers: number; onDuty: number; open: number }[];
}
interface Card {
  id: string;
  name: string;
  legalName: string | null;
  kind: string;
  regNo: string | null;
  officialEmail: string | null;
  emailEvidence: string | null;
  signatoryName: string | null;
  status: string;
  statusLabel: string;
  approveConfirm: string;
  documents: { id: string; label: string; status: string; fileName: string }[];
  requiredDocuments: { kind: string; label: string; uploaded: boolean }[];
}
const STATION_STATUS: Record<string, [string, string]> = {
  active: ['Live', 'var(--color-success-text)'],
  draft: ['Setting up', 'var(--color-warning-text)'],
  invite_sent: ['Head invited', 'var(--color-warning-text)'],
  paused: ['Paused', 'var(--color-text-secondary)'],
};

export default function AgenciesAdmin() {
  const [loc, setLoc] = useState<LocFilter>({});
  const [kind, setKind] = useState('');
  const [view, setView] = useState<'agencies' | 'stations'>('agencies');
  const [b, setB] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const lq = locQuery(loc);
  const load = useCallback(() => {
    const q = [kind && `kind=${kind}`, lq].filter(Boolean).join('&');
    api<Board>(`/admin/agencies-board${q ? `?${q}` : ''}`)
      .then((x) => {
        setB(x);
        setError(null);
        setPick((p) => p ?? x.agencies.find((a) => a.waiting)?.id ?? null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load agencies.'));
  }, [kind, lq]);
  useEffect(load, [load]);
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Agencies and stations</h1>
          <p className="lede">Who responds where. Each station covers an area; reports from that area go to it first.</p>
        </div>
      </div>
      <div className="segmented tabs" role="tablist">
        <button type="button" role="tab" aria-selected={kind === ''} aria-pressed={kind === ''} onClick={() => setKind('')}>
          All types
        </button>
        {b?.kinds.map((k) => (
          <button key={k.code} type="button" role="tab" aria-selected={kind === k.code} aria-pressed={kind === k.code} onClick={() => setKind(k.code)}>
            {k.label}
          </button>
        ))}
      </div>
      <LocationFilter value={loc} onChange={setLoc} />
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Live agencies</span>
          <strong className="success">{b?.stats.live ?? '—'}</strong>
          <small>Receiving reports</small>
        </div>
        <div className="stat">
          <span>Waiting for review</span>
          <strong className="warning">{b?.stats.waiting ?? '—'}</strong>
          <small>Documents submitted</small>
        </div>
        <div className="stat">
          <span>Live stations</span>
          <strong className="info">{b?.stats.stations ?? '—'}</strong>
          <small>In this place</small>
        </div>
        <div className="stat">
          <span>Stations with no area</span>
          <strong className="critical">{b?.stats.noArea ?? '—'}</strong>
          <small>Get reports only as the nearest</small>
        </div>
      </div>
      <div className="grid two" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(300px, 1fr)' }}>
        <section className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <div className="segmented" role="group" aria-label="Show" style={{ margin: 16 }}>
            <button type="button" aria-pressed={view === 'agencies'} onClick={() => setView('agencies')}>
              Agencies {b ? b.agencies.length : ''}
            </button>
            <button type="button" aria-pressed={view === 'stations'} onClick={() => setView('stations')}>
              Stations {b ? b.stations.length : ''}
            </button>
          </div>
          {!b ? (
            <div style={{ padding: 20 }}>
              <div className="skeleton" />
            </div>
          ) : view === 'agencies' ? (
            !b.agencies.length ? (
              <div className="empty">No agencies here.</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Agency</th>
                    <th>Type</th>
                    <th>Stations</th>
                    <th>Officers</th>
                    <th>Open reports</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {b.agencies.map((a) => (
                    <tr key={a.id} aria-selected={pick === a.id} style={{ background: pick === a.id ? 'var(--color-surface-sunken)' : undefined }}>
                      <td>
                        <button type="button" className="link" onClick={() => setPick(a.id)}>
                          <strong>{a.name}</strong>
                        </button>
                        <div className="muted">{a.postcode ?? '—'}</div>
                      </td>
                      <td>{a.kind}</td>
                      <td>{a.stations}</td>
                      <td>{a.officers}</td>
                      <td>{a.open}</td>
                      <td>
                        <strong style={{ color: a.waiting ? 'var(--color-warning-text)' : a.status === 'live' ? 'var(--color-success-text)' : a.status === 'overdue' || a.status === 'rejected' ? 'var(--color-emergency-text)' : undefined }}>{a.statusLabel}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : !b.stations.length ? (
            <div className="empty">No stations here.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Station</th>
                  <th>Agency</th>
                  <th>Area it covers</th>
                  <th>On duty</th>
                  <th>Open</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {b.stations.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>
                      <div className="muted">{s.postcode ?? 'No building yet'}</div>
                    </td>
                    <td>
                      {s.agency}
                      <div className="muted">{s.kind}</div>
                    </td>
                    <td>{s.areas ?? <span style={{ color: 'var(--color-emergency-text)' }}>Not set</span>}</td>
                    <td>
                      {s.onDuty} of {s.officers}
                    </td>
                    <td>{s.open}</td>
                    <td>
                      <strong style={{ color: STATION_STATUS[s.status]?.[1] }}>{STATION_STATUS[s.status]?.[0] ?? s.status}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <ApprovalCard id={pick} onDone={(m) => (setToast(m), load())} />
      </div>
    </>
  );
}

function ApprovalCard({ id, onDone }: { id: string | null; onDone: (m: string) => void }) {
  const [c, setC] = useState<Card | null>(null);
  const [mode, setMode] = useState<'ask_more' | 'reject' | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setC(null);
    setMode(null);
    setText('');
    setErr(null);
    if (id) api<Card>(`/admin/agencies/${id}`).then(setC).catch(() => setC(null));
  }, [id]);
  if (!id) {
    return (
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Approval</h2>
        <p className="muted">Nothing is waiting for review. Choose an agency to see its details.</p>
      </section>
    );
  }
  if (!c) {
    return (
      <section className="card">
        <div className="skeleton" style={{ height: 240 }} />
      </section>
    );
  }
  const waiting = ['documents_submitted', 'in_review'].includes(c.status);
  const decide = async (decision: 'approve' | 'ask_more' | 'reject') => {
    if (decision === 'approve' && !window.confirm(c.approveConfirm)) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/admin/agencies/${c.id}/decision`, {
        method: 'POST',
        body: JSON.stringify(decision === 'approve' ? { decision } : decision === 'ask_more' ? { decision, comment: text.trim() } : { decision, reason: text.trim() }),
      });
      onDone(decision === 'approve' ? `${c.name} approved. They choose a plan next.` : decision === 'ask_more' ? 'Sent. The agency sees your comment.' : `${c.name} declined. The reason is shown to them.`);
      setMode(null);
      setText('');
    } catch (e) {
      setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not save the decision.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="ap">
      <h2 id="ap" style={{ marginTop: 0 }}>
        {c.name}
      </h2>
      <span className="chip warning">{c.statusLabel}</span>
      <dl className="facts" style={{ marginTop: 12 }}>
        <div>
          <dt>Legal name</dt>
          <dd>{c.legalName ?? '—'}</dd>
        </div>
        <div>
          <dt>Registration</dt>
          <dd>{c.regNo ?? '—'}</dd>
        </div>
        <div>
          <dt>Official email</dt>
          <dd>
            {c.officialEmail ?? '—'}
            {c.emailEvidence ? ` (${c.emailEvidence})` : ''}
          </dd>
        </div>
        <div>
          <dt>Signatory</dt>
          <dd>{c.signatoryName ?? '—'}</dd>
        </div>
      </dl>
      <h3 style={{ margin: '12px 0 4px', fontSize: 14 }}>Documents</h3>
      {c.requiredDocuments.map((d) => {
        const doc = c.documents.find((x) => x.label === d.label);
        return (
          <div className="row" key={d.kind} style={{ minHeight: 36 }}>
            <span>{d.label}</span>
            <strong style={{ color: doc?.status === 'accepted' ? 'var(--color-success-text)' : doc?.status === 'rejected' ? 'var(--color-emergency-text)' : d.uploaded ? undefined : 'var(--color-warning-text)' }}>
              {doc ? (doc.status === 'accepted' ? 'Accepted' : doc.status === 'rejected' ? 'Not accepted' : 'Uploaded') : 'Missing'}
            </strong>
          </div>
        );
      })}
      {err && (
        <div className="banner critical" role="alert" style={{ margin: '8px 0 0' }}>
          {err}
        </div>
      )}
      {waiting ? (
        <>
          {mode && (
            <label className="field" style={{ marginTop: 12 }}>
              <span>{mode === 'ask_more' ? 'What should they add or change?' : 'Reason (shown to the agency)'}</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
            </label>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {mode ? (
              <>
                <button className="btn" type="button" disabled={busy} onClick={() => setMode(null)}>
                  Back
                </button>
                <button className={`btn ${mode === 'reject' ? 'danger' : 'primary'}`} type="button" disabled={busy || text.trim().length < 3} onClick={() => decide(mode)}>
                  {mode === 'ask_more' ? 'Send request' : 'Decline'}
                </button>
              </>
            ) : (
              <>
                <button className="btn primary" type="button" disabled={busy} onClick={() => decide('approve')}>
                  Approve
                </button>
                <button className="btn" type="button" disabled={busy} onClick={() => setMode('ask_more')}>
                  Ask for more
                </button>
                <button className="btn danger" type="button" disabled={busy} onClick={() => setMode('reject')}>
                  Decline
                </button>
              </>
            )}
          </div>
        </>
      ) : (
        <p className="muted" style={{ marginBottom: 0 }}>
          Not waiting for review.
        </p>
      )}
    </section>
  );
}
