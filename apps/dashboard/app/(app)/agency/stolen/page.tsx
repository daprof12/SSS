'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@erp/web-ui/api';
import { WithAgency, dateTime, plural, shortDate, type MyAgency } from '@/components/Agency';
import { DateRange, useDateRange } from '@/components/DateRange';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';
import { CONTEXT, STOLEN_TONE } from '@/components/StolenItems';

export interface StolenRow {
  id: string;
  publicNo: string;
  state: string;
  stateLabel: string;
  type: string;
  typeLabel: string;
  name: string;
  identifier: string;
  stolenOn: string;
  createdAt: string;
  ownershipConflict: boolean;
  postcode: string | null;
  area: string | null;
  station: string | null;
  matches: number;
  newMatches: number;
  lastMatchAt: string | null;
}
export interface MatchRow {
  id: string;
  checkNo: string;
  context: string;
  at: string;
  checker: string;
  checkerPhone: string | null;
  place: string;
  postcode: string | null;
  area: string | null;
  caseId: string;
  publicNo: string;
  caseState: string;
  ourCase: boolean;
  name: string;
  reviewed: boolean;
  details: number;
}

type Tab = 'open' | 'matches' | 'closed';
const TABS: [Tab, string][] = [
  ['open', 'Open cases'],
  ['matches', 'Buyer-check matches'],
  ['closed', 'Closed'],
];

/** Stolen items for the police: reports from owners and buyer checks that matched one. */
export default function StolenPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Stolen items</h1>
          <p className="lede">Phones, cars and laptops reported stolen, and buyers who checked one before paying. New matches first.</p>
        </div>
      </div>
      <WithAgency needs="stolen">{(a) => <Stolen key={a.id} agency={a} />}</WithAgency>
    </>
  );
}

function Stolen({ agency }: { agency: MyAgency }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('open');
  const [loc, setLoc] = useState<LocFilter>({});
  const dates = useDateRange('all');
  const [type, setType] = useState('');
  const [rows, setRows] = useState<StolenRow[] | null>(null);
  const [matches, setMatches] = useState<MatchRow[] | null>(null);
  const [matchTab, setMatchTab] = useState<'new' | 'reviewed' | 'all'>('new');
  const [newCount, setNewCount] = useState<number | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const q = [locQuery(loc), dates.q].filter(Boolean).join('&');
  useEffect(() => {
    setError(null);
    if (tab === 'matches') {
      setMatches(null);
      api<MatchRow[]>(`/agencies/${agency.id}/stolen-matches?tab=${matchTab}${q ? `&${q}` : ''}`).then(setMatches).catch(setError);
    } else {
      setRows(null);
      api<StolenRow[]>(`/agencies/${agency.id}/stolen?tab=${tab}${type ? `&type=${type}` : ''}${q ? `&${q}` : ''}`).then(setRows).catch(setError);
    }
  }, [agency.id, tab, matchTab, type, q]);
  useEffect(() => {
    api<MatchRow[]>(`/agencies/${agency.id}/stolen-matches?tab=new`).then((m) => setNewCount(m.length)).catch(() => {});
  }, [agency.id, matches]);

  const [types, setTypes] = useState<[string, string][]>([]);
  useEffect(() => {
    api<{ code: string; label: string }[]>('/item-types')
      .then((t) => setTypes(t.map((x) => [x.code, x.label])))
      .catch(() => {});
  }, []);
  const filtered = !!(q || type);
  return (
    <>
      {error && (
        <div className={`banner ${error.status === 0 ? 'warning' : 'critical'}`} role="alert">
          <strong>{error.status === 0 ? 'You are offline.' : 'Could not load stolen items'}</strong>
          {error.status === 0 ? 'Check your connection and reload.' : error.message}
        </div>
      )}
      <div className="segmented tabs" role="tablist" aria-label="Stolen items">
        {TABS.map(([t, l]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {l} {t === 'matches' && newCount ? <span className="count">{newCount} new</span> : null}
          </button>
        ))}
      </div>

      <LocationFilter value={loc} onChange={setLoc} title={tab === 'matches' ? 'Where the check was made' : 'Where it was stolen'} />
      <div className="card">
        <DateRange value={dates.range} onChange={dates.setRange} initial={dates.initial} />
      </div>

      {tab === 'matches' ? (
        <>
          <div className="chips" role="group" aria-label="Review" style={{ marginBottom: 16 }}>
            {(['new', 'reviewed', 'all'] as const).map((t) => (
              <button key={t} type="button" aria-pressed={matchTab === t} onClick={() => setMatchTab(t)}>
                {t === 'new' ? 'Not reviewed' : t === 'reviewed' ? 'Reviewed' : 'All'}
              </button>
            ))}
          </div>
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            {matches === null && !error ? (
              <div style={{ padding: 20 }}>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton" />
                ))}
              </div>
            ) : !matches?.length ? (
              <div className="empty">
                <strong>{filtered ? 'No matches for these filters.' : matchTab === 'new' ? 'No new matches.' : 'No matches yet.'}</strong>
                When someone checks a stolen item before buying it, the check appears here with where it was made.
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Item</th>
                    <th>Where it was checked</th>
                    <th>Buyer</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m) => (
                    <tr key={m.id} className="link" onClick={() => router.push(`/agency/stolen/${m.caseId}#match-${m.id}`)}>
                      <td>
                        <strong>{dateTime(m.at)}</strong>
                        <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{m.checkNo} · {CONTEXT[m.context] ?? m.context}</div>
                      </td>
                      <td>
                        <Link href={`/agency/stolen/${m.caseId}`} style={{ color: 'inherit', fontWeight: 700, textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>
                          {m.name}
                        </Link>
                        <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
                          {m.publicNo}
                          {!m.ourCase && ' · another agency’s case'}
                        </div>
                      </td>
                      <td>
                        {m.place}
                        {m.area && <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{m.area}</div>}
                      </td>
                      <td>
                        {m.checker}
                        <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{m.checkerPhone ?? ''}</div>
                      </td>
                      <td>
                        <span className={`chip ${m.reviewed ? 'neutral' : 'critical'}`}>{m.reviewed ? 'Reviewed' : 'New'}</span>
                        {m.details > 0 && <div style={{ fontSize: 12, marginTop: 4 }}>Seller details added</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <>
          {types.length > 1 && (
            <div className="chips" role="group" aria-label="Item type" style={{ marginBottom: 16 }}>
              <button type="button" aria-pressed={!type} onClick={() => setType('')}>
                All
              </button>
              {types.map(([code, label]) => (
                <button key={code} type="button" aria-pressed={type === code} onClick={() => setType(code)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            {rows === null && !error ? (
              <div style={{ padding: 20 }}>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="skeleton" />
                ))}
              </div>
            ) : !rows?.length ? (
              <div className="empty">
                <strong>{filtered ? 'No cases match these filters.' : tab === 'open' ? 'No open stolen-item cases.' : 'No closed cases yet.'}</strong>
                {filtered ? 'Clear a filter to see more.' : 'Citizens’ stolen-item reports in your area appear here.'}
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Identifier</th>
                    <th>Stolen</th>
                    <th>Buyer checks</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="link" onClick={() => router.push(`/agency/stolen/${r.id}`)}>
                      <td>
                        <Link href={`/agency/stolen/${r.id}`} style={{ color: 'inherit', fontWeight: 700, textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>
                          {r.name}
                        </Link>
                        <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
                          {r.typeLabel} · {r.publicNo}
                          {r.ownershipConflict && <span style={{ color: 'var(--color-warning-text)', fontWeight: 600 }}> · ownership disputed</span>}
                        </div>
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 13 }}>{r.identifier}</td>
                      <td>
                        {shortDate(r.stolenOn)}
                        <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{[r.postcode ?? 'GPS only', r.area].filter(Boolean).join(', ')}</div>
                      </td>
                      <td>
                        {r.newMatches > 0 ? <span className="chip critical">{plural(r.newMatches, 'new match', 'new matches')}</span> : r.matches ? plural(r.matches, 'check') : '—'}
                        {r.lastMatchAt && <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>Last {dateTime(r.lastMatchAt)}</div>}
                      </td>
                      <td>
                        <span className={`chip ${STOLEN_TONE[r.state] ?? 'neutral'}`}>{r.stateLabel}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}
