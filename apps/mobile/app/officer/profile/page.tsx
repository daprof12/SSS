'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, getSession, setSession } from '@/lib/client';

/** Officer profile (board "Officer profile and rating" plus §2.2 rows). */
export default function OfficerProfile() {
  const router = useRouter();
  const [stats, setStats] = useState<{ rating: number | null; onDuty: boolean } | null>(null);
  useEffect(() => {
    api<{ onDuty: boolean; today: { rating: number | null } }>('/me/officer/home')
      .then((h) => setStats({ rating: h.today.rating, onDuty: h.onDuty }))
      .catch(() => {});
  }, []);
  const name = getSession()?.name ?? '';
  const soon = (icon: string, label: string) => (
    <div className="row soon" aria-disabled="true">
      <span className="icon">
        <Icon name={icon} />
      </span>
      <span className="grow">
        <strong>{label}</strong>
      </span>
      <span className="chip neutral">Soon</span>
    </div>
  );
  return (
    <main className="app">
      <Header back={false} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <span className="avatar" style={{ width: 72, height: 72, fontSize: 24 }} aria-hidden>
          {name.split(' ').slice(-2).map((w) => w[0]).join('')}
        </span>
        <div>
          <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>{name}</h1>
          <span className="muted">Police, Station 4 Ikeja</span>
          <div style={{ color: 'var(--color-success-text)', fontWeight: 700 }}>
            <Icon name="check" size={16} /> Badge verified
          </div>
        </div>
      </div>
      <div className="card">
        <span className="muted">Rating score</span>
        <div className="big-number" style={{ color: 'var(--color-warning-text)' }}>
          {stats?.rating ?? '–'}
        </div>
        <span className="muted">From rated responses</span>
      </div>
      <p className="section-label">Work</p>
      <div className="list">
        <Link className="row" href="/officer/wallet">
          <span className="icon"><Icon name="wallet" /></span>
          <span className="grow"><strong>Wallet and rewards</strong></span>
          <Icon name="chevron" size={18} />
        </Link>
        {soon('shield', 'Documents and badge')}
        {soon('history', 'Duty and shifts')}
        {soon('bell', 'Dispatch alerts')}
      </div>
      <p className="section-label">Account</p>
      <div className="list">
        {soon('lock', 'Security (two-step login is on)')}
        <Link className="row" href="/officer/appearance">
          <span className="icon"><Icon name="sun" /></span>
          <span className="grow"><strong>Appearance</strong></span>
          <Icon name="chevron" size={18} />
        </Link>
        <Link className="row" href="/officer/notifications">
          <span className="icon"><Icon name="bell" /></span>
          <span className="grow"><strong>Notifications</strong></span>
          <Icon name="chevron" size={18} />
        </Link>
        {soon('help', 'Help')}
      </div>
      <div className="list">
        <button
          className="row"
          type="button"
          disabled={stats?.onDuty}
          onClick={() => {
            setSession(null);
            router.replace('/sign-in');
          }}
        >
          <span className="icon"><Icon name="out" /></span>
          <span className="grow">
            <strong>Sign out</strong>
            {stats?.onDuty && <span className="sub">Go off duty first</span>}
          </span>
        </button>
      </div>
    </main>
  );
}
