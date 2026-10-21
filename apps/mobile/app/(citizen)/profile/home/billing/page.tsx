'use client';

import { formatNaira } from '@erp/domain';
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { usePay } from '@/components/Pay';
import { api, ApiError } from '@/lib/client';

interface Billing {
  plan: { name: string; priceKobo: number } | null;
  state?: string;
  paidUntil?: string | null;
  autopayFromWallet?: boolean;
  install?: { number: string; state: string; visit: string | null } | null;
  problem?: {
    amountKobo: number;
    dueSince: string;
    day: number;
    stages: { state: string; fromDay: number; toDay: number | null; title: string; line: string; current: boolean }[];
    arrangement: string | null;
    walletKobo: number;
  } | null;
}
const day = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** Board "Payment problem" when a monthly charge failed; otherwise the plan's billing at a glance. */
export default function BillingPage() {
  const router = useRouter();
  const [b, setB] = useState<Billing | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [toast, setToast] = useToast();
  const load = () => api<Billing>('/me/home/billing').then(setB).catch(() => setB({ plan: null }));
  useEffect(() => {
    void load();
  }, []);
  const { pay, busy, ui } = usePay(
    (m, key, pin) => api('/me/home/billing/pay', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ method: m, pin }) }),
    (r) => {
      setToast(r.message ?? 'Paid.');
      void load();
    },
  );

  if (!b) return <main className="app">{<div className="skeleton" style={{ height: 300 }} />}</main>;
  if (!b.plan) {
    return (
      <main className="app">
        <Header title="Home plan" back="/profile/home" />
        <div className="empty">
          <strong>No home plan yet.</strong>
          <Link href="/profile/home/plan">Protect your home</Link>
        </div>
      </main>
    );
  }
  const p = b.problem;
  if (!p) {
    return (
      <main className="app">
        <Header title="Home plan" back="/profile/home" />
        <div className="facts-list">
          <div>
            <span className="muted">Plan</span>
            <strong>
              {b.plan.name}, {formatNaira(b.plan.priceKobo)}/month
            </strong>
          </div>
          <div>
            <span className="muted">Status</span>
            <strong>{b.state === 'active' ? 'Active' : b.state === 'install_booked' ? 'Install booked' : b.state === 'install_pending' ? 'Waiting for install' : b.state}</strong>
          </div>
          {b.paidUntil && (
            <div>
              <span className="muted">Paid until</span>
              <strong>{day(b.paidUntil)}</strong>
            </div>
          )}
          {b.install && b.state !== 'active' && (
            <div>
              <span className="muted">Install</span>
              <strong>{b.install.visit ?? `${b.install.number}, we will call to book`}</strong>
            </div>
          )}
        </div>
        {b.state === 'active' && (
          <div className="list">
            <div className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>Pay from my wallet first</strong>
                <span className="sub">Each month, before the card</span>
              </span>
              <button
                className="toggle"
                type="button"
                role="switch"
                aria-checked={!!b.autopayFromWallet}
                aria-label="Pay from my wallet first"
                onClick={async () => {
                  const r = await api<{ message: string }>('/me/home/billing/autopay', { method: 'PATCH', body: JSON.stringify({ on: !b.autopayFromWallet }) }).catch(() => null);
                  if (r) setToast(r.message);
                  void load();
                }}
              />
            </div>
          </div>
        )}
        <p className="muted">
          Receipts are in <Link href="/payments">Payments and receipts</Link>.
        </p>
        <Toast msg={toast} />
      </main>
    );
  }

  const short = Math.max(0, p.amountKobo - p.walletKobo);
  return (
    <main className="app" style={{ paddingBottom: 220 }}>
      <Header title="Payment problem" back="/profile/home" />
      <div className="banner warning" style={{ display: 'flex', gap: 12 }}>
        <Icon name="flag" />
        <span>
          <strong>We could not take your monthly payment</strong>
          {formatNaira(p.amountKobo)} for the {b.plan.name} plan, due {day(p.dueSince)}. This is day {p.day}.
        </span>
      </div>
      <h2 style={{ fontSize: 'var(--text-lg)' }}>What happens next</h2>
      <div role="list">
        {p.stages.map((s) => (
          <div key={s.state} role="listitem" className="choice" aria-current={s.current ? 'step' : undefined} style={{ cursor: 'default', alignItems: 'flex-start', borderColor: s.current ? 'var(--color-signal)' : 'transparent', background: s.current ? 'var(--color-signal-soft)' : undefined }}>
            <span className="radio-dot" style={{ marginTop: 3, background: s.current ? 'var(--color-signal)' : undefined, borderColor: s.current ? 'var(--color-signal)' : undefined }} />
            <span className="grow">
              <strong>
                {s.toDay ? `Days ${s.fromDay} to ${s.toDay}` : `After day ${s.fromDay - 1}`}: {s.title}
              </strong>
              <span className="sub">{s.line}</span>
            </span>
          </div>
        ))}
      </div>
      <p style={{ color: 'var(--color-success-text)', fontWeight: 600, display: 'flex', gap: 8 }}>
        <Icon name="check" size={18} /> You can always report an emergency, whatever your payment status.
      </p>
      {p.arrangement === 'payment_plan' && (
        <div className="banner info">
          <strong>Payment plan asked</strong>
          We will call you within a working day.
        </div>
      )}
      {ui}
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', maxWidth: 520, margin: '0 auto', display: 'grid', gap: 8 }}>
        <button className="btn block primary" type="button" disabled={busy} onClick={() => void pay('card')} style={{ minHeight: 56 }}>
          {busy ? 'Starting…' : 'Pay now with Paystack'}
        </button>
        <div className="btn-row">
          <button className="btn" type="button" disabled={busy} onClick={() => (short ? router.push('/wallet/fund') : void pay('wallet'))}>
            {short ? `Top up ${formatNaira(short).replace(/\.00$/, '')}` : 'Pay from wallet'}
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => void pay('card')} title="Paying by card saves it for next month">
            Update card
          </button>
        </div>
        {p.arrangement !== 'payment_plan' && (
          <button className="link-btn" type="button" onClick={() => setAsking(true)} style={{ color: 'var(--color-signal-text)', fontWeight: 700 }}>
            Need more time? Ask for a payment plan
          </button>
        )}
      </div>
      <Sheet
        open={asking}
        title="Ask for a payment plan"
        description="We call you within a working day to agree dates. The stages above keep running until then."
        onClose={() => setAsking(false)}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              type="button"
              onClick={async () => {
                try {
                  const r = await api<{ message: string }>('/me/home/billing/payment-plan', { method: 'POST', body: JSON.stringify({ note }) });
                  setAsking(false);
                  setToast(r.message);
                  void load();
                } catch (e) {
                  setToast(e instanceof ApiError ? e.message : 'Could not send. Try again.');
                }
              }}
            >
              Ask for a plan
            </button>
          </>
        }
      >
        <label className="field" style={{ marginBottom: 0 }}>
          <span>When can you pay? (optional)</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="For example, on the 28th when I am paid." />
        </label>
      </Sheet>
      <Toast msg={toast} />
    </main>
  );
}
