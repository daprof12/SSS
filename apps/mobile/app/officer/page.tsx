'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
import { api, ApiError, getSession, haptic, locate, typeInfo } from '@/lib/client';

interface Item {
  id: string;
  type: string;
  state?: string;
  postcode: string | null;
  area_label?: string;
  officer?: string;
  distance_m?: number;
  secondsLeft?: number;
  eta_minutes?: number | null;
  stars?: number | null;
}
interface Home {
  onDuty: boolean;
  badgeVerified: boolean;
  banner: string | null;
  today: { closed: number; avgArrival: string | null; rating: number | null };
  tabs: Record<'offers' | 'active' | 'team' | 'done', { items: Item[]; empty: string }>;
}
type Tab = keyof Home['tabs'];

const STATE: Record<string, [string, string]> = {
  accepted: ['Accepted', 'info'],
  en_route: ['En route', 'info'],
  on_scene: ['On scene', 'success'],
  resolved: ['Resolved', 'success'],
  unfounded: ['Unfounded', 'neutral'],
};
const km = (m?: number) => (m == null ? '' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);

/** Officer Home (Rewards doc "Officer mobile screens"; board "Officer home"). */
export default function OfficerHome() {
  const router = useRouter();
  const [h, setH] = useState<Home | null>(null);
  const [tab, setTab] = useState<Tab>('offers');
  const [busy, setBusy] = useState(false);
  const [unread, setUnread] = useState(0);
  const [toast, setToast] = useToast();
  const seenOffers = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    const x = await api<Home>('/me/officer/home').catch(() => null);
    if (!x) return;
    setH(x);
    // A new offer: buzz and open it full screen (dispatch alerts are high priority).
    const ids = new Set(x.tabs.offers.items.map((o) => o.id));
    if (seenOffers.current) {
      const fresh = [...ids].find((i) => !seenOffers.current!.has(i));
      if (fresh) {
        haptic([200, 100, 200, 100, 200]);
        router.push(`/officer/offers/${fresh}`);
      }
    }
    seenOffers.current = ids;
    api<{ unread: number }>('/me/notifications').then((n) => setUnread(n.unread)).catch(() => {});
  }, [router]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const toggleDuty = async () => {
    if (!h) return;
    setBusy(true);
    try {
      let location: { lat: number; lng: number } | undefined;
      if (!h.onDuty) {
        location = (await locate()) ?? undefined;
        // Development only: the seeded post, so the demo works without GPS.
        if (!location && process.env.NODE_ENV !== 'production') location = { lat: 6.6015, lng: 3.352 };
      }
      const r = await api<{ message: string }>('/me/officer/duty', { method: 'PATCH', body: JSON.stringify({ onDuty: !h.onDuty, location }) });
      setToast(r.message);
      void load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not change duty. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const name = getSession()?.name ?? '';
  // "Insp. Musa Bello" → "Musa": skip the rank, greet by first name.
  const first = name.split(' ').filter((w) => !w.endsWith('.') && !/^(CSP|DSP|ASP|SP|Cpl|Sgt|Insp)$/i.test(w))[0] ?? name;
  const items = h?.tabs[tab].items ?? [];
  return (
    <main className="app">
      <header className="header">
        {/* Tap your avatar to go on or off duty; the dot at its corner shows which. */}
        <button
          type="button"
          role="switch"
          aria-checked={!!h?.onDuty}
          aria-label={h?.onDuty ? 'On duty. Tap to go off duty' : 'Off duty. Tap to go on duty'}
          onClick={toggleDuty}
          disabled={!h || busy}
          style={{ border: 0, padding: 0, background: 'none', borderRadius: '50%', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}
        >
          <Avatar name={name} size={56} status={h ? (h.onDuty ? 'on_duty' : 'off_duty') : null} />
        </button>
        <div className="greeting">
          <strong style={{ fontSize: 'var(--text-lg)' }}>Hello, {first}</strong>
          <small>
            Station 4 Ikeja ·{' '}
            <span style={{ color: h?.onDuty ? 'var(--color-success-text)' : 'var(--color-text-secondary)', fontWeight: 600 }}>{busy ? 'Updating…' : h ? (h.onDuty ? 'On duty' : 'Off duty, tap your photo') : ''}</span>
          </small>
        </div>
        <span className="spacer" />
        <Link href="/officer/notifications" className="round-btn" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
          <Icon name="bell" />
          {unread > 0 && <span className="dot" />}
        </Link>
      </header>

      {h?.banner && (
        <div className="banner warning" role="status">
          {h.banner}
        </div>
      )}

      <div className="stats">
        <div className="stat">
          <small>Today</small>
          <strong>{h?.today.closed ?? '–'}</strong>
        </div>
        <div className="stat">
          <small>Avg arrival</small>
          <strong style={{ color: 'var(--color-signal-text)' }}>{h?.today.avgArrival ?? '–'}</strong>
        </div>
        <div className="stat">
          <small>Rating</small>
          <strong>
            <Rating value={h?.today.rating == null ? null : Number(h.today.rating)} size={16} />
          </strong>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {(['offers', 'active', 'team', 'done'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
            {h && t !== 'done' ? ` ${h.tabs[t].items.length}` : ''}
          </button>
        ))}
      </div>

      {!h && [0, 1].map((i) => <div key={i} className="skeleton" />)}
      {h && items.length === 0 && (
        <div className="empty">
          <strong>{h.tabs[tab].empty}</strong>
        </div>
      )}
      {items.map((it) => {
        const href = tab === 'offers' ? `/officer/offers/${it.id}` : `/officer/incidents/${it.id}`;
        const [label, tone] = tab === 'offers' ? ['Offered', 'warning'] : STATE[it.state ?? ''] ?? [it.state ?? '', 'neutral'];
        return (
          <Link key={it.id} href={tab === 'team' ? '#' : href} className={`inc sev-${tone === 'warning' ? 'warning' : tone === 'success' ? 'success' : 'info'}`}>
            <span className="grow">
              <strong>
                {typeInfo(it.type).label}, {it.postcode ?? 'GPS'}
              </strong>
              <span className="sub">
                {tab === 'offers' && `${km(it.distance_m)} away · ${it.secondsLeft}s to accept`}
                {tab === 'active' && (it.eta_minutes ? `About ${it.eta_minutes} min away` : it.area_label)}
                {tab === 'team' && it.officer}
                {tab === 'done' && (it.stars ? <Rating value={it.stars} /> : 'Waiting for the citizen to rate')}
              </span>
            </span>
            <span className={`chip ${tone}`}>{label}</span>
          </Link>
        );
      })}

      <Link href="/officer/tips/new" className="banner info" style={{ display: 'block', textDecoration: 'none', marginTop: 12 }}>
        <strong>See something that is not an emergency?</strong>
        Report a tip. The first reporter can earn a bounty.
      </Link>
      <Toast msg={toast} />
    </main>
  );
}
