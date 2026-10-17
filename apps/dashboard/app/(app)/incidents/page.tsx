'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@erp/web-ui/api';
import { StateChip } from '@erp/web-ui/StateChip';

interface QueueRow {
  id: string;
  type: string;
  state: string;
  reportCount: number;
  postcode: string | null;
  area: string | null;
  officer: string | null;
  offerExpiresAt: string | null;
  trustBand: string;
  severity: number;
  createdAt: string;
}

const age = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

/** Station live incidents (Wireframe 5): priority queue, report count, who holds it now. */
export default function Incidents() {
  const router = useRouter();
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [now, setNow] = useState(Date.now());
  const seen = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const data = await api<QueueRow[]>('/me/queue');
        if (stop) return;
        const first = seen.current.size === 0 && rows === null;
        const added = new Set(data.filter((r) => !seen.current.has(r.id)).map((r) => r.id));
        data.forEach((r) => seen.current.add(r.id));
        setFresh(first ? new Set() : added);
        setRows(data);
        setError(null);
      } catch (e) {
        if (!stop) setError(e as ApiError);
      }
    };
    void load();
    // Foundation polls every 3 s; the station:{id} socket channel replaces this (A6).
    const poll = setInterval(load, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop = true;
      clearInterval(poll);
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <h1>Live incidents</h1>
      <p className="lede">Open reports for your station, most severe first.</p>

      {error && (
        <div className={`banner ${error.status === 0 ? 'warning' : 'critical'}`} role="alert">
          <strong>{error.status === 0 ? 'You are offline.' : 'Could not load the queue'}</strong>
          {error.status === 0 ? 'Showing the last list we had.' : error.message}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {rows === null && !error ? (
          <div style={{ padding: 20 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : rows && rows.length === 0 ? (
          <div className="empty">
            <strong>No open reports.</strong>
            New reports for your area appear here as they come in.
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th aria-label="Severity" />
                <th>Report</th>
                <th>Place</th>
                <th>State</th>
                <th>Who has it</th>
                <th>Reports</th>
                <th>Trust</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((r) => {
                const left = r.offerExpiresAt ? Math.max(0, Math.round((new Date(r.offerExpiresAt).getTime() - now) / 1000)) : null;
                return (
                  <tr key={r.id} className={`link ${fresh.has(r.id) ? 'fresh' : ''}`} onClick={() => router.push(`/incidents/${r.id}`)}>
                    <td>
                      <span className="sev" style={{ background: r.severity >= 4 ? 'var(--color-emergency)' : r.severity === 3 ? 'var(--color-warning)' : 'var(--color-signal)' }} />
                    </td>
                    <td>
                      <a href={`/incidents/${r.id}`} onClick={(e) => e.preventDefault()} style={{ color: 'inherit', fontWeight: 700, textDecoration: 'none', textTransform: 'capitalize' }}>
                        {r.type}
                      </a>
                    </td>
                    <td>
                      {r.postcode ?? 'GPS only'}
                      <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{r.area}</div>
                    </td>
                    <td>
                      <StateChip state={r.state} />
                    </td>
                    <td>
                      {r.officer ?? '—'}
                      {left !== null && r.state === 'offered' && <div style={{ color: 'var(--color-warning-text)', fontSize: 12 }}>{left}s to accept</div>}
                    </td>
                    <td>{r.reportCount > 1 ? <span className="chip info">{r.reportCount} reports</span> : '1'}</td>
                    <td>
                      <span className={`chip ${r.trustBand === 'low' ? 'warning' : r.trustBand === 'high' ? 'success' : 'neutral'}`}>{r.trustBand}</span>
                    </td>
                    <td>{age(r.createdAt, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
