'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/client';

interface Device {
  id: string;
  type: 'camera' | 'street_light';
  name: string;
  status: string;
  line: string;
}
interface Overview {
  home: { address: string; postcode: string; plan: { name: string; label: string; tone: string; paidUntil: string | null } | null; permissions: { report: boolean } } | null;
  devices?: Device[];
  alert?: { deviceId: string; title: string; line: string } | null;
}
const STATUS: Record<string, string> = { online: 'Online', offline: 'Offline', low_power: 'Low power', needs_repair: 'Repair booked', tamper: 'Check needed' };
const TABS = [
  ['all', 'All'],
  ['camera', 'Cameras'],
  ['street_light', 'Street lights'],
] as const;

/** Board "My home devices": plan status, devices with live status, the first problem to fix. */
export default function Devices() {
  const [o, setO] = useState<Overview | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('all');
  useEffect(() => {
    api<Overview>('/me/home').then(setO).catch(() => setO({ home: null }));
  }, []);
  const list = (o?.devices ?? []).filter((d) => tab === 'all' || d.type === tab);
  const plan = o?.home?.plan;
  return (
    <main className="app" style={{ paddingBottom: 110 }}>
      <Header title="My home devices" back="/profile/home" />
      {!o && <div className="skeleton" style={{ height: 72 }} />}
      {o && !o.home && (
        <div className="empty">
          <strong>No home devices yet.</strong>
          Join a household or ask in Help and support about a plan.
        </div>
      )}
      {o?.home && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1, display: 'grid' }}>
            <strong>
              {o.home.address}, {o.home.postcode}
            </strong>
            <span className="muted">{plan ? `${plan.name} plan${plan.paidUntil ? `, paid until ${new Date(plan.paidUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}` : 'No plan'}</span>
          </span>
          {plan && <strong style={{ color: `var(--color-${plan.tone === 'success' ? 'success' : plan.tone === 'critical' ? 'emergency' : 'warning'}-text)` }}>{plan.label}</strong>}
        </div>
      )}
      {o?.home && (
        <div className="tabs" role="tablist">
          {TABS.map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
      )}
      {list.map((d) => (
        <Link key={d.id} className="device-row" data-status={d.status} href={`/profile/home/devices/${d.id}`}>
          <span className="device-thumb" aria-hidden>
            <Icon name={d.type === 'camera' ? 'camera' : 'sun'} />
          </span>
          <span className="grow">
            <strong>{d.name}</strong>
            <span className="sub">{d.line}</span>
          </span>
          <span className="state">{STATUS[d.status] ?? d.status}</span>
        </Link>
      ))}
      {o?.alert && (
        <Link className="banner warning" href={`/profile/home/devices/${o.alert.deviceId}`} style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', marginTop: 8 }}>
          <span style={{ flex: 1 }}>
            <strong>{o.alert.title}</strong>
            {o.alert.line}
          </span>
          <strong>Fix</strong>
        </Link>
      )}
      {o?.home?.permissions.report && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', maxWidth: 520, margin: '0 auto' }}>
          <Link className="btn block" href="/profile/home/report" style={{ minHeight: 56 }}>
            Report a problem
          </Link>
        </div>
      )}
    </main>
  );
}
