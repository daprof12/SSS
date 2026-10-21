'use client';
// Board "Agency overview": how your stations are doing today.
import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
import { api, ApiError } from '@erp/web-ui/api';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AgencySwitcher, WithAgency, type MyAgency } from '@/components/Agency';
import { ago, HBars, mmss, naira, STATE_LABEL, stateTone } from '@/components/Dash';

interface O {
  stats: { open: number; avgResponseS: number | null; acceptancePct: number | null; rating: number | null; donationsMonthKobo: number };
  live: { id: string; label: string; state: string; station: string | null; at: string }[];
  stations: { id: string; name: string; status: string; onDuty: number; open: number; rating: number | null }[];
  week: { day: string; n: number }[];
  attention: { key: string; title: string; line: string; count: string; href: string }[];
}
const tone: Record<string, string> = { critical: 'var(--color-emergency-text)', warning: 'var(--color-warning-text)', success: 'var(--color-success-text)', info: 'var(--color-signal-text)' };

export default function AgencyOverviewPage() {
  return <WithAgency>{(a) => <Overview key={a.id} agency={a} />}</WithAgency>;
}

function Overview({ agency }: { agency: MyAgency }) {
  const [o, setO] = useState<O | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      api<O>(`/agencies/${agency.id}/overview`)
        .then(setO)
        .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the overview.'));
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [agency.id]);
  const s = o?.stats;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="lede">How your stations are doing today.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <AgencySwitcher />
          <Link className="btn" href="/agency/live">
            View live map
          </Link>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Open reports</span>
          <strong className="critical">{s?.open ?? '—'}</strong>
          <small>Across all stations</small>
        </div>
        <div className="stat">
          <span>Average response</span>
          <strong className="info">{mmss(s?.avgResponseS)}</strong>
          <small>Accept to on scene</small>
        </div>
        <div className="stat">
          <span>Acceptance rate</span>
          <strong className="success">{s?.acceptancePct != null ? `${s.acceptancePct}%` : '—'}</strong>
          <small>Offers accepted in time</small>
        </div>
        <div className="stat">
          <span>Agency rating</span>
          <strong>
            <Rating value={s?.rating} size={20} empty="—" />
          </strong>
          <small>From citizens</small>
        </div>
        <div className="stat">
          <span>Donations this month</span>
          <strong className="warning">{s ? naira(s.donationsMonthKobo) : '—'}</strong>
          <small>Before platform fee</small>
        </div>
      </div>
      <div className="grid two">
        <section className="card" aria-labelledby="live">
          <h2 id="live" style={{ marginTop: 0 }}>
            Live reports for your agency
          </h2>
          {o && !o.live.length && <p className="muted">No open reports right now.</p>}
          {o?.live.map((l) => (
            <div className="row" key={l.id}>
              <div className="label">
                <strong>{l.label}</strong>
                <span>{l.station ? `${l.station}, ${ago(l.at)} ago` : 'Waiting for a station'}</span>
              </div>
              <strong style={{ color: tone[stateTone(l.state)] }}>{STATE_LABEL[l.state] ?? l.state}</strong>
            </div>
          ))}
        </section>
        <section className="card" aria-labelledby="perf">
          <h2 id="perf" style={{ marginTop: 0 }}>
            Station performance
          </h2>
          {o?.stations.map((st) => (
            <div className="row" key={st.id}>
              <div className="label">
                <strong>{st.name}</strong>
                <span>{st.onDuty ? `${st.onDuty} on duty, ${st.open} open` : 'No one on duty'}</span>
              </div>
              <strong style={{ color: !st.onDuty ? 'var(--color-emergency-text)' : (st.rating ?? 5) >= 4 ? 'var(--color-success-text)' : 'var(--color-warning-text)' }}>{!st.onDuty ? 'Offline' : <Rating value={st.rating} empty="—" />}</strong>
            </div>
          ))}
        </section>
      </div>
      <div className="grid two">
        <section className="card" aria-labelledby="week">
          <h2 id="week" style={{ marginTop: 0 }}>
            This week
          </h2>
          {o && <HBars rows={o.week.map((d) => ({ label: d.day, value: d.n }))} />}
        </section>
        <section className="card" aria-labelledby="att">
          <h2 id="att" style={{ marginTop: 0 }}>
            Needs your attention
          </h2>
          {o && !o.attention.length && <p className="muted">Nothing needs you right now.</p>}
          {o?.attention.map((a) => (
            <Link key={a.key} className="row" href={a.href} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="label">
                <strong>{a.title}</strong>
                <span>{a.line}</span>
              </div>
              <strong style={{ color: 'var(--color-warning-text)' }}>{a.count}</strong>
            </Link>
          ))}
        </section>
      </div>
    </>
  );
}
