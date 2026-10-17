'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError, typeInfo } from '@/lib/client';

interface Mine {
  id: string;
  type: string;
  state: string;
  role: string;
  open: boolean;
  status: string;
  createdAt: string;
}
type Tab = 'all' | 'open' | 'closed';

const tone = (s: string) =>
  ['resolved', 'on_scene', 'closing'].includes(s) ? 'success' : ['escalated', 'reassigning'].includes(s) ? 'warning' : ['cancelled', 'unfounded', 'merged'].includes(s) ? 'neutral' : 'info';

/** Activity: every report, open ones pinned first (States doc: All, Open, Closed). */
export default function Activity() {
  const [rows, setRows] = useState<Mine[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');

  const load = () =>
    api<Mine[]>('/me/incidents')
      .then((r) => {
        setRows(r);
        setErr(null);
      })
      .catch((e: ApiError) => setErr(e.message));
  useEffect(() => {
    void load();
  }, []);

  const shown = (rows ?? []).filter((r) => r.state !== 'merged' && (tab === 'all' || (tab === 'open' ? r.open : !r.open)));
  return (
    <main className="app">
      <Header title="Activity" back={false} />
      <div className="tabs" role="tablist">
        {(['all', 'open', 'closed'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {err && (
        <div className="banner critical" role="alert">
          <strong>Could not load your reports</strong>
          {err}{' '}
          <button className="link-btn" type="button" onClick={load}>
            Retry
          </button>
        </div>
      )}
      {rows === null && !err && [0, 1, 2].map((i) => <div key={i} className="skeleton" />)}
      {rows && shown.length === 0 && (
        <div className="empty">
          <strong>{tab === 'open' ? 'Nothing open.' : 'You have not reported anything.'}</strong>
          If you need help, tap SOS on Home.
        </div>
      )}
      {shown.map((r) => (
        <Link key={r.id} href={`/reports/${r.id}`} className={`inc sev-${tone(r.state)}`}>
          <Icon name={r.type} />
          <span className="grow">
            <strong>{typeInfo(r.type).label}</strong>
            <span className="sub">
              {new Date(r.createdAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              {r.role === 'joined' ? ' · you joined' : ''}
            </span>
          </span>
          <span className={`chip ${tone(r.state)}`}>{r.status}</span>
        </Link>
      ))}
    </main>
  );
}
