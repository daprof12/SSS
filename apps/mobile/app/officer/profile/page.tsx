'use client';
// Board "Officer profile and rating", plus the §2.2 rows (documents, duty, alerts, security, help).
import { SignOutButton } from '@/components/SignOutButton';
import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
import { formatNaira, RATING_DIMENSIONS } from '@erp/domain';
import { readTheme } from '@erp/web-ui/theme';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { Dot, rating } from '@/components/officer/work';
import { api, getSession, setSession } from '@/lib/client';
import { AgencyLogo } from '@erp/web-ui/AgencyLogo';

interface Profile {
  name: string;
  agency: string;
  station: string;
  serviceNo: string;
  rank: string | null;
  badge: { status: string; expiresOn: string | null };
  rating: { overall: number | null; count: number; arrival: number | null; care: number | null; solved: number | null };
  team: { name: string; officers: number; rating: number | null };
  wallet: { availableKobo: number; heldKobo: number };
  rewardsAndDonationsKobo: number;
  bank: { name: string; lastFour: string; verified: boolean } | null;
  tips: number;
  acceptance: { ratePct: number | null; accepted: number; declined: number; missed: number };
  onDuty: boolean;
}
const naira = (k: number) => formatNaira(k).replace(/\.00$/, '');
const BADGE: Record<string, [string, string]> = {
  verified: ['Badge verified', 'var(--color-success-text)'],
  pending: ['Badge check pending', 'var(--color-warning-text)'],
  expired: ['Badge expired', 'var(--color-emergency-text)'],
  rejected: ['Badge not accepted', 'var(--color-emergency-text)'],
};

export default function OfficerProfile() {
  const router = useRouter();
  const [p, setP] = useState<Profile | null>(null);
  const [theme, setTheme] = useState('System');
  const [wa, setWa] = useState<boolean | null>(null);
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    api<{ preferences: { whatsappOptIn?: boolean }; brand: { logoUrl: string | null } | null }>('/me')
      .then((m) => (setWa(!!m.preferences.whatsappOptIn), setLogo(m.brand?.logoUrl ?? null)))
      .catch(() => {});
  }, []);
  useEffect(() => {
    api<Profile>('/me/officer/profile')
      .then(setP)
      .catch(() => {});
    setTheme({ system: 'System', light: 'Light', dark: 'Dark' }[readTheme()]);
  }, []);
  const name = p?.name ?? getSession()?.name ?? '';
  const badge = BADGE[p?.badge.status ?? 'verified']!;

  const row = (href: string, icon: string, label: string, end?: React.ReactNode) => (
    <Link className="row" href={href}>
      <span className="icon">
        <Icon name={icon} />
      </span>
      <span className="grow">
        <strong>{label}</strong>
      </span>
      {end != null && <span className="end">{end}</span>}
      <Icon name="chevron" size={18} />
    </Link>
  );
  const bar = (label: string, v: number | null) => (
    <div className="rating-bar">
      <span>{label}</span>
      <span className="bar" aria-hidden>
        <i style={{ transform: `scaleX(${v ? v / 5 : 0})` }} />
      </span>
      <Rating value={v} />
    </div>
  );

  return (
    <main className="app">
      <Header back={false} />
      <div className="profile-head">
        <Avatar name={name} size={72} status={p ? (p.onDuty ? 'on_duty' : 'off_duty') : null} />
        <div>
          <h1 style={{ margin: 0, fontSize: 'var(--text-xl)' }}>{name}</h1>
          <span className="muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {p && <AgencyLogo url={logo} name={p.agency} size={24} radius={6} />}
            {p ? `${p.agency}, ${p.station}, service no. ${p.serviceNo}` : ' '}
          </span>
          <div style={{ color: badge[1], fontWeight: 700 }}>{badge[0]}</div>
        </div>
      </div>

      <div className="card rating-card">
        <span className="muted">Rating score</span>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <Rating value={p?.rating.overall} size={30} style={{ fontSize: 'var(--text-2xl, 2rem)' }} />
          <span className="muted">{p ? (p.rating.count ? `From ${p.rating.count} rated ${p.rating.count === 1 ? 'response' : 'responses'}` : 'No ratings yet') : ''}</span>
        </div>
        {bar('Arrival speed', p?.rating.arrival ?? null)}
        {bar('Care and manner', p?.rating.care ?? null)}
        {bar(RATING_DIMENSIONS.solved.label, p?.rating.solved ?? null)}
        <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--color-divider)', marginTop: 12, paddingTop: 12 }}>
          <span className="muted">Acceptance, last 30 days</span>
          <strong>{p ? (p.acceptance.ratePct == null ? 'No offers yet' : `${p.acceptance.ratePct}%`) : ''}</strong>
        </div>
        {p && (p.acceptance.declined > 0 || p.acceptance.missed > 0) && (
          <span className="muted" style={{ fontSize: 'var(--text-sm)' }}>
            {p.acceptance.accepted} accepted, {p.acceptance.declined} declined, {p.acceptance.missed} missed
          </span>
        )}
      </div>

      <Link href="/officer/team" className="card team-card">
        <span className="grow">
          <strong>{p?.team.name ?? 'Team'}</strong>
          <span className="muted" style={{ display: 'block' }}>
            {p ? `${p.team.officers} ${p.team.officers === 1 ? 'officer' : 'officers'}, team rating ★ ${rating(p.team.rating)}` : ''}
          </span>
        </span>
        <span className="dots" aria-hidden>
          {[0, 1, 2, 3].slice(0, Math.max(1, Math.min(4, p?.team.officers ?? 4))).map((i) => (
            <Dot key={i} i={i} size={36} />
          ))}
        </span>
      </Link>

      <div className="list">
        {row('/officer/wallet', 'wallet', 'Wallet', p ? naira(p.wallet.availableKobo) : '')}
        {row('/officer/wallet', 'money', 'Rewards and donations', p ? naira(p.rewardsAndDonationsKobo) : '')}
        {row('/officer/wallet', 'shield', 'Bank account', p ? (p.bank ? `${p.bank.name}, ending ${p.bank.lastFour}` : 'Not added') : '')}
        {row('/officer/tips', 'tip', 'My tips and bounties', p ? `${p.tips} ${p.tips === 1 ? 'tip' : 'tips'}` : '')}
        {row('/officer/appearance', 'sun', 'Theme', theme)}
      </div>

      <p className="section-label">Work</p>
      <div className="list">
        {row('/officer/badge', 'shield', 'Documents and badge', p?.badge.status === 'verified' ? 'Verified' : 'Check')}
        {row('/officer/shifts', 'history', 'Duty and shifts', p ? (p.onDuty ? 'On duty' : 'Off duty') : '')}
        {row('/officer/statements', 'history', 'My statements', '')}
        {row('/officer/notifications', 'bell', 'Dispatch alerts')}
        {row('/officer/sounds', 'bell', 'Notification sounds')}
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>Station messages on WhatsApp</strong>
            <span className="sub">As well as in the app</span>
          </span>
          <button
            className="toggle"
            type="button"
            role="switch"
            aria-checked={!!wa}
            aria-label="Station messages on WhatsApp"
            disabled={wa === null}
            onClick={async () => {
              const next = !wa;
              setWa(next);
              await api('/me/preferences', { method: 'PATCH', body: JSON.stringify({ whatsappOptIn: next }) }).catch(() => setWa(!next));
            }}
          />
        </div>
      </div>
      <p className="section-label">Account</p>
      <div className="list">
        {row('/officer/security', 'lock', 'Security')}
        {row('/officer/help', 'help', 'Help')}
        <SignOutButton onDuty={!!p?.onDuty} />
      </div>
    </main>
  );
}
