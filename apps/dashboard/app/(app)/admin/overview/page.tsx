'use client';
// Board "Admin overview": the whole platform today.
import { LinkButton } from '@erp/web-ui/LinkButton';
import { api, ApiError } from '@erp/web-ui/api';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { DateRange, useDateRange } from '@/components/DateRange';
import { mmss, naira } from '@/components/Dash';
import { MixChart, MixLatest, MixStats, type Mix } from '@/components/ReportMix';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';

interface O {
  stats: { open: number; avgResponseS: number | null; activeSubscriptions: number; devicesOnlinePct: number | null; falseAlarmPct: number | null; kycWaiting: number };
  reports: Mix | null;
  devices: { online: number; low: number; offline: number; repair: number; tamper: number; total: number };
  attention: { key: string; title: string; line: string; count: number; href: string; tone: string }[];
  agencyResponse: { kind: string; label: string; acceptedPct: number | null; avgResponseS: number | null }[];
  money: { subscriptionsKobo: number; installKobo: number; donationFeeKobo: number; finesKobo: number };
}
const DEV: [keyof O['devices'], string, string][] = [
  ['online', 'Online', 'var(--color-success)'],
  ['low', 'Low power', 'var(--color-warning)'],
  ['offline', 'Offline', '#8a8f98'],
  ['repair', 'Needs repair', '#ff7a45'],
  ['tamper', 'Tamper', 'var(--color-emergency)'],
];

export default function AdminOverview() {
  const [o, setO] = useState<O | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loc, setLoc] = useState<LocFilter>({});
  const dates = useDateRange('7d');
  const q = [locQuery(loc), dates.q].filter(Boolean).join('&');
  useEffect(() => {
    if (dates.q === null) return;
    const load = () =>
      api<O>(`/admin/overview${q ? `?${q}` : ''}`)
        .then((x) => (setO(x), setError(null)))
        .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the overview.'));
    void load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [q, dates.q]);
  const s = o?.stats;
  const d = o?.devices;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="lede">The whole platform today.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <LinkButton className="btn" href="/admin/live">
            Open live map
          </LinkButton>
          <button className="btn primary" type="button" onClick={() => window.print()}>
            Print daily report
          </button>
        </div>
      </div>
      <LocationFilter value={loc} onChange={setLoc} />
      <div className="card">
        <DateRange value={dates.range} onChange={dates.setRange} initial={dates.initial} allowAll={false} />
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        {o?.reports !== null && <MixStats m={o?.reports} />}
        <div className="stat">
          <span>Average response</span>
          <strong className="info">{mmss(s?.avgResponseS)}</strong>
          <small>Accept to on scene</small>
        </div>
        <div className="stat">
          <span>Active subscriptions</span>
          <strong className="success">{s?.activeSubscriptions ?? '—'}</strong>
          <small>Households and communities</small>
        </div>
        <div className="stat">
          <span>Devices online</span>
          <strong className="success">{s?.devicesOnlinePct != null ? `${s.devicesOnlinePct}%` : '—'}</strong>
          <small>Of all installed</small>
        </div>
        <div className="stat">
          <span>False alarm rate</span>
          <strong className="warning">{s?.falseAlarmPct != null ? `${s.falseAlarmPct}%` : '—'}</strong>
          <small>Last 30 days</small>
        </div>
        <div className="stat">
          <span>KYC waiting</span>
          <strong>{s?.kycWaiting ?? '—'}</strong>
          <small>In the queue</small>
        </div>
      </div>
      <div className="grid two">
        <section className="card" aria-labelledby="wk">
          <h2 id="wk" style={{ marginTop: 0 }}>
            Reports received
          </h2>
          {o?.reports ? <MixChart m={o.reports} /> : o ? <p className="muted">Your role does not include reports.</p> : <div className="skeleton" />}
        </section>
        <section className="card" aria-labelledby="dh">
          <h2 id="dh" style={{ marginTop: 0 }}>
            Device health
          </h2>
          {d && (
            <>
              <div style={{ display: 'flex', height: 12, borderRadius: 6, overflow: 'hidden', margin: '8px 0 12px', background: 'var(--color-divider)' }}>
                {DEV.map(([k, , c]) => (d.total ? <i key={k} style={{ width: `${(d[k] / d.total) * 100}%`, background: c }} /> : null))}
              </div>
              {DEV.map(([k, l, c]) => (
                <div className="row" key={k} style={{ minHeight: 36 }}>
                  <span>
                    <span style={{ color: c }}>●</span> {l}
                  </span>
                  <strong>{d[k]}</strong>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
      {o?.reports && (
        <section className="card" aria-labelledby="latest">
          <h2 id="latest" style={{ marginTop: 0 }}>
            Latest open reports
          </h2>
          <MixLatest m={o.reports} />
        </section>
      )}
      <section className="card" aria-labelledby="att">
        <h2 id="att" style={{ marginTop: 0 }}>
          Needs attention
        </h2>
        {o?.attention.map((a) => (
          <Link key={a.key} className="row" href={a.href} style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="label">
              <strong>{a.title}</strong>
              <span>{a.line}</span>
            </div>
            <strong style={{ color: a.count ? (a.tone === 'critical' ? 'var(--color-emergency-text)' : 'var(--color-warning-text)') : 'var(--color-text-secondary)' }}>{a.count}</strong>
          </Link>
        ))}
      </section>
      <div className="grid two">
        <section className="card" aria-labelledby="ar">
          <h2 id="ar" style={{ marginTop: 0 }}>
            Agency response
          </h2>
          {o && !o.agencyResponse.length && <p className="muted">No offers in the last 30 days.</p>}
          {o?.agencyResponse.map((a) => (
            <div className="row" key={a.kind}>
              <div className="label">
                <strong>{a.label}</strong>
                <span>Average response {mmss(a.avgResponseS)}</span>
              </div>
              <strong style={{ color: (a.acceptedPct ?? 0) >= 80 ? 'var(--color-success-text)' : 'var(--color-warning-text)' }}>{a.acceptedPct != null ? `${a.acceptedPct}% accepted` : '—'}</strong>
            </div>
          ))}
        </section>
        <section className="card" aria-labelledby="mo">
          <h2 id="mo" style={{ marginTop: 0 }}>
            Money this month
          </h2>
          {o && (
            <dl className="facts">
              <div>
                <dt>Subscriptions, billed through Paystack</dt>
                <dd className="success">{naira(o.money.subscriptionsKobo)}</dd>
              </div>
              <div>
                <dt>Installation fees, with the first month</dt>
                <dd className="success">{naira(o.money.installKobo)}</dd>
              </div>
              <div>
                <dt>Donation fee, share kept by the platform</dt>
                <dd>{naira(o.money.donationFeeKobo)}</dd>
              </div>
              <div>
                <dt>Fines collected, after appeals</dt>
                <dd>{naira(o.money.finesKobo)}</dd>
              </div>
            </dl>
          )}
        </section>
      </div>
    </>
  );
}
