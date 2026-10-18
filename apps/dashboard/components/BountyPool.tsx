'use client';
// Board "Agency bounties": fund the pool (Paystack) and add or change a rate.
import { formatNaira, percent } from '@erp/domain';
import { api, ApiError } from '@erp/web-ui/api';
import { focusFirstError } from '@erp/web-ui/CloseReportSheet';
import { Sheet } from '@erp/web-ui/Sheet';
import { useEffect, useRef, useState } from 'react';

export interface Rate {
  category: string;
  label: string;
  verifiedWhen: string;
  set: boolean;
  active: boolean;
  basis: 'fixed' | 'tiered' | 'percent_capped';
  percent: number | null;
  standardKobo: number | null;
  seriousKobo: number | null;
  capKobo: number | null;
}

export interface PoolSummary {
  pool: { availableKobo: number; pendingClaimsKobo: number; low: string | null };
  /** True once the agency asked to leave: no funding, no new bounties. */
  closed: boolean;
  fee: { bps: number; label: string; chosenBps: number | null; suggestedBps: number; minBps: number; maxBps: number };
  payout: { amountKobo: number; state: string; line: string; reason: string | null; paidAt: string | null } | null;
  claimsWaiting: number;
  paidThisMonth: { kobo: number; tips: number };
  tipsThisMonth: number;
  limits: { minKobo: number; maxKobo: number };
  rates: Rate[];
  history: { kind: string; amountKobo: number; label: string; at: string }[];
  pendingFunding: { reference: string; amountKobo: number; method: string; since: string }[];
}

export const naira = (k: number) => formatNaira(k).replace(/\.00$/, '');
const toKobo = (v: string) => Math.round(Number(v.replace(/[^\d.]/g, '')) * 100);
const fromKobo = (k: number | null) => (k == null ? '' : String(k / 100));
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const DEV = process.env.NODE_ENV !== 'production';

type Method = 'card' | 'bank_transfer' | 'ussd';
const METHODS: [Method, string][] = [
  ['card', 'Card'],
  ['bank_transfer', 'Bank transfer'],
  ['ussd', 'USSD'],
];
const QUICK = [50_000_000, 100_000_000, 500_000_000];

interface Started {
  reference: string;
  checkoutUrl?: string;
  transferAccount?: { bankName: string; accountNumber: string; accountName: string };
  amount: string;
}

/**
 * Amount → method → Paystack → "Confirming your payment" until the signed webhook lands.
 * The pool is credited only by the webhook, never by this screen.
 */
export function FundSheet({ agencyId, summary, onClose, onFunded }: { agencyId: string; summary: PoolSummary; onClose: () => void; onFunded: (message: string) => void }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('card');
  const [step, setStep] = useState<'amount' | 'pay' | 'confirming' | 'failed'>('amount');
  const [started, setStarted] = useState<Started | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idem = useRef(uid());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const kobo = toKobo(amount);
  const { minKobo, maxKobo } = summary.limits;

  const start = async () => {
    if (!kobo || kobo < minKobo || kobo > maxKobo) return setErr(`Enter between ${naira(minKobo)} and ${naira(maxKobo)}.`);
    setErr(null);
    setBusy(true);
    try {
      const r = await api<Started>(`/agencies/${agencyId}/bounty-pool/fund`, { method: 'POST', body: JSON.stringify({ amountKobo: kobo, method, idempotencyKey: idem.current }) });
      setStarted(r);
      if (r.checkoutUrl && !DEV) {
        window.location.assign(r.checkoutUrl);
        return;
      }
      setStep('pay');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not start the payment. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const poll = (reference: string, tries = 0) => {
    api<{ state: string; message: string }>(`/agencies/${agencyId}/bounty-pool/payments/${encodeURIComponent(reference)}`)
      .then((s) => {
        if (s.state === 'succeeded') return onFunded(s.message);
        if (s.state === 'failed' || s.state === 'abandoned') {
          setErr(s.message);
          return setStep('failed');
        }
        if (tries < 40) timer.current = setTimeout(() => poll(reference, tries + 1), 1500);
        else setErr('Still confirming. We will tell you when it lands; you can close this.');
      })
      .catch(() => (timer.current = setTimeout(() => poll(reference, tries + 1), 3000)));
  };

  /** Development only: plays the part of Paystack's checkout. */
  const simulate = async (outcome: 'success' | 'failed') => {
    if (!started) return;
    setStep('confirming');
    await api(`/dev/paystack/complete/${encodeURIComponent(started.reference)}?outcome=${outcome}`, { method: 'POST' }).catch(() => {});
    poll(started.reference);
  };

  const retry = () => {
    idem.current = uid();
    setStarted(null);
    setErr(null);
    setStep('amount');
  };

  const footer =
    step === 'amount' ? (
      <>
        <button className="btn" type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" type="button" onClick={start} disabled={busy}>
          {busy ? 'Starting…' : kobo >= minKobo ? `Pay ${naira(kobo)}` : 'Continue'}
        </button>
      </>
    ) : step === 'pay' ? (
      <>
        <button className="btn" type="button" onClick={() => simulate('failed')}>
          {started?.transferAccount ? 'Transfer failed (test)' : 'Decline card (test)'}
        </button>
        <button className="btn primary" type="button" onClick={() => simulate('success')}>
          {started?.transferAccount ? 'I have sent it' : 'Pay now (test)'}
        </button>
      </>
    ) : step === 'failed' ? (
      <>
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
        <button className="btn primary" type="button" onClick={retry}>
          Try again
        </button>
      </>
    ) : (
      <button className="btn" type="button" onClick={onClose}>
        Close
      </button>
    );

  return (
    <Sheet
      open
      title="Fund bounty pool"
      description="Bounties are paid from this pool, so a bounty is never promised without money behind it."
      onClose={onClose}
      busy={busy}
      footer={footer}
    >
      {step === 'amount' && (
        <>
          <div className="facts" style={{ marginBottom: 16 }}>
            <div>
              <dt>In the pool now</dt>
              <dd>{naira(summary.pool.availableKobo)}</dd>
            </div>
            {summary.pool.pendingClaimsKobo > 0 && (
              <div>
                <dt>Claims waiting</dt>
                <dd>{naira(summary.pool.pendingClaimsKobo)}</dd>
              </div>
            )}
          </div>
          <label className="field" data-invalid={!!err}>
            <span>Amount (₦)</span>
            <input inputMode="decimal" autoFocus aria-label="Amount in naira" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`${minKobo / 100} or more`} aria-invalid={!!err} />
          </label>
          <div className="chips" style={{ margin: '8px 0 16px' }}>
            {QUICK.map((q) => (
              <button key={q} type="button" aria-pressed={kobo === q} onClick={() => setAmount(String(q / 100))}>
                {naira(q)}
              </button>
            ))}
          </div>
          <div className="field">
            <span>Pay with</span>
            <div className="segmented" role="radiogroup" aria-label="Pay with">
              {METHODS.map(([m, l]) => (
                <button key={m} type="button" role="radio" aria-checked={method === m} aria-pressed={method === m} onClick={() => setMethod(m)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          {err && (
            <span className="field-error" role="alert">
              {err}
            </span>
          )}
        </>
      )}

      {step === 'pay' && started && (
        <>
          {started.transferAccount ? (
            <>
              <p style={{ marginTop: 0 }}>Send exactly {started.amount} to this account. It is only for this payment.</p>
              <dl className="facts">
                <div>
                  <dt>Bank</dt>
                  <dd>{started.transferAccount.bankName}</dd>
                </div>
                <div>
                  <dt>Account number</dt>
                  <dd>{started.transferAccount.accountNumber}</dd>
                </div>
                <div>
                  <dt>Account name</dt>
                  <dd>{started.transferAccount.accountName}</dd>
                </div>
              </dl>
            </>
          ) : (
            <p style={{ marginTop: 0 }}>Test checkout for {started.amount}. In production this is Paystack&apos;s own page.</p>
          )}
          <p className="muted">The pool updates when Paystack confirms the payment, usually within a minute.</p>
        </>
      )}

      {step === 'confirming' && (
        <div className="confirming" role="status" aria-live="polite">
          <span className="spinner" aria-hidden />
          <div>
            <strong>Confirming your payment.</strong>
            <span className="muted">{err ?? 'This page updates on its own.'}</span>
          </div>
        </div>
      )}

      {step === 'failed' && (
        <div className="banner critical" role="alert">
          <strong>Payment not completed</strong>
          {err}
        </div>
      )}
    </Sheet>
  );
}

/** "Add or change a rate". Standard and serious results map to the claim severity the agency records. */
export function RateSheet({ agencyId, rates, initial, onClose, onSaved }: { agencyId: string; rates: Rate[]; initial: string; onClose: () => void; onSaved: (message: string) => void }) {
  const [category, setCategory] = useState(initial);
  const r = rates.find((x) => x.category === category)!;
  type Basis = Rate['basis'];
  const [basis, setBasis] = useState<Basis>(r.basis);
  const [percent, setPercent] = useState(r.percent == null ? '' : String(r.percent));
  const [standard, setStandard] = useState(fromKobo(r.standardKobo));
  const [serious, setSerious] = useState(fromKobo(r.seriousKobo));
  const [cap, setCap] = useState(fromKobo(r.capKobo));
  const [active, setActive] = useState(r.set ? r.active : true);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const pick = (code: string) => {
    const x = rates.find((y) => y.category === code)!;
    setCategory(code);
    setBasis(x.basis);
    setPercent(x.percent == null ? '' : String(x.percent));
    setStandard(fromKobo(x.standardKobo));
    setSerious(fromKobo(x.seriousKobo));
    setCap(fromKobo(x.capKobo));
    setActive(x.set ? x.active : true);
    setErrs({});
  };

  const save = async () => {
    const e: Record<string, string> = {};
    const pct = Number(percent);
    if (basis === 'percent_capped') {
      if (!(pct > 0 && pct <= 50)) e.percent = 'Enter a share between 0.1% and 50%.';
      if (!toKobo(cap)) e.capKobo = 'A share of the value needs a cap per tip.';
    } else {
      if (!toKobo(standard)) e.standardKobo = 'Enter an amount.';
      if (basis === 'tiered' && !toKobo(serious)) e.seriousKobo = 'Enter an amount.';
    }
    setErrs(e);
    if (Object.keys(e).length) return focusFirstError();
    setBusy(true);
    try {
      const body =
        basis === 'percent_capped'
          ? { basis, percent: Number(percent), capKobo: toKobo(cap), active }
          : { basis, standardKobo: toKobo(standard), seriousKobo: basis === 'tiered' ? toKobo(serious) : undefined, capKobo: cap ? toKobo(cap) : null, active };
      const res = await api<{ message: string }>(`/agencies/${agencyId}/bounty-rates/${category}`, { method: 'PUT', body: JSON.stringify(body) });
      onSaved(res.message);
    } catch (x) {
      if (x instanceof ApiError && x.fields?.length) setErrs(Object.fromEntries(x.fields.map((f) => [f.field, f.message])));
      else setErrs({ form: x instanceof ApiError ? x.message : 'Could not save. Try again.' });
      setBusy(false);
      focusFirstError();
    }
  };

  const money = (key: string, label: string, value: string, set: (v: string) => void, hint?: string) => (
    <label className="field" data-invalid={!!errs[key]} style={{ marginBottom: 12 }}>
      <span>{label}</span>
      <input inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} placeholder="₦" aria-label={`${label} in naira`} aria-invalid={!!errs[key]} />
      {hint && !errs[key] && <small className="muted">{hint}</small>}
      {errs[key] && <span className="field-error">{errs[key]}</span>}
    </label>
  );

  return (
    <Sheet
      open
      title="Add or change a rate"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save rate'}
          </button>
        </>
      }
    >
      {errs.form && (
        <div className="banner critical" role="alert">
          {errs.form}
        </div>
      )}
      <label className="field" style={{ marginBottom: 12 }}>
        <span>Tip category</span>
        <select value={category} onChange={(e) => pick(e.target.value)}>
          {rates.map((x) => (
            <option key={x.category} value={x.category}>
              {x.label}
            </option>
          ))}
        </select>
        <small className="muted">Counts as verified when: {r.verifiedWhen.toLowerCase()}.</small>
      </label>
      <label className="field" style={{ marginBottom: 12 }}>
        <span>Basis</span>
        <select value={basis} onChange={(e) => setBasis(e.target.value as Basis)}>
          <option value="tiered">Tiered by result</option>
          <option value="fixed">Fixed</option>
          <option value="percent_capped">Share of value recovered</option>
        </select>
      </label>
      {basis === 'percent_capped' ? (
        <label className="field" data-invalid={!!errs.percent} style={{ marginBottom: 12 }}>
          <span>Share of the value recovered (%)</span>
          <input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="%" aria-label="Share of the value recovered in percent" aria-invalid={!!errs.percent} />
          {errs.percent ? <span className="field-error">{errs.percent}</span> : <small className="muted">You enter the value recovered or seized when you record the result.</small>}
        </label>
      ) : basis === 'tiered' ? (
        <>
          {money('standardKobo', 'Standard result', standard, setStandard, 'When you record the result as standard.')}
          {money('seriousKobo', 'Serious result', serious, setSerious, 'When you record the result as high severity.')}
        </>
      ) : (
        money('standardKobo', 'Bounty', standard, setStandard)
      )}
      {money('capKobo', basis === 'percent_capped' ? 'Cap per tip' : 'Cap per tip (optional)', cap, setCap, 'You can never approve more than this for one tip.')}
      <div className="row" style={{ marginBottom: 12 }}>
        <span style={{ flex: 1 }}>
          <strong>Pays a bounty</strong>
          <small className="muted" style={{ display: 'block' }}>
            Turn off to stop offering a bounty for this category.
          </small>
        </span>
        <button className="toggle" type="button" role="switch" aria-checked={active} aria-label="Pays a bounty" onClick={() => setActive((v) => !v)} />
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Only the first person to report a tip is paid. A tip that matches an open case is attached to it and the first reporter is still the one paid.
      </p>
    </Sheet>
  );
}

/** The agency's platform fee: the suggestion, or its own choice inside the admin's range. */
export function FeeSheet({ agencyId, fee, onClose, onSaved }: { agencyId: string; fee: PoolSummary['fee']; onClose: () => void; onSaved: (m: string) => void }) {
  const [own, setOwn] = useState(fee.chosenBps != null);
  const [value, setValue] = useState(fee.chosenBps != null ? String(fee.chosenBps / 100) : String(fee.suggestedBps / 100));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bps = Math.round(Number(value) * 100);

  const save = async () => {
    if (own && (!Number.isFinite(bps) || bps < fee.minBps || bps > fee.maxBps)) {
      setErr(`Choose between ${percent(fee.minBps)} and ${percent(fee.maxBps)}.`);
      return focusFirstError();
    }
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/agencies/${agencyId}/bounty-fee`, { method: 'PUT', body: JSON.stringify({ bps: own ? bps : null }) });
      onSaved(r.message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save. Try again.');
      setBusy(false);
      focusFirstError();
    }
  };

  const example = 10_000_000;
  const shownBps = own ? (Number.isFinite(bps) ? bps : 0) : fee.suggestedBps;
  return (
    <Sheet
      open
      title="Platform fee"
      description="The platform takes a fee on each bounty you approve. It comes from your pool on top of the bounty, so the tipper always gets the full amount."
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save fee'}
          </button>
        </>
      }
    >
      <div className="grid" style={{ gap: 8 }} role="radiogroup" aria-label="Platform fee">
        <label className="choice">
          <input type="radio" name="fee" checked={!own} onChange={() => setOwn(false)} />
          <span>
            <strong>Use the suggested fee, {percent(fee.suggestedBps)}</strong>
            <small className="muted" style={{ display: 'block' }}>
              Follows the platform&apos;s suggestion if it changes.
            </small>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="fee" checked={own} onChange={() => setOwn(true)} />
          <span>
            <strong>Choose my own</strong>
            <small className="muted" style={{ display: 'block' }}>
              Between {percent(fee.minBps)} and {percent(fee.maxBps)}.
            </small>
          </span>
        </label>
      </div>
      {own && (
        <label className="field" data-invalid={!!err} style={{ marginTop: 12 }}>
          <span>Fee (%)</span>
          <input inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-label="Fee in percent" aria-invalid={!!err} />
        </label>
      )}
      {err && (
        <span className="field-error" role="alert">
          {err}
        </span>
      )}
      <p className="muted" style={{ marginBottom: 0 }}>
        Example: a {naira(example)} bounty costs your pool {naira(example + Math.round((example * shownBps) / 10_000))}.
      </p>
    </Sheet>
  );
}
