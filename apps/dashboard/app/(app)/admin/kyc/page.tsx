'use client';
// Board "Admin KYC queue": identity checks the provider could not settle, with the ID masked and
// the face-match and liveness results; approve, ask for more, or reject with a reason.
import { api, ApiError } from '@erp/web-ui/api';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';

interface K {
  id: string;
  name: string;
  role: string;
  idType: string;
  idMasked: string;
  faceMatchPct: number | null;
  liveness: boolean | null;
  status: 'manual_review' | 'failed';
  reason: string | null;
  at: string;
}

export default function KycQueue() {
  const [list, setList] = useState<K[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const [loc, setLoc] = useState<LocFilter>({});
  const lq = locQuery(loc);
  const load = useCallback(() => {
    api<K[]>(`/admin/kyc${lq ? `?${lq}` : ''}`)
      .then((x) => {
        setList(x);
        setSel((s) => s ?? x.find((k) => k.status === 'manual_review')?.id ?? null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the queue.'));
  }, [lq]);
  useEffect(load, [load]);
  const k = list?.find((x) => x.id === sel);
  const decide = async (decision: 'approve' | 'reject' | 'more') => {
    if (!k) return;
    try {
      setToast((await api<{ message: string }>(`/admin/kyc/${k.id}`, { method: 'POST', body: JSON.stringify({ decision, reason: reason.trim() || undefined }) })).message);
      setReason('');
      setSel(null);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not save.');
    }
  };
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>KYC queue</h1>
          <p className="lede">Identity checks the provider could not settle on its own. IDs stay masked.</p>
        </div>
      </div>
      <LocationFilter value={loc} onChange={setLoc} />
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(300px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          {!list?.length ? (
            <div className="empty">{list ? 'Nothing waiting. New cases appear when a check needs a person to look.' : <span className="skeleton" />}</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>ID</th>
                  <th>Face match</th>
                  <th>Liveness</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {list.map((x) => (
                  <tr key={x.id} className="link" onClick={() => setSel(x.id)} style={sel === x.id ? { background: 'var(--color-signal-soft)' } : undefined}>
                    <td>
                      <strong>{x.name}</strong>
                      <div className="muted">{x.role}</div>
                    </td>
                    <td>
                      {x.idType} {x.idMasked}
                    </td>
                    <td>{x.faceMatchPct != null ? `${x.faceMatchPct}%` : '—'}</td>
                    <td>{x.liveness == null ? '—' : x.liveness ? 'Passed' : 'Failed'}</td>
                    <td>
                      <span className={`chip ${x.status === 'manual_review' ? 'warning' : 'critical'}`}>{x.status === 'manual_review' ? 'Needs review' : 'Failed'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {k && (
          <section className="card">
            <h2 style={{ marginTop: 0 }}>{k.name}</h2>
            <dl className="facts">
              <div>
                <dt>ID</dt>
                <dd>
                  {k.idType} {k.idMasked}
                </dd>
              </div>
              <div>
                <dt>Face match</dt>
                <dd>{k.faceMatchPct != null ? `${k.faceMatchPct}%` : 'Not run'}</dd>
              </div>
              <div>
                <dt>Liveness</dt>
                <dd>{k.liveness == null ? 'Not run' : k.liveness ? 'Passed' : 'Failed'}</dd>
              </div>
              {k.reason && (
                <div>
                  <dt>Provider said</dt>
                  <dd>{k.reason.replace(/_/g, ' ')}</dd>
                </div>
              )}
            </dl>
            {k.status === 'manual_review' ? (
              <>
                <label className="field" style={{ marginTop: 12 }}>
                  <span>Reason the person reads (needed to ask for more or reject)</span>
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
                </label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn primary" type="button" onClick={() => decide('approve')}>
                    Approve
                  </button>
                  <button className="btn" type="button" onClick={() => decide('more')}>
                    Ask for more
                  </button>
                  <button className="btn" type="button" onClick={() => decide('reject')}>
                    Reject
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">This check failed. The person can try again from the app.</p>
            )}
          </section>
        )}
      </div>
    </>
  );
}
