'use client';

import { useRouter } from 'next/navigation';
import { use, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { api } from '@/lib/client';

/**
 * Stand-in for Paystack's hosted checkout while the Paystack adapter is mocked.
 * It only asks the dev API to send the signed webhook Paystack would send.
 * Production replaces this with the real checkout URL.
 */
export default function MockCheckout({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const finish = async (outcome: 'success' | 'failed') => {
    setBusy(true);
    await api(`/dev/paystack/complete/${encodeURIComponent(ref)}?outcome=${outcome}`, { method: 'POST' }).catch(() => {});
    router.replace(`/wallet/confirm/${encodeURIComponent(ref)}`);
  };

  if (process.env.NODE_ENV === 'production') {
    return (
      <main className="app bare">
        <Header title="Checkout" back="/wallet" />
        <p className="muted">Checkout opens on Paystack.</p>
      </main>
    );
  }
  return (
    <main className="app bare">
      <Header title="Test checkout" back="/wallet/fund" />
      <div className="banner warning">
        <strong>Test mode</strong>
        This screen stands in for Paystack while payments are mocked. No money moves.
      </div>
      <div className="card">
        <span className="muted">Reference</span>
        <p style={{ margin: '2px 0 0', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>{ref}</p>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <button className="btn block signal" type="button" disabled={busy} onClick={() => finish('success')}>
          Pay (test)
        </button>
        <button className="btn block" type="button" disabled={busy} onClick={() => finish('failed')}>
          Card declined (test)
        </button>
        <button className="btn block" type="button" disabled={busy} onClick={() => router.replace('/wallet')}>
          Close checkout
        </button>
      </div>
    </main>
  );
}
