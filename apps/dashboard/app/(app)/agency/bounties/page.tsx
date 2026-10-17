'use client';

import { formatNaira } from '@erp/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@erp/web-ui/api';
import { AgencySwitcher, WithAgency, dateTime, useToast, type MyAgency } from '@/components/Agency';
import { FundSheet, RateSheet, naira, type PoolSummary } from '@/components/BountyPool';
import { TipStateChip, outcomeLabel } from '@/components/IssueChips';

interface TipRow {
  id: string;
  publicNo: string;
  category: string;
  state: string;
  description: string;
  place: string | null;
  tipper: string;
  outcome: string | null;
  bountyKobo: number | null;
  createdAt: string;
}

type Tab = 'new' | 'claims' | 'closed';
const TABS: Array<[Tab, string]> = [
  ['new', 'New'],
  ['claims', 'Claims'],
  ['closed', 'Closed'],
];
const EMPTY: Record<Tab, [string, string]> = {
  new: ['No new tips.', 'Tips citizens send to your agency appear here.'],
  claims: ['No claims to review.', 'When you record a result on a tip, its bounty claim waits here.'],
  closed: ['Nothing closed yet.', 'Paid, declined and closed tips are kept here.'],
};

/** Tips, bounty rates, the pool the agency funds, and claims (board "Agency bounties"). */
export default function BountiesPage() {
  return <WithAgency needs="tips">{(a) => <Bounties key={a.id} agency={a} />}</WithAgency>;
}

function Bounties({ agency }: { agency: MyAgency }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (sessionStorage.getItem('erp-bounty-tab') as Tab) || 'new';
    } catch {
      return 'new';
    }
  });
  const [data, setData] = useState<Partial<Record<Tab, TipRow[]>>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [pool, setPool] = useState<PoolSummary | null>(null);
  const [sheet, setSheet] = useState<{ kind: 'fund' } | { kind: 'rate'; category: string } | null>(null);
  const [toast, setToast] = useToast();
  const [n, setN] = useState(0);
  const reload = () => setN((x) => x + 1);

  useEffect(() => {
    if (!agency.handles.bounties) return;
    api<PoolSummary>(`/agencies/${agency.id}/bounties/summary`).then(setPool).catch(setError);
  }, [agency.id, agency.handles.bounties, n]);

  useEffect(() => {
    // All three tabs at once so the counts are right.
    Promise.all(TABS.map(([t]) => api<TipRow[]>(`/agencies/${agency.id}/tips?tab=${t}`)))
      .then(([n, c, d]) => {
        setData({ new: n, claims: c, closed: d });
        setError(null);
      })
      .catch(setError);
  }, [agency.id, n]);

  const pick = (t: Tab) => {
    setTab(t);
    try {
      sessionStorage.setItem('erp-bounty-tab', t);
    } catch {}
  };
  const rows = data[tab];
  const paid = (data.closed ?? []).filter((r) => ['approved_held', 'available'].includes(r.state));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Bounties</h1>
          <p className="lede">{agency.handles.bounties ? 'What you pay people whose tips lead to a verified result.' : 'Tips citizens send to your agency.'}</p>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <AgencySwitcher />
          {agency.handles.bounties && (
            <button className="btn primary" type="button" disabled={!pool || pool.closed} title={pool?.closed ? 'Your agency is leaving, so the pool is closed.' : undefined} onClick={() => setSheet({ kind: 'fund' })}>
              Fund bounty pool
            </button>
          )}
        </div>
      </div>
      {sheet?.kind === 'fund' && pool && (
        <FundSheet
          agencyId={agency.id}
          summary={pool}
          onClose={() => {
            setSheet(null);
            reload();
          }}
          onFunded={(m) => {
            setSheet(null);
            setToast(m);
            reload();
          }}
        />
      )}
      {sheet?.kind === 'rate' && pool && (
        <RateSheet
          agencyId={agency.id}
          rates={pool.rates}
          initial={sheet.category}
          onClose={() => setSheet(null)}
          onSaved={(m) => {
            setSheet(null);
            setToast(m);
            reload();
          }}
        />
      )}
      {toast}
      {error && (
        <div className={`banner ${error.status === 0 ? 'warning' : 'critical'}`} role="alert">
          <strong>{error.status === 0 ? 'You are offline.' : 'Could not load tips'}</strong>
          {error.status === 0 ? 'Check your connection and reload.' : error.message}
        </div>
      )}

      {pool?.payout && (
        <div className={`banner ${pool.payout.state === 'failed' ? 'critical' : pool.payout.state === 'paid' ? 'success' : 'info'}`} role="status">
          <strong>
            {pool.payout.state === 'paid' ? 'Pool paid back' : 'Paying your pool back'}: {naira(pool.payout.amountKobo)}
          </strong>
          {pool.payout.line}
          {pool.payout.reason && pool.payout.state === 'failed' ? ` (${pool.payout.reason})` : ''}
        </div>
      )}
      {pool?.pool.low && !pool.closed && (
        <div className="banner warning" role="status">
          <strong>Pool low</strong>
          {pool.pool.low}{' '}
          <button className="link-btn" type="button" onClick={() => setSheet({ kind: 'fund' })}>
            Add funds
          </button>
        </div>
      )}

      <div className="stats">
        {agency.handles.bounties ? (
          <div className="stat">
            <span>Bounty pool</span>
            <strong className="pool-amount">{pool ? naira(pool.pool.availableKobo) : '—'}</strong>
            <small>Paid out of this</small>
          </div>
        ) : (
          <div className="stat">
            <span>New tips</span>
            <strong>{data.new?.length ?? '—'}</strong>
            <small>Waiting for you to act</small>
          </div>
        )}
        <div className="stat">
          <span>Claims waiting</span>
          <strong className={data.claims?.length ? 'warning' : undefined}>{data.claims?.length ?? '—'}</strong>
          <small>Outcome recorded</small>
        </div>
        {agency.handles.bounties && (
          <div className="stat">
            <span>Paid this month</span>
            <strong>{pool ? naira(pool.paidThisMonth.kobo) : '—'}</strong>
            <small>{pool ? (pool.paidThisMonth.tips === 1 ? '1 tip' : `${pool.paidThisMonth.tips} tips`) : ''}</small>
          </div>
        )}
        <div className="stat">
          <span>Tips received</span>
          <strong className="info">{pool ? pool.tipsThisMonth : (data.new?.length ?? '—')}</strong>
          <small>{pool ? 'This month' : 'Waiting for you to act'}</small>
        </div>
      </div>

      {pool && (
        <div className="bounty-grid">
          <section className="card" aria-labelledby="rates" style={{ overflowX: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <h2 id="rates" style={{ margin: 0 }}>
                Bounty rates
              </h2>
              <button className="btn" type="button" onClick={() => setSheet({ kind: 'rate', category: pool.rates[0]!.category })}>
                Add or change a rate
              </button>
            </div>
            <table className="table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Tip category</th>
                  <th>Counts as verified when</th>
                  <th>Basis</th>
                  <th>Bounty</th>
                </tr>
              </thead>
              <tbody>
                {pool.rates.map((r) => (
                  <tr key={r.category} className="link" onClick={() => setSheet({ kind: 'rate', category: r.category })}>
                    <td style={{ fontWeight: 700 }}>{r.label}</td>
                    <td>{r.verifiedWhen}</td>
                    <td>{!r.set ? '—' : r.basis === 'tiered' ? 'Tiered' : r.basis === 'percent_capped' ? '% of value' : 'Fixed'}</td>
                    <td>
                      {!r.set ? (
                        <span className="muted" title="No rate set, so this category pays no bounty.">No rate set</span>
                      ) : !r.active ? (
                        <span className="chip neutral">Paused</span>
                      ) : r.basis === 'percent_capped' ? (
                        `${r.percent}%`
                      ) : r.basis === 'tiered' && r.seriousKobo !== r.standardKobo ? (
                        `${naira(r.standardKobo!)} to ${naira(r.seriousKobo!)}`
                      ) : (
                        naira(r.standardKobo!)
                      )}
                      {r.set && r.active && r.capKobo != null && <div className="muted">cap {naira(r.capKobo)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card" aria-labelledby="pool-history">
            <h2 id="pool-history" style={{ marginTop: 0 }}>
              Pool activity
            </h2>
            {pool.pendingFunding.map((f) => (
              <div key={f.reference} className="row" style={{ cursor: 'default' }}>
                <span style={{ flex: 1 }}>
                  Confirming payment
                  <small className="muted" style={{ display: 'block' }}>
                    {dateTime(f.since)}
                  </small>
                </span>
                <span className="chip warning">{naira(f.amountKobo)}</span>
              </div>
            ))}
            {!pool.history.length && !pool.pendingFunding.length ? (
              <p className="muted">Nothing yet. Fund the pool so you can approve bounties.</p>
            ) : (
              pool.history.slice(0, 8).map((h, i) => (
                <div key={`${h.at}-${i}`} className="row" style={{ cursor: 'default' }}>
                  <span style={{ flex: 1 }}>
                    {h.label}
                    <small className="muted" style={{ display: 'block' }}>
                      {dateTime(h.at)}
                    </small>
                  </span>
                  <span className={`ledger-amount ${h.amountKobo > 0 ? 'in' : ''}`}>
                    {h.amountKobo > 0 ? '+' : '−'}
                    {naira(Math.abs(h.amountKobo))}
                  </span>
                </div>
              ))
            )}
          </section>
        </div>
      )}

      <div className="segmented tabs" role="tablist" aria-label="Tips">
        {TABS.map(([t, l]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} aria-pressed={tab === t} onClick={() => pick(t)}>
            {l} {data[t] && <span className="count">{data[t]!.length}</span>}
          </button>
        ))}
      </div>

      <div className="card" role="tabpanel" style={{ padding: 0, overflowX: 'auto' }}>
        {!rows && !error ? (
          <div style={{ padding: 20 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        ) : !rows?.length ? (
          <div className="empty">
            <strong>{EMPTY[tab][0]}</strong>
            {EMPTY[tab][1]}
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Tip</th>
                <th>Tipper</th>
                {tab === 'new' ? <th>Place</th> : <th>Outcome</th>}
                {tab !== 'new' && <th>Bounty</th>}
                <th>State</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="link" onClick={() => router.push(`/agency/tips/${r.id}`)}>
                  <td>
                    <Link href={`/agency/tips/${r.id}`} style={{ color: 'inherit', fontWeight: 700, textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>
                      Tip {r.publicNo}
                    </Link>
                    <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>{r.category}</div>
                  </td>
                  <td>{r.tipper}</td>
                  {tab === 'new' ? <td>{r.place ?? '—'}</td> : <td>{outcomeLabel(r.outcome) ?? 'No result'}</td>}
                  {tab !== 'new' && <td>{r.bountyKobo && r.state !== 'declined' ? formatNaira(r.bountyKobo).replace('.00', '') : '—'}</td>}
                  <td>
                    <TipStateChip state={r.state} />
                  </td>
                  <td>{dateTime(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
