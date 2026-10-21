'use client';

import { formatNaira } from '@erp/domain';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, use, useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, haptic } from '@/lib/client';

interface Receipt {
  receiptNo: string | null;
  reference: string;
  state: 'succeeded' | 'pending' | 'initiated' | 'failed' | 'refunded' | 'abandoned';
  what: string;
  amountKobo: number;
  method: string;
  paidAt: string | null;
  createdAt: string;
  from: string;
  to: string;
  detail: string | null;
  failureReason: string | null;
}

/** A receipt. While Paystack has not confirmed, it waits for the webhook (never the browser callback). */
export default function ReceiptPage({ params }: { params: Promise<{ ref: string }> }) {
  return (
    <Suspense>
      <ReceiptView params={params} />
    </Suspense>
  );
}

function ReceiptView({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  const thanks = useSearchParams().get('thanks') === '1';
  const [r, setR] = useState<Receipt | null | undefined>(undefined);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let stop = false;
    const started = Date.now();
    const poll = async () => {
      const x = await api<Receipt>(`/me/receipts/${encodeURIComponent(ref)}`).catch(() => null);
      if (stop) return;
      setR(x);
      if (!x || !['pending', 'initiated'].includes(x.state)) {
        if (x?.state === 'succeeded') haptic([40, 30, 40]);
        return;
      }
      if (Date.now() - started > 30000) return setSlow(true);
      setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [ref]);

  if (r === null) {
    return (
      <main className="app">
        <Header title="Receipt" back="/payments" />
        <div className="empty">
          <strong>Receipt not found.</strong>
          <Link href="/payments">See all payments</Link>
        </div>
      </main>
    );
  }
  if (!r) return <main className="app">{<div className="skeleton" style={{ height: 300 }} />}</main>;

  const waiting = r.state === 'pending' || r.state === 'initiated';
  return (
    <main className="app">
      <Header title={r.receiptNo ? `Receipt ${r.receiptNo}` : 'Payment'} back="/payments" />
      {waiting && (
        <div className="banner info" role="status">
          <strong>Confirming your payment</strong>
          {slow ? 'This is taking longer than usual. You will get a notification when it is confirmed.' : 'This takes a few seconds.'}
        </div>
      )}
      {r.state === 'failed' && (
        <div className="banner critical" role="alert">
          <strong>Payment failed</strong>
          {r.failureReason} You were not charged.
        </div>
      )}
      {r.state === 'succeeded' && thanks && (
        <div className="done-state center" style={{ margin: '8px 0 16px' }}>
          <div className="check">
            <Icon name="check" size={40} />
          </div>
          <h2 style={{ margin: '8px 0 0' }}>Thank you</h2>
          <p className="muted" style={{ margin: 0 }}>
            {formatNaira(r.amountKobo)} went to {r.to}.
          </p>
        </div>
      )}
      <div className="card" style={{ textAlign: 'center' }}>
        <span className="muted">{r.what}</span>
        <div style={{ fontSize: 36, fontWeight: 800, margin: '4px 0' }}>{formatNaira(r.amountKobo)}</div>
        <span className={`chip ${r.state === 'succeeded' ? 'success' : r.state === 'failed' ? 'critical' : 'warning'}`}>{r.state === 'succeeded' ? 'Paid' : r.state === 'failed' ? 'Failed' : 'Confirming'}</span>
      </div>
      <div className="facts-list">
        <div>
          <span className="muted">Receipt no.</span>
          <strong>{r.receiptNo ?? 'After confirmation'}</strong>
        </div>
        <div>
          <span className="muted">Date</span>
          <strong>{new Date(r.paidAt ?? r.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong>
        </div>
        <div>
          <span className="muted">From</span>
          <strong>{r.from}</strong>
        </div>
        <div>
          <span className="muted">To</span>
          <strong>{r.to}</strong>
        </div>
        {r.detail && (
          <div>
            <span className="muted">Details</span>
            <strong>{r.detail}</strong>
          </div>
        )}
        <div>
          <span className="muted">Paid with</span>
          <strong>{r.method}</strong>
        </div>
        <div>
          <span className="muted">Reference</span>
          <strong style={{ fontFamily: 'ui-monospace, monospace', fontSize: 'var(--text-sm)', wordBreak: 'break-all', textAlign: 'right' }}>{r.reference}</strong>
        </div>
      </div>
      {r.state === 'succeeded' && (
        <button className="btn block" type="button" onClick={() => window.print()}>
          Save or print
        </button>
      )}
    </main>
  );
}
