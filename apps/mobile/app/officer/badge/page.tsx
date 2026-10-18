'use client';
// Documents and badge: what the agency verified, and what to do when it lapses.
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/client';

interface Profile {
  name: string;
  agency: string;
  station: string;
  serviceNo: string;
  rank: string | null;
  badge: { status: string; expiresOn: string | null };
}
const STATUS: Record<string, [string, string, string]> = {
  verified: ['Verified', 'success', 'Your agency confirmed your badge. You can take reports when on duty.'],
  pending: ['Being checked', 'warning', 'Your agency is checking your badge. You can go on duty once it is verified.'],
  expired: ['Expired', 'critical', 'Your badge has expired. Ask your station head to renew it before your next shift.'],
  rejected: ['Not accepted', 'critical', 'Your badge was not accepted. Speak to your station head.'],
};

export default function Badge() {
  const [p, setP] = useState<Profile | null>(null);
  useEffect(() => {
    api<Profile>('/me/officer/profile').then(setP).catch(() => {});
  }, []);
  const s = STATUS[p?.badge.status ?? 'pending']!;
  const soon = p?.badge.expiresOn ? (new Date(p.badge.expiresOn).getTime() - Date.now()) / 86_400_000 : null;
  return (
    <main className="app">
      <Header title="Documents and badge" back="/officer/profile" />
      {!p ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : (
        <>
          <div className="card badge-card">
            <span className={`badge-icon ${s[1]}`} aria-hidden>
              <Icon name="shield" size={32} />
            </span>
            <div>
              <strong style={{ fontSize: 'var(--text-lg)' }}>{p.name}</strong>
              <span className="muted" style={{ display: 'block' }}>
                {p.rank ? `${p.rank}, ` : ''}
                {p.agency}
              </span>
              <span className={`chip ${s[1]}`} style={{ marginTop: 8 }}>
                {s[0]}
              </span>
            </div>
          </div>
          <dl className="facts-list">
            <div>
              <dt>Service number</dt>
              <dd>{p.serviceNo}</dd>
            </div>
            <div>
              <dt>Station</dt>
              <dd>{p.station}</dd>
            </div>
            <div>
              <dt>Valid until</dt>
              <dd>{p.badge.expiresOn ? new Date(p.badge.expiresOn).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'No end date'}</dd>
            </div>
            <div>
              <dt>Identity check</dt>
              <dd>Done when you joined</dd>
            </div>
          </dl>
          {soon != null && soon < 30 && soon > 0 && (
            <div className="banner warning">
              <strong>Renew soon</strong>Your badge expires in {Math.ceil(soon)} days.
            </div>
          )}
          <p className="muted">{s[2]}</p>
          <p className="muted">Citizens see your name, rank and that your badge is verified. They never see your phone number.</p>
        </>
      )}
    </main>
  );
}
