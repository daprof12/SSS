'use client';

import { formatNaira } from '@erp/domain';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { MethodPicker, usePay, type PayMethod } from '@/components/Pay';
import { api } from '@/lib/client';

interface Plan {
  code: string;
  name: string;
  priceKobo: number;
  installFeeKobo: number;
  line: string;
}

/** Board "Subscription and payment" (Protect your home): pick a plan, pay the install fee and first month. */
export default function ProtectHome() {
  const router = useRouter();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [code, setCode] = useState('household');
  const [method, setMethod] = useState<PayMethod>('card');
  useEffect(() => {
    api<Plan[]>('/me/plans').then(setPlans).catch(() => setPlans([]));
  }, []);
  const plan = plans?.find((p) => p.code === code);
  const { pay, busy, ui } = usePay(
    (m, key, pin) => api('/me/subscriptions', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ planCode: code, method: m, pin }) }),
    (r) => router.push(`/payments/${encodeURIComponent(r.reference)}`),
  );
  return (
    <main className="app" style={{ paddingBottom: 130 }}>
      <Header title="Protect your home" back="/profile/home" />
      <p className="muted" style={{ marginTop: -8 }}>
        Outdoor camera, street light and fast incident briefs, installed and maintained by our team.
      </p>
      {!plans && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 88 }} />)}
      <div role="radiogroup" aria-label="Plan">
        {plans?.map((p) => (
          <button key={p.code} className="choice" type="button" role="radio" aria-checked={code === p.code} aria-pressed={code === p.code} onClick={() => setCode(p.code)} style={{ minHeight: 88 }}>
            <span className="radio-dot" data-on={code === p.code} />
            <span className="grow">
              <strong>{p.name}</strong>
              <span className="sub">{p.line}</span>
            </span>
            <strong style={{ color: 'var(--color-signal-text)', whiteSpace: 'nowrap' }}>{formatNaira(p.priceKobo).replace(/\.00$/, '')}/mo</strong>
          </button>
        ))}
      </div>
      {plan && (
        <div className="facts-list">
          <div>
            <span className="muted">First installation fee</span>
            <strong>{formatNaira(plan.installFeeKobo)}</strong>
          </div>
          <div>
            <span className="muted">First month, {plan.name}</span>
            <strong>{formatNaira(plan.priceKobo)}</strong>
          </div>
          <div>
            <strong>Total today</strong>
            <strong style={{ fontSize: 'var(--text-lg)' }}>{formatNaira(plan.installFeeKobo + plan.priceKobo)}</strong>
          </div>
        </div>
      )}
      <p className="section-label">Pay with</p>
      <MethodPicker value={method} onChange={setMethod} />
      <p className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--text-sm)' }}>
        <Icon name="lock" size={16} /> Pay with card, bank transfer or USSD. Secured by Paystack. Billing starts when your devices are installed.
      </p>
      {ui}
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', maxWidth: 520, margin: '0 auto' }}>
        <button className="btn block primary" type="button" disabled={!plan || busy} onClick={() => void pay(method)} style={{ minHeight: 56 }}>
          {busy ? 'Starting…' : method === 'wallet' ? 'Pay from wallet' : 'Pay with Paystack'}
        </button>
        <p className="muted center" style={{ margin: '8px 0 0', fontSize: 'var(--text-sm)' }}>
          Renews monthly. Pause or cancel any time in Profile.
        </p>
      </div>
    </main>
  );
}
