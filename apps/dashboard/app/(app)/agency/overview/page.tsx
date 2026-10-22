'use client';
// Board "Agency overview": how your stations are doing today.
import { LinkButton } from '@erp/web-ui/LinkButton';
import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
import { api, ApiError } from '@erp/web-ui/api';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { WithAgency, type MyAgency } from '@/components/Agency';
import { DateRange, useDateRange } from '@/components/DateRange';
import { mmss, naira } from '@/components/Dash';
import { MixChart, MixLatest, MixStats, type Mix } from '@/components/ReportMix';

interface O {
  stats: { open: number; avgResponseS: number | null; acceptancePct: number | null; rating: number | null; donationsMonthKobo: number };
  reports: Mix;
  stations: { id: string; name: string; status: string; onDuty: number; open: number; rating: number | null }[];
  attention: { key: string; title: string; line: string; count: string; href: string }[];
}

export default function AgencyOverviewPage() {
  return <WithAgency>{(a) => <Overview key={a.id} agency={a} />}</WithAgency>;
}

function Overview({ agency }: { agency: MyAgency }) {
  const [o, setO] = useState<O | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dates = useDateRange('7d');
  useEffect(() => {
    if (dates.q === null) return;
    const load = () =>
      api<O>(`/agencies/${agency.id}/overview${dates.q ? `?${dates.q}` : ''}`)
        .then((x) => (setO(x), setError(null)))
        .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the overview.'));
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [agency.id, dates.q]);
  const s = o?.stats;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="lede">Emergencies{agency.handles.tips ? ', tips' : ''}{agency.handles.issues ? ' and public issues' : ''} for {agency.name}, and how your stations are doing.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <LinkButton className="btn" href="/agency/live">
            View live map
          </LinkButton>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="card">
        <DateRange value={dates.range} onChange={dates.setRange} initial={dates.initial} allowAll={false} />
      </div>
      <div className="stats">
        <MixStats m={o?.reports} />
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
            Latest open reports
          </h2>
          {o ? <MixLatest m={o.reports} /> : <div className="skeleton" />}
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
            Reports received
          </h2>
          {o ? <MixChart m={o.reports} /> : <div className="skeleton" />}
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
