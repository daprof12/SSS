'use client';
// Station "Payouts and donations" (station head, read only): rewards this station's officers earned
// for rated responses, and gifts from citizens to the station and its officers. The agency sets the
// reward rule and how donations are shared.
import { formatNaira } from '@erp/domain';
import { Rating } from '@erp/web-ui/Rating';
import { api, ApiError } from '@erp/web-ui/api';
import { useEffect, useState } from 'react';
import { dateTime } from '@/components/Agency';
import { Donations } from '@/components/AgencyDonations';
import { DateRange, useDateRange } from '@/components/DateRange';

interface View {
  station: string;
  agency: string;
  rule: { active: boolean; fiveStarKobo: number; fourStarPct: number; split: 'equal' | 'lead_first' } | null;
  holdDays: number;
  totals: { kobo: number; paid: number; skipped: number };
  officers: { id: string; name: string; kobo: number; responses: number }[];
  recent: { incidentId: string; title: string; stars: number; state: 'paid' | 'skipped'; reason: string | null; totalKobo: number; officers: { name: string; kobo: number }[]; at: string }[];
}
type Tab = 'payouts' | 'donations';
const naira = (k: number) => formatNaira(k).replace(/\.00$/, '');

export default function StationPayoutsPage() {
  const [tab, setTab] = useState<Tab>('payouts');
  useEffect(() => {
    if (window.location.hash === '#donations') setTab('donations');
  }, []);
  const pick = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', t === 'donations' ? '#donations' : window.location.pathname);
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Payouts and donations</h1>
          <p className="lede">
            {tab === 'payouts' ? 'Rewards your officers earned for rated responses. Your agency sets the reward.' : 'Gifts from citizens to your station and its officers.'}
          </p>
        </div>
      </div>
      <div className="segmented tabs" role="tablist" aria-label="Payouts and donations">
        {(
          [
            ['payouts', 'Payouts'],
            ['donations', 'Donations'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => pick(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'payouts' ? <Payouts /> : <Donations path="/me/station/donations" scope="station" />}
    </>
  );
}

function Payouts() {
  const dates = useDateRange('30d');
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (dates.q === null) return;
    api<View>(`/me/station/payouts${dates.q ? `?${dates.q}` : ''}`)
      .then((x) => (setV(x), setError(null)))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load payouts.'));
  }, [dates.q]);
  const r = v?.rule;
  return (
    <>
      <div className="card">
        <DateRange value={dates.range} onChange={dates.setRange} initial={dates.initial} />
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Rewards paid</span>
          <strong className="success">{v ? naira(v.totals.kobo) : '—'}</strong>
          <small>{v ? `${v.totals.paid} ${v.totals.paid === 1 ? 'response' : 'responses'} in these dates` : ' '}</small>
        </div>
        <div className="stat">
          <span>Not paid</span>
          <strong>{v?.totals.skipped ?? '—'}</strong>
          <small>Low rating, caps or checks</small>
        </div>
        <div className="stat">
          <span>Reward for 5 stars</span>
          <strong className="warning">{v ? (r?.active ? naira(r.fiveStarKobo) : 'Off') : '—'}</strong>
          <small>{v ? (r?.active ? `4 stars earn ${r.fourStarPct}%. Held ${v.holdDays} days.` : `${v.agency} has not turned rewards on`) : ' '}</small>
        </div>
      </div>
      <div className="grid two">
        <section className="card" aria-labelledby="by">
          <h2 id="by" style={{ marginTop: 0 }}>
            By officer
          </h2>
          {v && !v.officers.length && <p className="muted">No officers at this station yet.</p>}
          {v?.officers.map((o) => (
            <div className="row" key={o.id}>
              <div className="label">
                <strong>{o.name}</strong>
                <span>{o.responses ? `${o.responses} rewarded ${o.responses === 1 ? 'response' : 'responses'}` : 'No rewards in these dates'}</span>
              </div>
              <strong className={o.kobo ? 'success' : undefined}>{naira(o.kobo)}</strong>
            </div>
          ))}
          <p className="muted" style={{ marginBottom: 0 }}>
            {r ? (r.split === 'lead_first' ? 'A team response pays the lead officer half; the rest share the other half.' : 'A team response is shared equally.') : ''} Rewards go to each officer&apos;s wallet.
          </p>
        </section>
        <section className="card" aria-labelledby="recent" style={{ overflowX: 'auto' }}>
          <h2 id="recent" style={{ marginTop: 0 }}>
            Recent rated responses
          </h2>
          {v && !v.recent.length && <p className="muted">No rated responses in these dates.</p>}
          {v?.recent.map((x) => (
            <div className="row" key={x.incidentId}>
              <div className="label">
                <strong>{x.title}</strong>
                <span>
                  {dateTime(x.at)} · {x.officers.length ? x.officers.map((o) => `${o.name} ${naira(o.kobo)}`).join(', ') : x.reason}
                </span>
              </div>
              <span style={{ display: 'grid', justifyItems: 'end', gap: 4 }}>
                <Rating value={x.stars} />
                {x.state === 'paid' ? <span className="chip success">{naira(x.totalKobo)}</span> : <span className="chip neutral">Not paid</span>}
              </span>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
