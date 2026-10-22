'use client';
// Board "Admin audit entry": one entry, read only, with where it came from, related entries and
// whether its place in the hash chain still checks out.
import { LinkButton } from '@erp/web-ui/LinkButton';
import { api, ApiError } from '@erp/web-ui/api';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Entry {
  id: number;
  at: string;
  person: string;
  role: string;
  action: string;
  reason: string | null;
  target: string;
  result: 'Allowed' | 'Refused';
  ip: string | null;
  userAgent: string | null;
  secondApproval: string;
  payload: Record<string, unknown>;
  intact: boolean;
  related: { id: number; at: string; action: string }[];
}
const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export default function AuditEntry() {
  const { id } = useParams<{ id: string }>();
  const [e, setE] = useState<Entry | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Entry>(`/admin/audit/${id}`)
      .then(setE)
      .catch((x) => setError(x instanceof ApiError ? x.message : 'Could not load the entry.'));
  }, [id]);
  const exportEntry = () => {
    if (!e) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(e, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-entry-${e.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const Row = ({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) => (
    <div className="row">
      <span className="muted">{k}</span>
      <strong style={{ color: tone, textAlign: 'right' }}>{v}</strong>
    </div>
  );
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit entry {id}</h1>
          <p className="lede">{e ? `${new Date(e.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}, read only` : ' '}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <LinkButton className="btn" href="/admin/audit">
            Back to log
          </LinkButton>
          <button className="btn" type="button" disabled={!e} onClick={exportEntry}>
            Export entry
          </button>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      {!e && !error && <div className="skeleton" style={{ height: 300 }} />}
      {e && (
        <>
          <div className="grid two">
            <section className="card" aria-labelledby="wh">
              <h2 id="wh" style={{ marginTop: 0 }}>
                What happened
              </h2>
              <Row k="Action" v={e.action.split('. Reason:')[0]} />
              <Row k="By" v={`${e.person}, ${e.role.toLowerCase()}`} />
              <Row k="Reason given" v={e.reason ?? '—'} />
              <Row k="Target" v={e.target || '—'} />
              <Row k="Result" v={e.result} tone={e.result === 'Allowed' ? 'var(--color-success-text)' : 'var(--color-emergency-text)'} />
            </section>
            <section className="card" aria-labelledby="wf">
              <h2 id="wf" style={{ marginTop: 0 }}>
                Where from
              </h2>
              <Row k="IP address" v={e.ip ?? 'Not recorded'} />
              <Row k="Device" v={e.userAgent ?? 'Not recorded'} />
              <Row k="Second approval" v={e.secondApproval} />
            </section>
          </div>
          <div className="grid two">
            <section className="card" aria-labelledby="rel">
              <h2 id="rel" style={{ marginTop: 0 }}>
                Related entries
              </h2>
              {!e.related.length ? (
                <p className="muted">No other entries for the same thing that day.</p>
              ) : (
                e.related.map((r) => (
                  <Link key={r.id} href={`/admin/audit/${r.id}`} className="row" style={{ color: 'inherit', textDecoration: 'none' }}>
                    <span className="muted">{hm(r.at)}</span>
                    <strong>{r.action}</strong>
                  </Link>
                ))
              )}
            </section>
            <section className="card" aria-labelledby="int">
              <h2 id="int" style={{ marginTop: 0 }}>
                Integrity
              </h2>
              <div className={`banner ${e.intact ? 'info' : 'critical'}`} style={{ margin: 0 }}>
                <strong style={{ display: 'block' }}>{e.intact ? 'Entries cannot be edited or deleted' : 'This entry does not match the chain'}</strong>
                {e.intact
                  ? 'Each entry is chained to the one before it. Any change would break the chain and raise an alert.'
                  : 'Its content or the entry before it has changed since it was written. Tell the security lead now.'}
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}
