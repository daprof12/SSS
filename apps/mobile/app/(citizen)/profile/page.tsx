'use client';

import { SignOutButton } from '@/components/SignOutButton';
import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
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
  security: { mfaEnabled: boolean };
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
        <Avatar name={me?.name ?? ' '} size={72} />
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
        <Row href="/donate" icon="heart" label="Donations" />
        <Row href="/tips" icon="tip" label="My tips and bounties" />
        <Row href="/payments" icon="activity" label="Payments and receipts" />
      </div>

      <p className="section-label">Safety</p>
      <div className="list">
        <Row href="/profile/contacts" icon="contacts" label="Emergency contacts" end={contacts == null ? '' : `${contacts} of 3`} />
        <Row href="/profile/home" icon="home" label="Home, devices and household" />
        <Row href="/issues" icon="road" label="My public issues" />
        <Row href="/profile/security" icon="lock" label="Security" end={me ? (me.security.mfaEnabled ? '2FA on' : '2FA off') : ''} />
        <Row href="/profile/discreet" icon="eye" label="Discreet mode" end={me ? (me.preferences.discreetMode ? 'On' : 'Off') : ''} />
        <Row href="/fines" icon="flag" label="Fines and appeals" />
      </div>

      <p className="section-label">App</p>
      <div className="list">
        <Row href="/profile/appearance" icon="sun" label="Appearance" end={me ? me.preferences.theme[0]!.toUpperCase() + me.preferences.theme.slice(1) : ''} />
        <Row href="/notifications" icon="bell" label="Notifications" />
        <Row href="/profile/language" icon="globe" label="Language" end={LANG[me?.preferences.locale ?? 'en']} />
        <Row href="/profile/sounds" icon="bell" label="Notification sounds" end="" />
        <Row href="/help" icon="help" label="Help and support" />
      </div>

      <div className="list">
        <SignOutButton />
      </div>
    </main>
  );
}
