'use client';
// Pay with the wallet (PIN) or Paystack: card, bank transfer or USSD (B9). Used by Donate and Fines.
// A wallet that is too low offers "Top up [shortfall]" (UX Gap Analysis §9 entry points).
import { LinkButton } from '@erp/web-ui/LinkButton';
import { formatNaira } from '@erp/domain';
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, uid } from '@/lib/client';
import { PinPad } from './WithdrawFlow';

export type PayMethod = 'wallet' | 'card' | 'bank_transfer' | 'ussd';
export interface PayResult {
  reference: string;
  state: string;
  receiptNo?: string;
  message?: string;
  checkoutUrl?: string;
  transferAccount?: { bankName: string; accountNumber: string; accountName: string };
}

const METHODS: [PayMethod, string][] = [
  ['wallet', 'Wallet'],
  ['card', 'Card'],
  ['bank_transfer', 'Transfer'],
  ['ussd', 'USSD'],
];

export function MethodPicker({ value, onChange }: { value: PayMethod; onChange: (m: PayMethod) => void }) {
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    api<{ availableKobo: number }>('/me/wallet')
      .then((w) => setBalance(w.availableKobo))
      .catch(() => {});
  }, []);
  return (
    <>
      <div className="segmented" role="group" aria-label="Pay with" style={{ display: 'flex', marginBottom: 6 }}>
        {METHODS.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)} style={{ flex: 1, justifyContent: 'center' }}>
            {l}
          </button>
        ))}
      </div>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 'var(--text-sm)' }}>
        {value === 'wallet' ? `Wallet balance ${balance == null ? '…' : formatNaira(balance)}. You confirm with your PIN.` : 'Secured by Paystack.'}
      </p>
    </>
  );
}

/**
 * Runs a payment. `start` posts to the API with the method, the PIN for the wallet, and an
 * idempotency key (one per attempt). Paystack card/USSD opens checkout; a transfer shows the account.
 */
export function usePay(start: (method: PayMethod, key: string, pin?: string) => Promise<PayResult>, onPaid: (r: PayResult) => void) {
  const router = useRouter();
  const key = useRef(uid());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; shortfallKobo?: number } | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<PayResult | null>(null);

  const finish = (r: PayResult) => {
    key.current = uid();
    if (r.transferAccount) return setTransfer(r);
    if (r.checkoutUrl) {
      // The development mock has its own test checkout screen; real payments go to Paystack, which
      // brings the person back to /pay/return.
      if (r.checkoutUrl.includes('/dev/paystack/checkout/')) return router.push(`/pay/${encodeURIComponent(r.reference)}`);
      try {
        sessionStorage.setItem('erp-paying', r.reference);
      } catch {}
      return window.location.assign(r.checkoutUrl);
    }
    onPaid(r);
  };

  const pay = async (method: PayMethod) => {
    setErr(null);
    if (method === 'wallet') {
      setPinErr(null);
      return setPinOpen(true);
    }
    setBusy(true);
    try {
      finish(await start(method, key.current));
    } catch (e) {
      setErr({ message: e instanceof ApiError ? e.message : 'Something went wrong. Try again.' });
      key.current = uid();
    } finally {
      setBusy(false);
    }
  };

  const withPin = async (pin: string) => {
    setBusy(true);
    try {
      const r = await start('wallet', key.current, pin);
      setPinOpen(false);
      finish(r);
    } catch (e) {
      key.current = uid();
      if (e instanceof ApiError && (e.code === 'pin_wrong' || e.code === 'pin_locked')) setPinErr(e.message);
      else {
        setPinOpen(false);
        setErr({ message: e instanceof ApiError ? e.message : 'Something went wrong. Try again.', shortfallKobo: e instanceof ApiError ? (e.extra?.shortfallKobo as number | undefined) : undefined });
      }
    } finally {
      setBusy(false);
    }
  };

  const ui = (
    <>
      {err && (
        <div className="banner critical" role="alert">
          {err.message}
          {err.shortfallKobo ? (
            <LinkButton className="btn small" href="/wallet/fund" style={{ marginTop: 8, display: 'inline-flex' }}>
              Top up {formatNaira(err.shortfallKobo)}
            </LinkButton>
          ) : null}
        </div>
      )}
      <Sheet open={pinOpen} title="Enter your PIN" onClose={() => setPinOpen(false)} busy={busy} footer={null}>
        <PinPad title="Your 4-digit PIN" error={pinErr} busy={busy} onDone={withPin} />
        <p className="muted center" style={{ margin: 0 }}>
          No PIN yet? Set one in <Link href="/profile/security">Security</Link>.
        </p>
      </Sheet>
      <Sheet open={!!transfer} title="Pay by bank transfer" onClose={() => setTransfer(null)} footer={<button className="btn primary" type="button" onClick={() => router.push(`/payments/${encodeURIComponent(transfer!.reference)}`)}>I have sent it</button>}>
        {transfer?.transferAccount && (
          <div className="facts-list">
            <div>
              <span className="muted">Bank</span>
              <strong>{transfer.transferAccount.bankName}</strong>
            </div>
            <div>
              <span className="muted">Account</span>
              <strong>{transfer.transferAccount.accountNumber}</strong>
            </div>
            <div>
              <span className="muted">Name</span>
              <strong>{transfer.transferAccount.accountName}</strong>
            </div>
          </div>
        )}
        <p className="muted" style={{ margin: 0 }}>
          Send the exact amount. We confirm it when the bank tells us, usually within minutes.
        </p>
      </Sheet>
    </>
  );
  return { pay, busy, ui };
}
