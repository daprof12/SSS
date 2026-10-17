'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { api, getSession, TYPES } from '@/lib/client';

interface Me {
  name: string;
  kyc: { status: string };
  trust: { band: string };
}
interface Place {
  isHome: boolean;
  postcode: string;
  address: string;
  verified: boolean;
}
interface Mine {
  id: string;
  type: string;
  state: string;
  open: boolean;
  status: string;
}

const QUICK = ['fire', 'robbery', 'medical', 'kidnapping', 'riot'] as const;

/** Citizen Home (Wireframe 1): one big SOS, quick types, live report bar, location line. */
export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [home, setHome] = useState<Place | null | undefined>(undefined);
  const [open, setOpen] = useState<Mine | null>(null);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    api<Me>('/me').then(setMe).catch(() => {});
    api<Place[]>('/me/places')
      .then((p) => setHome(p.find((x) => x.isHome) ?? null))
      .catch(() => setHome(null));
    const poll = () => {
      api<Mine[]>('/me/incidents').then((r) => setOpen(r.find((x) => x.open) ?? null)).catch(() => {});
      api<{ unread: number }>('/me/notifications').then((n) => setUnread(n.unread)).catch(() => {});
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, []);

  const first = (me?.name ?? getSession()?.name ?? '').split(' ')[0];
  return (
    <main className="app">
      <header className="header">
        <div className="greeting">
          <small>Welcome back</small>
          <strong>Hello, {first}</strong>
        </div>
        <span className="spacer" />
        {me?.kyc.status === 'verified' && (
          <span className="chip success">
            <Icon name="check" size={14} /> Verified
          </span>
        )}
        <Link href="/notifications" className="round-btn" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
          <Icon name="bell" />
          {unread > 0 && <span className="dot" />}
        </Link>
      </header>

      {open && (
        <Link href={`/reports/${open.id}`} className="live-bar">
          <span className="fresh">
            <i aria-hidden />
          </span>
          <span className="grow" style={{ flex: 1 }}>
            <strong style={{ textTransform: 'capitalize' }}>
              {open.type}: {open.status}
            </strong>
            <span>Tap to follow your report</span>
          </span>
          <Icon name="chevron" />
        </Link>
      )}

      <Link href="/profile/home" className="location-line" style={{ textDecoration: 'none', color: 'inherit' }}>
        <span className="pin">
          <Icon name="home" />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          {home === undefined ? (
            <strong>Finding your home…</strong>
          ) : home ? (
            <>
              <strong>Home, {home.address}</strong>
              <span>
                Postcode {home.postcode}
                {home.verified ? ', building confirmed' : ', not confirmed yet'}
              </span>
            </>
          ) : (
            <>
              <strong>Add your home</strong>
              <span>So help finds the exact building</span>
            </>
          )}
        </span>
        <span className="link-btn">Edit</span>
      </Link>

      <div className="sos-wrap">
        <Link href="/report" className="sos" aria-label="SOS. Tap to report an emergency" style={{ textDecoration: 'none' }}>
          <strong>SOS</strong>
          <span>Tap to report</span>
        </Link>
      </div>

      <p className="section-label">What is happening?</p>
      <div className="tiles">
        {QUICK.map((code) => (
          <Link key={code} href={`/report?type=${code}`} className="tile">
            <Icon name={code} size={28} />
            {TYPES.find((t) => t.code === code)!.label}
          </Link>
        ))}
        <Link href="/report" className="tile">
          <Icon name="other" size={28} />
          More
        </Link>
      </div>

      {me?.trust.band === 'low' && (
        <div className="banner warning" style={{ marginTop: 16 }}>
          <strong>Your trust score is low</strong>
          Your reports still go out. Responders check them on arrival. <Link href="/profile">See how to improve</Link>
        </div>
      )}
    </main>
  );
}
