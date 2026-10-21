'use client';

import { formatNaira } from '@erp/domain';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/client';

interface Item {
  reference: string;
  receiptNo: string | null;
  what: string;
  amountKobo: number;
  method: string;
  state: 'succeeded' | 'pending' | 'failed' | 'refunded';
  at: string;
}
const TABS = [
  ['all', 'All'],
  ['donations', 'Donations'],
  ['fines', 'Fines'],
  ['wallet', 'Top-ups'],
  ['home', 'Home plan'],
] as const;
const STATE = { succeeded: ['Paid', 'success'], pending: ['Confirming', 'warning'], failed: ['Failed', 'critical'], refunded: ['Refunded', 'neutral'] } as const;
const ICON: Record<string, string> = { Donation: 'heart', Fine: 'flag', 'Wallet top-up': 'wallet', 'Home plan': 'home', 'Installation fee': 'home' };

/** Payments and receipts (PAY-3): every payment you made, each with a receipt. */
export default function Payments() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('all');
  const [d, setD] = useState<{ totalPaidKobo: number; items: Item[] } | null>(null);
  useEffect(() => {
    setD(null);
    api<{ totalPaidKobo: number; items: Item[] }>(`/me/payments?tab=${tab}`)
      .then(setD)
      .catch(() => setD({ totalPaidKobo: 0, items: [] }));
  }, [tab]);
  return (
    <main className="app">
      <Header title="Payments and receipts" back="/profile" />
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {d && d.items.length > 0 && (
        <p className="muted" style={{ marginTop: 0 }}>
          Paid {formatNaira(d.totalPaidKobo)} in total{tab === 'all' ? '' : ' here'}.
        </p>
      )}
      {!d && [0, 1, 2].map((i) => <div key={i} className="skeleton" />)}
      {d?.items.length === 0 && (
        <div className="empty">
          <strong>No payments yet.</strong>
          Donations, fines, top-ups and your home plan show here, each with a receipt.
        </div>
      )}
      {!!d?.items.length && (
        <div className="list">
          {d.items.map((x) => (
            <Link key={x.reference} className="row" href={`/payments/${encodeURIComponent(x.reference)}`}>
              <span className="icon">
                <Icon name={ICON[x.what] ?? 'money'} />
              </span>
              <span className="grow">
                <strong>{x.what}</strong>
                <span className="sub">
                  {new Date(x.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · {x.method}
                  {x.receiptNo ? ` · ${x.receiptNo}` : ''}
                </span>
              </span>
              <span style={{ display: 'grid', justifyItems: 'end', gap: 4 }}>
                <strong>{formatNaira(x.amountKobo)}</strong>
                <span className={`chip ${STATE[x.state][1]}`}>{STATE[x.state][0]}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
