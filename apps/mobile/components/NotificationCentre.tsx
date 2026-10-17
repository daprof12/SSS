'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { api, ApiError, getSession } from '@/lib/client';

interface Note {
  id: string;
  title: string;
  body: string;
  link: string | null;
  at: string;
  unread: boolean;
}
type Tab = 'all' | 'reports' | 'money' | 'account';

const when = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Map API deep links to app routes for each surface. */
export function routeFor(link: string | null, surface: 'citizen' | 'officer' | undefined): string | null {
  if (!link) return null;
  const t = /^\/(tips|issues)\/([0-9a-f-]{36})/.exec(link);
  if (t) return surface === 'officer' ? `/officer/${t[1]}/${t[2]}` : `/${t[1]}/${t[2]}`;
  const m = /^\/(reports|offers|history|incidents)\/([0-9a-f-]{36})/.exec(link);
  if (!m) return link.startsWith('/wallet') ? (surface === 'officer' ? '/officer/wallet' : '/wallet') : null;
  if (surface === 'officer') return m[1] === 'offers' ? `/officer/offers/${m[2]}` : `/officer/incidents/${m[2]}`;
  return `/reports/${m[2]}`;
}

/** Notification centre: tabs, unread dot, mark all read (States doc). Shared by both surfaces. */
export function NotificationCentre({ back }: { back: string }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('all');
  const [data, setData] = useState<{ unread: number; items: Note[]; empty: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = (t: Tab = tab) =>
    api<{ unread: number; items: Note[]; empty: string }>(`/me/notifications?tab=${t}`)
      .then((d) => {
        setData(d);
        setErr(null);
      })
      .catch((e: ApiError) => setErr(e.message));
  useEffect(() => {
    void load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const open = async (n: Note) => {
    if (n.unread) await api(`/me/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
    const to = routeFor(n.link, getSession()?.surface);
    if (to) router.push(to);
    else void load();
  };

  return (
    <main className="app">
      <Header title="Notifications" back={back}>
        {!!data?.unread && (
          <button
            className="link-btn"
            type="button"
            onClick={async () => {
              await api('/me/notifications/read-all', { method: 'POST' }).catch(() => {});
              void load();
            }}
          >
            Mark all read
          </button>
        )}
      </Header>
      <div className="tabs" role="tablist">
        {(['all', 'reports', 'money', 'account'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {err && (
        <div className="banner critical" role="alert">
          {err}
        </div>
      )}
      {!data && !err && [0, 1, 2].map((i) => <div key={i} className="skeleton" />)}
      {data && data.items.length === 0 && (
        <div className="empty">
          <strong>Nothing new.</strong>
          Updates about your reports, money and account appear here.
        </div>
      )}
      {data && data.items.length > 0 && (
        <div className="list">
          {data.items.map((n) => (
            <button key={n.id} className="row" type="button" onClick={() => open(n)}>
              {n.unread ? <span style={{ width: 10, height: 10, borderRadius: 5, background: 'var(--color-emergency)', flex: 'none' }} aria-label="Unread" /> : <span style={{ width: 10, flex: 'none' }} />}
              <span className="grow">
                <strong>{n.title}</strong>
                <span className="sub">{n.body}</span>
              </span>
              <span className="end">{when(n.at)}</span>
            </button>
          ))}
        </div>
      )}
    </main>
  );
}

