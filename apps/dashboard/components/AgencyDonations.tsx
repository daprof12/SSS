'use client';
// "Donations": gifts from citizens to an agency (it, its stations and its officers) or to a station
// (it and its officers). Totals by who received them, for the dates chosen, and each gift. Donors who
// chose to stay anonymous stay so. Read only.
import { formatNaira } from '@erp/domain';
import { api, ApiError } from '@erp/web-ui/api';
import { useEffect, useState } from 'react';
import { dateTime } from './Agency';
import { DateRange, useDateRange } from './DateRange';

type Level = 'agency' | 'station' | 'officer';
interface View {
  feePct: number;
  totals: { gifts: number; kobo: number; netKobo: number; agencyKobo: number; stationsKobo: number; officersKobo: number; waitingKobo: number };
  items: { id: string; at: string; donor: string; level: Level; recipient: string; station: string | null; amountKobo: number; netKobo: number; payout: string }[];
}
const naira = (k: number) => formatNaira(k).replace(/\.00$/, '');
const LEVEL: Record<Level, string> = { agency: 'Whole agency', station: 'Station', officer: 'Officer' };
const PAYOUT: Record<string, [string, string]> = {
  queued: ['Waiting for payout', 'var(--color-warning-text)'],
  paid: ['Paid out', 'var(--color-success-text)'],
  failed: ['Payout failed', 'var(--color-emergency-text)'],
};

export function AgencyDonations({ agencyId }: { agencyId: string }) {
  return <Donations path={`/agencies/${agencyId}/donations`} scope="agency" />;
}

export function Donations({ path, scope }: { path: string; scope: 'agency' | 'station' }) {
  const dates = useDateRange('30d');
  const [level, setLevel] = useState<'' | Level>('');
  const [v, setV] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (dates.q === null) return;
    const q = [dates.q, level && `level=${level}`].filter(Boolean).join('&');
    api<View>(`${path}${q ? `?${q}` : ''}`)
      .then((x) => (setV(x), setError(null)))
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load donations.'));
  }, [path, dates.q, level]);
  const t = v?.totals;
  return (
    <section className="card" aria-labelledby="don">
      <h2 id="don" style={{ marginTop: 0 }}>
        Donations to your {scope}
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {scope === 'agency' ? 'Gifts from citizens to the agency, its stations and its officers.' : 'Gifts from citizens to the station and its officers.'} The platform keeps {v?.feePct ?? 10}%; the rest is paid to each one&apos;s wallet in the weekly run.
      </p>
      <div style={{ marginBottom: 12 }}>
        <DateRange value={dates.range} onChange={dates.setRange} initial={dates.initial} />
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="stats">
        <div className="stat">
          <span>Received</span>
          <strong className="success">{t ? naira(t.kobo) : '—'}</strong>
          <small>{t ? `${t.gifts} ${t.gifts === 1 ? 'gift' : 'gifts'}, ${naira(t.netKobo)} after fee` : ' '}</small>
        </div>
        {scope === 'agency' && (
          <div className="stat">
            <span>To the agency</span>
            <strong>{t ? naira(t.agencyKobo) : '—'}</strong>
            <small>Whole agency</small>
          </div>
        )}
        <div className="stat">
          <span>{scope === 'agency' ? 'To stations' : 'To the station'}</span>
          <strong>{t ? naira(t.stationsKobo) : '—'}</strong>
          <small>{scope === 'agency' ? 'Your stations' : 'For the station'}</small>
        </div>
        <div className="stat">
          <span>To officers</span>
          <strong>{t ? naira(t.officersKobo) : '—'}</strong>
          <small>Your officers</small>
        </div>
        <div className="stat">
          <span>Waiting for payout</span>
          <strong className="warning">{t ? naira(t.waitingKobo) : '—'}</strong>
          <small>After fee</small>
        </div>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Given to" style={{ margin: '4px 0 12px' }}>
        {(scope === 'agency' ? (['', 'agency', 'station', 'officer'] as const) : (['', 'station', 'officer'] as const)).map((l) => (
          <button key={l || 'all'} type="button" role="radio" aria-checked={level === l} aria-pressed={level === l} onClick={() => setLevel(l)}>
            {l ? LEVEL[l] : 'All'}
          </button>
        ))}
      </div>
      {v && !v.items.length && <p className="muted">No donations in these dates.</p>}
      {!!v?.items.length && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Donor</th>
                <th>Given to</th>
                <th>Amount</th>
                <th>Payout</th>
              </tr>
            </thead>
            <tbody>
              {v.items.map((x) => (
                <tr key={x.id}>
                  <td>
                    <strong>{x.donor}</strong>
                    <div className="muted">{dateTime(x.at)}</div>
                  </td>
                  <td>
                    <strong>{x.recipient}</strong>
                    <div className="muted">
                      {LEVEL[x.level]}
                      {x.station ? `, ${x.station}` : ''}
                    </div>
                  </td>
                  <td>
                    <strong>{naira(x.amountKobo)}</strong>
                    <div className="muted">{naira(x.netKobo)} after fee</div>
                  </td>
                  <td>
                    <strong style={{ color: PAYOUT[x.payout]?.[1] }}>{PAYOUT[x.payout]?.[0] ?? x.payout}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
