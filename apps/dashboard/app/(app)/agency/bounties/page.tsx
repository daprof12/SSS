'use client';

import { formatNaira } from '@erp/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@erp/web-ui/api';
import { AgencySwitcher, WithAgency, dateTime, type MyAgency } from '@/components/Agency';
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

/** Tips and bounty claims for the agency (board "Agency bounties"). */
export default function BountiesPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Bounties</h1>
          <p className="lede">Tips from citizens, and what you pay when a tip leads to a verified result.</p>
        </div>
        <AgencySwitcher />
      </div>
      <WithAgency>{(a) => <Bounties key={a.id} agency={a} />}</WithAgency>
    </>
  );
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

  useEffect(() => {
    // All three tabs at once so the counts are right.
    Promise.all(TABS.map(([t]) => api<TipRow[]>(`/agencies/${agency.id}/tips?tab=${t}`)))
      .then(([n, c, d]) => {
        setData({ new: n, claims: c, closed: d });
        setError(null);
      })
      .catch(setError);
  }, [agency.id]);

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
      {error && (
        <div className={`banner ${error.status === 0 ? 'warning' : 'critical'}`} role="alert">
          <strong>{error.status === 0 ? 'You are offline.' : 'Could not load tips'}</strong>
          {error.status === 0 ? 'Check your connection and reload.' : error.message}
        </div>
      )}

      <div className="stats">
        <div className="stat">
          <span>New tips</span>
          <strong>{data.new?.length ?? '—'}</strong>
          <small>Waiting for you to act</small>
        </div>
        <div className="stat">
          <span>Claims waiting</span>
          <strong className={data.claims?.length ? 'warning' : undefined}>{data.claims?.length ?? '—'}</strong>
          <small>Result recorded</small>
        </div>
        <div className="stat">
          <span>Bounties paid</span>
          <strong className="success">{data.closed ? formatNaira(paid.reduce((s, r) => s + (r.bountyKobo ?? 0), 0)).replace('.00', '') : '—'}</strong>
          <small>{paid.length === 1 ? '1 tip' : `${paid.length} tips`}</small>
        </div>
      </div>

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
