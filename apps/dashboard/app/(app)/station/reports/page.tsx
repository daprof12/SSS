'use client';
// Board "Station reports": how this station is doing, by day, by type and by citizen rating; and the
// false alarms waiting for the head to confirm (B8 step 1).
import { LinkButton } from '@erp/web-ui/LinkButton';
import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
import { api, ApiError } from '@erp/web-ui/api';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';
import { HBars, mmss } from '@/components/Dash';
import { DateRange, useDateRange } from '@/components/DateRange';

interface Rep {
  days: number;
  stats: { reports: number; avgResponseS: number | null; resolvedPct: number | null; falseAlarmPct: number | null; rating: number | null };
  byDay: { day: string; avgResponseS: number | null; n: number }[];
  byType: { type: string; label: string; n: number }[];
  ratings: { stars: number; n: number }[];
  recent: { id: string; type: string; postcode: string | null; closedAt: string; responseS: number | null; stars: number | null; outcome: string }[];
}
interface Review {
  incidentId: string;
  label: string;
  officer: string;
  officerNote: string | null;
  dueAt: string;
}
const TYPE_COLOR: Record<string, string> = { robbery: '#ff3b5c', fire: '#ff7a45', medical: '#34d399', riot: '#a78bfa', kidnapping: '#e879f9', violence: '#f43f5e', accident: '#fbbf24' };
const OUTCOME: Record<string, string> = { Resolved: 'var(--color-success-text)', Transferred: 'var(--color-signal-text)', 'False alarm': 'var(--color-warning-text)', Overturned: 'var(--color-text-secondary)' };

export default function StationReports() {
  const dates = useDateRange('30d');
  const [r, setR] = useState<Rep | null>(null);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<Rep>(`/me/station/reports${dates.q ? `?${dates.q}` : ''}`)
      .then(setR)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load reports.'));
    api<Review[]>('/me/station/false-alarms').then(setReviews).catch(() => setReviews([]));
  }, [dates.q]);
  useEffect(load, [load]);
  const exportCsv = () => {
    if (!r) return;
    const lines = [['Closed', 'Type', 'Postcode', 'Response', 'Rating', 'Outcome'], ...r.recent.map((x) => [new Date(x.closedAt).toISOString(), x.type, x.postcode ?? '', mmss(x.responseS), x.stars ?? '', x.outcome])];
    const url = URL.createObjectURL(new Blob([lines.map((l) => l.join(',')).join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `station-reports-${dates.range.from ?? 'start'}-to-${dates.range.to ?? 'today'}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const confirm = async (id: string) => {
    try {
      setToast((await api<{ message: string }>(`/me/station/false-alarms/${id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'confirm' }) })).message);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not save.');
    }
  };
  const s = r?.stats;
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="lede">How this station is doing, by day, by type and by citizen rating.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" type="button" onClick={exportCsv} disabled={!r}>
            Export
          </button>
        </div>
      </div>
      <div className="card">
        <DateRange value={dates.range} onChange={dates.setRange} initial={dates.initial} allowAll={false} />
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      {!!reviews?.length && (
        <section className="card" aria-labelledby="fa" style={{ borderLeft: '4px solid var(--color-warning)' }}>
          <h2 id="fa" style={{ marginTop: 0 }}>
            False alarms to confirm
          </h2>
          {reviews.map((x) => (
            <div className="row" key={x.incidentId}>
              <div className="label">
                <strong>
                  <Link href={`/incidents/${x.incidentId}`}>{x.label}</Link>
                </strong>
                <span>
                  {x.officer}
                  {x.officerNote ? `: “${x.officerNote}”` : ''} · goes ahead {new Date(x.dueAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <LinkButton className="btn" href={`/incidents/${x.incidentId}`}>
                  Review or overturn
                </LinkButton>
                <button className="btn primary" type="button" onClick={() => confirm(x.incidentId)}>
                  Confirm
                </button>
              </div>
            </div>
          ))}
        </section>
      )}
      <div className="stats">
        <div className="stat">
          <span>Reports this period</span>
          <strong>{s?.reports ?? '—'}</strong>
          <small>Closed and open</small>
        </div>
        <div className="stat">
          <span>Average response</span>
          <strong className="info">{mmss(s?.avgResponseS)}</strong>
          <small>Accept to on scene</small>
        </div>
        <div className="stat">
          <span>Resolved</span>
          <strong className="success">{s?.resolvedPct != null ? `${s.resolvedPct}%` : '—'}</strong>
          <small>Of closed reports</small>
        </div>
        <div className="stat">
          <span>False alarms</span>
          <strong className="warning">{s?.falseAlarmPct != null ? `${s.falseAlarmPct}%` : '—'}</strong>
          <small>Marked by officers</small>
        </div>
        <div className="stat">
          <span>Average rating</span>
          <strong>
            <Rating value={s?.rating} size={20} empty="—" />
          </strong>
          <small>From citizens</small>
        </div>
      </div>
      <div className="grid two">
        <section className="card" aria-labelledby="day">
          <h2 id="day" style={{ marginTop: 0 }}>
            Average response by day
          </h2>
          {r && <HBars rows={r.byDay.map((d) => ({ label: d.day, value: d.avgResponseS }))} format={mmss} />}
        </section>
        <section className="card" aria-labelledby="type">
          <h2 id="type" style={{ marginTop: 0 }}>
            Reports by type
          </h2>
          {r && (r.byType.length ? <HBars rows={r.byType.map((t) => ({ label: t.label, value: t.n, color: TYPE_COLOR[t.type] ?? '#8a8f98' }))} /> : <p className="muted">No reports in this period.</p>)}
        </section>
      </div>
      <section className="card" aria-labelledby="rate">
        <h2 id="rate" style={{ marginTop: 0 }}>
          Citizen ratings
        </h2>
        {r && <HBars rows={r.ratings.map((x) => ({ label: `${x.stars} ${x.stars === 1 ? 'star' : 'stars'}`, value: x.n }))} color="var(--color-warning)" />}
        <p className="muted" style={{ marginBottom: 0 }}>
          Ratings drive rewards for officers and the station.
        </p>
      </section>
      <section className="card" aria-labelledby="recent" style={{ padding: 0, overflowX: 'auto' }}>
        <h2 id="recent" style={{ margin: 20 }}>
          Recent closed reports
        </h2>
        {r && !r.recent.length ? (
          <div className="empty">Nothing closed in this period.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Closed</th>
                <th>Type</th>
                <th>Postcode</th>
                <th>Response</th>
                <th>Rating</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {r?.recent.map((x) => (
                <tr key={x.id}>
                  <td>
                    <Link href={`/incidents/${x.id}`}>{new Date(x.closedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</Link>
                  </td>
                  <td>{x.type}</td>
                  <td>{x.postcode ?? 'GPS'}</td>
                  <td>{mmss(x.responseS)}</td>
                  <td>
                    <Rating value={x.stars} empty="—" />
                  </td>
                  <td>
                    <strong style={{ color: OUTCOME[x.outcome] }}>{x.outcome}</strong>
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
