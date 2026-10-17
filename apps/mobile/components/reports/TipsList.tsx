'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/client';

interface Row {
  id: string;
  publicNo: string;
  category: string;
  state: string;
  status: { chip: string; tone: string };
  bounty: string | null;
  createdAt: string;
}
type Tab = 'all' | 'waiting' | 'paid' | 'declined';

/** My tips (States doc (1): All, Waiting, Paid, Declined). */
export function TipsList({ base, back }: { base: string; back: string | false }) {
  const [tab, setTab] = useState<Tab>('all');
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    setRows(null);
    api<Row[]>(`/me/tips?tab=${tab}`).then(setRows).catch(() => setRows([]));
  }, [tab]);
  return (
    <main className="app">
      <Header title="My tips" back={back} />
      <div className="tabs" role="tablist">
        {(['all', 'waiting', 'paid', 'declined'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {!rows && [0, 1].map((i) => <div key={i} className="skeleton" />)}
      {rows?.length === 0 && (
        <div className="empty">
          <strong>No tips yet.</strong>
          Tips that lead to a result can earn a bounty.
        </div>
      )}
      {rows?.map((r) => (
        <Link key={r.id} href={`${base}/${r.id}`} className={`inc sev-${r.status.tone === 'success' ? 'success' : r.status.tone === 'warning' ? 'warning' : 'info'}`}>
          <span className="grow">
            <strong style={{ textTransform: 'none' }}>{r.category}</strong>
            <span className="sub">
              {r.publicNo} · {new Date(r.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}
              {r.bounty ? ` · ${r.bounty}` : ''}
            </span>
          </span>
          <span className={`chip ${r.status.tone}`}>{r.status.chip}</span>
        </Link>
      ))}
      <Link href={`${base}/new`} className="btn block primary" style={{ marginTop: 12 }}>
        <Icon name="tip" /> Report a tip
      </Link>
    </main>
  );
}
