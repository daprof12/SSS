'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError } from '@/lib/client';

interface Entry {
  id: number;
  type: string;
  amount: string;
  amountKobo: number;
  held: boolean;
  availableAt: string;
  memo: string | null;
  at: string;
}
interface Wallet {
  available: string;
  held: string;
  heldKobo: number;
  bank: { bankName: string; lastFour: string; nameMatches: boolean } | null;
  pendingFunding: Array<{ reference: string; amountKobo: number }>;
  entries: Entry[];
}

const LABEL: Record<string, string> = {
  fund: 'Wallet funded',
  bounty: 'Bounty received',
  reward: 'Reward',
  donation_in: 'Donation share',
  donation_out: 'Donation',
  withdrawal: 'Withdrawal to bank',
  withdrawal_reversal: 'Withdrawal returned',
  payment: 'Payment',
  fine: 'Fine paid',
  refund: 'Refund',
};

/** Wallet (board "Wallet"; States doc tabs). Citizens get All / Money in / Money out; officers add Rewards and Bounties. */
export function WalletView({ base, back, tabs, canFund }: { base: string; back: string | false; tabs: Array<[string, string]>; canFund: boolean }) {
  const [tab, setTab] = useState(tabs[0]![0]);
  const [w, setW] = useState<Wallet | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Wallet>(`/me/wallet?tab=${tab}`)
      .then((x) => {
        setW(x);
        setErr(null);
      })
      .catch((e: ApiError) => setErr(e.message));
  }, [tab]);

  return (
    <main className="app">
      <Header title="Wallet" back={back} />
      <div className="card">
        <span className="muted">Available</span>
        <div className="big-number">{w ? w.available : '…'}</div>
        {w && w.heldKobo > 0 && <span style={{ color: 'var(--color-warning-text)', fontWeight: 600 }}>{w.held} pending, released after the hold</span>}
      </div>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        {canFund && (
          <Link href={`${base}/fund`} className="btn signal">
            Fund wallet
          </Link>
        )}
        <Link href={`${base}/withdraw`} className="btn">
          Withdraw
        </Link>
      </div>
      {w && (
        <div className="list">
          <div className="row" style={{ cursor: 'default' }}>
            <span className="icon">
              <Icon name="shield" />
            </span>
            <span className="grow">
              <strong>{w.bank ? `${w.bank.bankName}, ending ${w.bank.lastFour}` : 'No bank account yet'}</strong>
              <span className="sub">{w.bank ? (w.bank.nameMatches ? 'Name matches your verified identity' : 'Name does not match your ID') : 'Add an account in your own name to withdraw'}</span>
            </span>
          </div>
        </div>
      )}
      {w && w.pendingFunding.length > 0 && (
        <Link href={`${base}/confirm/${w.pendingFunding[0]!.reference}`} className="banner info" style={{ display: 'block', textDecoration: 'none' }}>
          <strong>A payment is still confirming</strong>
          Tap to check it.
        </Link>
      )}
      <div className="tabs" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {err && (
        <div className="banner critical" role="alert">
          {err}
        </div>
      )}
      {!w && !err && [0, 1, 2].map((i) => <div key={i} className="skeleton" />)}
      {w && w.entries.length === 0 && (
        <div className="empty">
          <strong>No activity yet.</strong>
          {canFund ? 'Fund your wallet or earn rewards and bounties.' : 'Rewards arrive after rated responses.'}
        </div>
      )}
      {w && w.entries.length > 0 && (
        <div className="list">
          {w.entries.map((e) => (
            <div key={e.id} className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>{LABEL[e.type] ?? e.type}</strong>
                <span className="sub">
                  {e.memo ?? ''}
                  {e.memo ? ' · ' : ''}
                  {new Date(e.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}
                  {e.held ? ` · released ${new Date(e.availableAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : ''}
                </span>
              </span>
              <strong style={{ color: e.amountKobo > 0 ? 'var(--color-success-text)' : 'var(--color-text-primary)' }}>{e.amount}</strong>
            </div>
          ))}
        </div>
      )}
      <p className="muted">Withdrawals go only to a bank account in your verified name.</p>
    </main>
  );
}
