'use client';
// Board "Admin audit log": who did what, and when. Entries cannot be edited or deleted.
import { api, ApiError, downloadFile } from '@erp/web-ui/api';
import Link from 'next/link';
import { useEffect, useState } from 'react';

interface Entry {
  id: number;
  at: string;
  person: string;
  role: string;
  action: string;
  postcode: string | null;
  result: 'Allowed' | 'Refused';
}
interface Log {
  stats: { today: number; liveViews: number; refundsWaivers: number; refused: number };
  people: { id: string; name: string }[];
  actions: { code: string; label: string }[];
  entries: Entry[];
}
const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

export default function AuditLog() {
  const [days, setDays] = useState('7');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [postcode, setPostcode] = useState('');
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = [`days=${days}`, actor && `actor=${actor}`, action && `action=${action}`, postcode.trim() && `postcode=${encodeURIComponent(postcode.trim())}`].filter(Boolean).join('&');
  useEffect(() => {
    const t = setTimeout(() => {
      api<Log>(`/admin/audit?${q}`)
        .then((x) => {
          setLog(x);
          setError(null);
        })
        .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the audit log.'));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="lede">Who did what, and when. Entries cannot be edited or deleted.</p>
        </div>
        <button className="btn" type="button" onClick={() => downloadFile(`/admin/audit.csv?${q}`, 'audit-log.csv').catch((e) => setError(e.message))}>
          Export
        </button>
      </div>
      <section className="card">
        <div className="loc-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <label className="field" style={{ margin: 0 }}>
            <span>Date range</span>
            <select value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="1">Today</option>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
            </select>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>Person</span>
            <select value={actor} onChange={(e) => setActor(e.target.value)}>
              <option value="">Anyone</option>
              {log?.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>Action</span>
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">All actions</option>
              {log?.actions.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ margin: 0 }}>
            <span>Postcode</span>
            <input type="text" value={postcode} onChange={(e) => setPostcode(e.target.value.toUpperCase())} placeholder="AB12C" />
          </label>
        </div>
      </section>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Entries today</span>
          <strong>{log?.stats.today ?? '—'}</strong>
          <small>All actions</small>
        </div>
        <div className="stat">
          <span>Live views of device cameras</span>
          <strong className="info">{log?.stats.liveViews ?? '—'}</strong>
          <small>Each needs a reason</small>
        </div>
        <div className="stat">
          <span>Refunds and waivers</span>
          <strong className="warning">{log?.stats.refundsWaivers ?? '—'}</strong>
          <small>By staff, last 7 days</small>
        </div>
        <div className="stat">
          <span>Refused attempts</span>
          <strong className="critical">{log?.stats.refused ?? '—'}</strong>
          <small>No permission, last 7 days</small>
        </div>
      </div>
      <section className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {!log && !error ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" />
          </div>
        ) : !log?.entries.length ? (
          <div className="empty">No entries match.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Person</th>
                <th>Role</th>
                <th>Action</th>
                <th>Postcode</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {log.entries.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link href={`/admin/audit/${e.id}`}>
                      <strong>{hm(e.at)}</strong>
                    </Link>
                    <div className="muted">{day(e.at)}</div>
                  </td>
                  <td>{e.person}</td>
                  <td>{e.role}</td>
                  <td>{e.action}</td>
                  <td>{e.postcode ?? '–'}</td>
                  <td>
                    <strong style={{ color: e.result === 'Allowed' ? 'var(--color-success-text)' : 'var(--color-emergency-text)' }}>{e.result}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
