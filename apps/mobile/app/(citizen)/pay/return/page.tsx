'use client';
// Back from Paystack's checkout. Paystack adds ?reference=…; the money is credited only when Paystack's
// signed webhook arrives, so this waits for the payment to settle, then opens its receipt.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { api } from '@/lib/client';

export default function PayReturn() {
  const router = useRouter();
  const [note, setNote] = useState('Confirming your payment with Paystack…');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    let ref = q.get('reference') ?? q.get('trxref');
    try {
      ref ??= sessionStorage.getItem('erp-paying');
      sessionStorage.removeItem('erp-paying');
    } catch {}
    if (!ref || !/^[A-Za-z0-9_-]{6,80}$/.test(ref)) {
      setNote('We could not tell which payment this was. Check your wallet or receipts.');
      return;
    }
    let stop = false;
    const started = Date.now();
    const check = async () => {
      const p = await api<{ purpose: string; state: string }>(`/me/payments/${encodeURIComponent(ref!)}`).catch(() => null);
      if (stop) return;
      if (p && p.state !== 'pending' && p.state !== 'initiated') {
        router.replace(p.purpose === 'wallet_fund' ? `/wallet/confirm/${encodeURIComponent(ref!)}` : `/payments/${encodeURIComponent(ref!)}?thanks=${p.purpose === 'donation' ? 1 : 0}`);
        return;
      }
      if (Date.now() - started > 60_000) {
        // Bank transfers can take longer; the receipt page keeps the latest state.
        router.replace(p?.purpose === 'wallet_fund' ? `/wallet/confirm/${encodeURIComponent(ref!)}` : `/payments/${encodeURIComponent(ref!)}`);
        return;
      }
      setTimeout(check, 2500);
    };
    void check();
    return () => {
      stop = true;
    };
  }, [router]);
  return (
    <main className="app bare">
      <Header title="Payment" back={false} />
      <div className="card" role="status" aria-live="polite">
        <div className="skeleton" style={{ height: 8, marginBottom: 12 }} />
        {note}
      </div>
    </main>
  );
}
