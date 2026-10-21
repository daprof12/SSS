'use client';
// Board "Officer history and team ratings": the station's responses, with mine marked.
import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { rating, shortDate } from '@/components/officer/work';
import { api, ApiError } from '@/lib/client';

type Filter = 'all' | 'mine' | 'team' | 'month';
interface Row {
  id: string;
  title: string;
  people: string;
  mine: boolean;
  closedAt: string;
  resolved: boolean;
  stars: number | null;
}
interface History {
  stats: { responses: number; myRating: number | null; teamRating: number | null };
  items: Row[];
}
const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['mine', 'Mine'],
  ['team', 'Team'],
  ['month', 'This month'],
];
const KEY = 'erp-officer-history-filter';

export default function OfficerHistory() {
  const [filter, setFilter] = useState<Filter>(() => {
    try {
      return (sessionStorage.getItem(KEY) as Filter) || 'all';
    } catch {
      return 'all';
    }
  });
  const [h, setH] = useState<History | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setH((x) => (x ? { ...x, items: [] } : x));
    api<History>(`/me/officer/history?filter=${filter}`)
      .then(setH)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load history.'));
    try {
      sessionStorage.setItem(KEY, filter);
    } catch {}
  }, [filter]);

  return (
    <main className="app">
      <h1 style={{ margin: '8px 0 0' }}>History</h1>
      <p className="muted" style={{ marginTop: 4 }}>
        Your team activity and ratings
      </p>
      <div className="stats">
        <div className="stat">
          <small>Responses</small>
          <strong>{h?.stats.responses ?? '–'}</strong>
        </div>
        <div className="stat">
          <small>My rating</small>
          <strong>
            <Rating value={h?.stats.myRating} size={16} />
          </strong>
        </div>
        <div className="stat">
          <small>Team rating</small>
          <strong>
            <Rating value={h?.stats.teamRating} size={16} />
          </strong>
        </div>
      </div>
      <div className="chips learn-chips" role="tablist" aria-label="Show">
        {FILTERS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={filter === k} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {l}
          </button>
        ))}
      </div>
      {err && (
        <div className="banner critical" role="alert">
          {err}
        </div>
      )}
      {!h ? (
        [0, 1, 2].map((i) => <div key={i} className="skeleton" />)
      ) : !h.items.length ? (
        <div className="card empty">
          <strong>{filter === 'mine' ? 'No responses yet.' : 'Nothing here yet.'}</strong>
          Closed responses from the last 90 days show here, with the rating each one got.
        </div>
      ) : (
        <div className="history-list">
          {h.items.map((r) => (
            <Link key={r.id} href={`/officer/history/${r.id}`} className="history-row">
              <span className="history-top">
                <span className="status-dot" data-ok={r.resolved} aria-hidden />
                <strong>{r.title}</strong>
                <span className="muted">{shortDate(r.closedAt)}</span>
              </span>
              <span className="history-bottom">
                <span className="muted">{r.people}</span>
                <Rating value={r.stars} empty="Not rated yet" />
              </span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
