'use client';

import { formatNaira } from '@erp/domain';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError, uid } from '@/lib/client';

type Method = 'card' | 'bank_transfer' | 'ussd';
interface Started {
  reference: string;
  checkoutUrl?: string;
  transferAccount?: { bankName: string; accountNumber: string; accountName: string };
}

const CHIPS = [1000, 5000, 10000];
const METHODS: Array<[Method, string, string]> = [
  ['bank_transfer', 'Bank transfer', 'To your own account number. Usually arrives in minutes.'],
  ['card', 'Card', 'Visa, Mastercard or Verve, through Paystack'],
  ['ussd', 'USSD', 'Dial a code from your bank'],
];

/** Fund wallet — UX Gap Analysis §9, steps 1–3. */
export default function Fund() {
  const router = useRouter();
  const [naira, setNaira] = useState('');
  const [method, setMethod] = useState<Method>('bank_transfer');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ field?: string; message: string; code?: string } | null>(null);
  const [transfer, setTransfer] = useState<Started | null>(null);
  const [copied, setCopied] = useState(false);
  // One key per attempt: a double tap or retry never charges twice.
  const key = useRef(uid());

  const amount = Math.round(Number(naira.replace(/[^\d.]/g, '')) * 100);

  const start = async () => {
    setErr(null);
    if (!amount) return setErr({ field: 'amount', message: 'Enter an amount of at least ₦100.00.' });
    setBusy(true);
    try {
      const r = await api<Started>('/me/wallet/fund', {
        method: 'POST',
        headers: { 'Idempotency-Key': key.current },
        body: JSON.stringify({ amountKobo: amount, method }),
      });
      if (r.transferAccount) setTransfer(r);
      else router.push(`/pay/${encodeURIComponent(r.reference)}`);
    } catch (e) {
      if (e instanceof ApiError) setErr({ field: e.fields?.[0]?.field, message: e.message, code: e.code });
      else setErr({ message: 'Something went wrong. Try again.' });
      key.current = uid();
    } finally {
      setBusy(false);
    }
  };

  if (transfer?.transferAccount) {
    const a = transfer.transferAccount;
    return (
      <main className="app bare">
        <Header title="Send by transfer" back="/wallet" />
        <p className="muted">Send {formatNaira(amount)} from your bank app to this account. It is yours alone, so you can use it again any time.</p>
        <div className="card">
          <span className="muted">Bank</span>
          <p style={{ margin: '2px 0 12px', fontWeight: 700 }}>{a.bankName}</p>
          <span className="muted">Account number</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="big-number" style={{ fontSize: 32 }}>
              {a.accountNumber}
            </span>
            <button
              className="btn small"
              type="button"
              onClick={async () => {
                await navigator.clipboard?.writeText(a.accountNumber).catch(() => {});
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <span className="muted">Account name</span>
          <p style={{ margin: '2px 0 0', fontWeight: 700 }}>{a.accountName}</p>
        </div>
        <button className="btn block signal" type="button" onClick={() => router.push(`/wallet/confirm/${encodeURIComponent(transfer.reference)}`)}>
          I have sent it
        </button>
        {process.env.NODE_ENV !== 'production' && (
          <button
            className="btn block"
            type="button"
            style={{ marginTop: 8 }}
            onClick={async () => {
              await api(`/dev/paystack/complete/${encodeURIComponent(transfer.reference)}`, { method: 'POST' }).catch(() => {});
              router.push(`/wallet/confirm/${encodeURIComponent(transfer.reference)}`);
            }}
          >
            Simulate the transfer arriving (test only)
          </button>
        )}
      </main>
    );
  }

  return (
    <main className="app bare">
      <Header title="Fund wallet" back="/wallet" />
      {err?.code === 'kyc_required' && (
        <div className="banner warning" role="alert">
          <strong>Verify to use your wallet</strong>
          {err.message}
        </div>
      )}
      <label className="field" data-invalid={err?.field === 'amount'}>
        <span>Amount</span>
        <input className="input" inputMode="decimal" placeholder="₦0" value={naira} onChange={(e) => setNaira(e.target.value)} aria-invalid={err?.field === 'amount'} style={{ fontSize: 'var(--text-xl)', fontWeight: 700 }} />
        {err && err.code !== 'kyc_required' && <span className="field-error">{err.message}</span>}
      </label>
      <div className="chips" style={{ marginBottom: 20 }}>
        {CHIPS.map((n) => (
          <button key={n} type="button" aria-pressed={amount === n * 100} onClick={() => setNaira(String(n))}>
            {formatNaira(n * 100).replace('.00', '')}
          </button>
        ))}
      </div>
      <p className="section-label">Pay with</p>
      <div style={{ display: 'grid', gap: 8, marginBottom: 20 }} role="radiogroup" aria-label="Payment method">
        {METHODS.map(([k, l, d]) => (
          <label key={k} className="row" style={{ background: 'var(--color-surface)', borderRadius: 16, border: `2px solid ${method === k ? 'var(--color-signal)' : 'transparent'}` }}>
            <input type="radio" name="method" value={k} aria-label={`${l}. ${d}`} checked={method === k} onChange={() => setMethod(k)} style={{ width: 20, height: 20, accentColor: 'var(--color-signal)' }} />
            <span className="grow">
              <strong>{l}</strong>
              <span className="sub">{d}</span>
            </span>
          </label>
        ))}
      </div>
      {amount > 0 && <p className="muted">You will receive {formatNaira(amount)} in your wallet.</p>}
      <button className="btn block signal" type="button" onClick={start} disabled={busy}>
        {busy ? 'Starting…' : amount ? `Continue with ${formatNaira(amount)}` : 'Continue'}
      </button>
      <p className="muted center">
        <Icon name="lock" size={14} /> Secured by Paystack. We never see your card.
      </p>
    </main>
  );
}
