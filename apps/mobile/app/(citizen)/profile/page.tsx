'use client';

import { formatNaira } from '@erp/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, setSession } from '@/lib/client';

interface Me {
  name: string;
  kyc: { status: string };
  trust: { score: number; band: string };
  preferences: { theme: string; locale: string; discreetMode: boolean };
}

const LANG: Record<string, string> = { en: 'English', ha: 'Hausa', yo: 'Yoruba', ig: 'Igbo', pcm: 'Pidgin' };

function Row({ href, icon, label, end, soon }: { href?: string; icon: string; label: string; end?: string; soon?: boolean }) {
  const inner = (
    <>
      <span className="icon">
        <Icon name={icon} />
      </span>
      <span className="grow">
        <strong>{label}</strong>
      </span>
      {soon ? <span className="chip neutral">Soon</span> : <span className="end">{end}</span>}
      {!soon && <Icon name="chevron" size={18} />}
    </>
  );
  return soon || !href ? (
    <div className="row soon" aria-disabled="true">
      {inner}
    </div>
  ) : (
    <Link className="row" href={href}>
      {inner}
    </Link>
  );
}

/** Citizen profile with the rows from UX Gap Analysis §2.1, grouped. */
export default function Profile() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [wallet, setWallet] = useState<string>('');
  const [contacts, setContacts] = useState<number | null>(null);

  useEffect(() => {
    api<Me>('/me').then(setMe).catch(() => {});
    api<{ availableKobo: number }>('/me/wallet').then((w) => setWallet(formatNaira(w.availableKobo))).catch(() => {});
    api<{ contacts: unknown[] }>('/me/emergency-contacts').then((c) => setContacts(c.contacts.length)).catch(() => {});
  }, []);

  const pct = Math.max(4, Math.min(100, me?.trust.score ?? 0));
  return (
    <main className="app">
      <Header back={false} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <span className="avatar" style={{ width: 72, height: 72, fontSize: 24 }} aria-hidden>
          {(me?.name ?? '').split(' ').map((w) => w[0]).join('').slice(0, 2)}
        </span>
        <div>
          <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>{me?.name ?? ' '}</h1>
          {me?.kyc.status === 'verified' ? (
            <span style={{ color: 'var(--color-success-text)', fontWeight: 700 }}>
              <Icon name="check" size={16} /> Identity verified
            </span>
          ) : (
            <span className="chip warning">Not verified</span>
          )}
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>Trust score</h2>
          <span className={`chip ${me?.trust.band === 'high' ? 'success' : me?.trust.band === 'low' ? 'warning' : 'neutral'}`} style={{ textTransform: 'capitalize' }}>
            {me?.trust.band ?? '…'}
          </span>
        </div>
        <div style={{ height: 10, borderRadius: 5, background: 'var(--color-surface-raised)', margin: '14px 0 10px', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--color-success)', borderRadius: 5, transition: 'width var(--motion-emphasis-duration) var(--motion-emphasis-easing)' }} />
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Based on past reports. False alarms lower it and may lead to a warning or fine. You can appeal.
        </p>
      </div>

      <p className="section-label">Money</p>
      <div className="list">
        <Row href="/wallet" icon="wallet" label="Wallet" end={wallet} />
        <Row icon="heart" label="Donations" soon />
        <Row href="/tips" icon="tip" label="My tips and bounties" />
        <Row icon="activity" label="Payments and receipts" soon />
      </div>

      <p className="section-label">Safety</p>
      <div className="list">
        <Row href="/profile/contacts" icon="contacts" label="Emergency contacts" end={contacts == null ? '' : `${contacts} of 3`} />
        <Row href="/profile/home" icon="home" label="Home and saved places" />
        <Row href="/issues" icon="road" label="My public issues" />
        <Row icon="lock" label="Security" soon />
        <Row icon="eye" label="Discreet mode" soon />
        <Row icon="activity" label="Fines and appeals" soon />
      </div>

      <p className="section-label">App</p>
      <div className="list">
        <Row href="/profile/appearance" icon="sun" label="Appearance" end={me ? me.preferences.theme[0]!.toUpperCase() + me.preferences.theme.slice(1) : ''} />
        <Row href="/notifications" icon="bell" label="Notifications" />
        <Row icon="globe" label="Language" soon />
        <Row icon="help" label="Help and support" soon />
      </div>

      <div className="list">
        <button
          className="row"
          type="button"
          onClick={async () => {
            // Revoke on the server first, so this device's tokens stop working at once.
            await api('/auth/sign-out', { method: 'POST' }).catch(() => {});
            setSession(null);
            router.replace('/sign-in');
          }}
        >
          <span className="icon">
            <Icon name="out" />
          </span>
          <span className="grow">
            <strong>Sign out</strong>
          </span>
        </button>
      </div>
      <p className="muted center">Language: {LANG[me?.preferences.locale ?? 'en']}</p>
    </main>
  );
}
