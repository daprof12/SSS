'use client';
// Withdraw (States doc "withdraw flow"): bank account in the verified name, a PIN, then
// amount → confirm "Withdraw [Amount] to [Bank] ending [0000]?" → on its way or scheduled.
// Shared by citizens and officers; also the bank-account screen on its own.
import { LinkButton } from '@erp/web-ui/LinkButton';
import { formatNaira } from '@erp/domain';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError, haptic, uid } from '@/lib/client';

interface Bank {
  bankCode: string;
  bankName: string;
  lastFour: string;
  accountName: string;
  nameMatches: boolean;
  firstPaid: boolean;
}
interface Quote {
  amountKobo: number;
  feeKobo: number;
  netKobo: number;
  bank: { name: string; lastFour: string };
  heldFirst: boolean;
  holdReason: 'first_to_account' | 'pin_reset' | null;
  confirm: string;
}
interface Wd {
  id: string;
  amountKobo: number;
  netKobo: number;
  state: string;
  line: string;
  bank: string;
  createdAt: string;
}
const naira = (k: number) => formatNaira(k).replace(/\.00$/, '');
const toKobo = (v: string) => Math.round(Number(v.replace(/[^\d.]/g, '')) * 100) || 0;

// ---------------------------------------------------------------- PIN pad

/** Four dots and a number pad. Shakes on a wrong PIN; the parent clears it. */
export function PinPad({ title, sub, error, busy, onDone, onForgot }: { title: string; sub?: string; error?: string | null; busy?: boolean; onDone: (pin: string) => void; onForgot?: () => void }) {
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(0);
  useEffect(() => {
    if (error) {
      setShake((n) => n + 1);
      setPin('');
      haptic([20, 40, 20]);
    }
  }, [error]);
  const press = (d: string) => {
    if (busy) return;
    haptic(6);
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) setTimeout(() => onDone(next), 120);
  };
  // Hardware keyboards work too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="pinpad">
      <strong className="pin-title">{title}</strong>
      {sub && <span className="muted">{sub}</span>}
      <div key={shake} className={`pin-dots ${shake ? 'shake' : ''}`} aria-label={`${pin.length} of 4 digits entered`} role="status">
        {[0, 1, 2, 3].map((i) => (
          <i key={i} data-on={i < pin.length} />
        ))}
      </div>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
      <div className="pin-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) =>
          k === '' ? (
            <span key={i} />
          ) : (
            <button key={i} type="button" disabled={busy} aria-label={k === '⌫' ? 'Delete' : k} onClick={() => (k === '⌫' ? setPin((p) => p.slice(0, -1)) : press(k))}>
              {k}
            </button>
          ),
        )}
      </div>
      {onForgot && (
        <button type="button" className="link-btn" style={{ marginTop: 8 }} onClick={onForgot}>
          Forgot PIN?
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- forgot PIN

/** Code by SMS to the account's phone → new PIN twice. Withdrawals then wait 24 hours. */
export function ResetPin({ onDone, onCancel }: { onDone: (message: string) => void; onCancel: () => void }) {
  const [step, setStep] = useState<'send' | 'code' | 'pin' | 'again'>('send');
  const [phone, setPhone] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [first, setFirst] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const send = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ phone: string; resendInSeconds: number }>('/me/pin/reset/start', { method: 'POST' });
      setPhone(r.phone);
      setWait(r.resendInSeconds);
      setStep('code');
    } catch (e) {
      const m = e instanceof ApiError ? e.message : 'Could not send the code.';
      // A code may already be on its way: let them type it.
      if (e instanceof ApiError && e.code === 'resend_cooldown') {
        setWait(Number((e.extra as { retryInSeconds?: number } | undefined)?.retryInSeconds ?? 60));
        setStep('code');
      }
      setErr(m);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (pin: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ message: string }>('/me/pin/reset', { method: 'POST', body: JSON.stringify({ code, pin }) });
      haptic([10, 40, 10]);
      onDone(r.message);
    } catch (e) {
      const m = e instanceof ApiError ? e.message : 'Could not reset the PIN.';
      // A wrong or expired code goes back to the code step; a weak PIN back to the first PIN.
      if (e instanceof ApiError && (e.code === 'code_wrong' || e.code === 'code_expired' || e.code === 'code_locked')) setStep('code');
      else setStep('pin');
      setFirst(null);
      setErr(m);
    } finally {
      setBusy(false);
    }
  };

  if (step === 'send')
    return (
      <div className="reset-pin">
        <h2>Reset your PIN</h2>
        <p className="muted">We send a 6-digit code by SMS to the phone number on your account. After a reset, withdrawals wait 24 hours before they are sent, to keep your money safe.</p>
        {err && (
          <span className="field-error" role="alert">
            {err}
          </span>
        )}
        <button className="btn block primary" type="button" disabled={busy} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send code'}
        </button>
        <button className="link-btn center" type="button" style={{ display: 'block', margin: '12px auto 0' }} onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  if (step === 'code')
    return (
      <div className="reset-pin">
        <h2>Enter the code</h2>
        <p className="muted">{phone ? `Sent to ${phone}. It expires in 5 minutes.` : 'Check your SMS messages.'}</p>
        <label className="field" data-invalid={!!err}>
          <span>6-digit code</span>
          <input
            className="input code-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            value={code}
            onChange={(e) => {
              setErr(null);
              setCode(e.target.value.replace(/\D/g, ''));
            }}
            aria-invalid={!!err}
          />
          {err && <span className="field-error">{err}</span>}
        </label>
        <button className="btn block primary" type="button" disabled={code.length !== 6} onClick={() => (setErr(null), setStep('pin'))}>
          Continue
        </button>
        <button className="link-btn center" type="button" disabled={wait > 0 || busy} style={{ display: 'block', margin: '12px auto 0' }} onClick={() => void send()}>
          {wait > 0 ? `Send a new code in ${wait}s` : 'Send a new code'}
        </button>
      </div>
    );
  if (step === 'pin')
    return (
      <PinPad
        title="Choose a new PIN"
        sub="4 digits, not 1234 or 1111."
        error={err}
        onDone={(pin) => {
          setErr(null);
          if (/^(\d)\1+$/.test(pin)) return setErr('Avoid the same digit four times.');
          if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return setErr('Avoid digits in a row, like 1234.');
          setFirst(pin);
          setStep('again');
        }}
      />
    );
  return (
    <PinPad
      title="Enter the new PIN again"
      error={err}
      busy={busy}
      onDone={(pin) => {
        if (pin !== first) {
          setFirst(null);
          setStep('pin');
          return setErr('The PINs did not match. Start again.');
        }
        void finish(pin);
      }}
    />
  );
}

// ---------------------------------------------------------------- bank account

export function BankForm({ current, hasPin, onSaved, onCancel }: { current: Bank | null; hasPin: boolean; onSaved: (b: Bank) => void; onCancel?: () => void }) {
  const [banks, setBanks] = useState<{ code: string; name: string }[]>([]);
  const [code, setCode] = useState('');
  const [number, setNumber] = useState('');
  const [look, setLook] = useState<{ accountName: string; matches: boolean; verifiedName: string } | null>(null);
  const [looking, setLooking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [askPin, setAskPin] = useState(false);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    api<{ code: string; name: string }[]>('/banks').then(setBanks).catch(() => {});
  }, []);

  // Look the account up as soon as 10 digits and a bank are in.
  useEffect(() => {
    setLook(null);
    setErr(null);
    if (!code || !/^\d{10}$/.test(number)) return;
    setLooking(true);
    let alive = true;
    api<NonNullable<typeof look>>('/me/bank-account/resolve', { method: 'POST', body: JSON.stringify({ bankCode: code, accountNumber: number }) })
      .then((r) => alive && setLook(r))
      .catch((e) => alive && setErr(e instanceof ApiError ? e.message : 'Could not check the account.'))
      .finally(() => alive && setLooking(false));
    return () => {
      alive = false;
    };
  }, [code, number]);

  const save = async (pin?: string) => {
    setBusy(true);
    setPinErr(null);
    try {
      const b = await api<Bank>('/me/bank-account', { method: 'PUT', body: JSON.stringify({ bankCode: code, accountNumber: number, ...(pin ? { pin } : {}) }) });
      haptic([10, 40, 10]);
      onSaved(b);
    } catch (e) {
      const m = e instanceof ApiError ? e.message : 'Could not save. Try again.';
      if (e instanceof ApiError && (e.code === 'pin_wrong' || e.code === 'pin_locked')) setPinErr(m);
      else {
        setAskPin(false);
        setErr(m);
      }
    } finally {
      setBusy(false);
    }
  };

  if (resetting)
    return (
      <ResetPin
        onCancel={() => setResetting(false)}
        onDone={() => {
          setResetting(false);
          setPinErr(null);
        }}
      />
    );
  if (askPin) return <PinPad title="Enter your PIN" sub="To change where your money goes." error={pinErr} busy={busy} onDone={(pin) => void save(pin)} onForgot={() => setResetting(true)} />;
  return (
    <>
      {current && (
        <div className="banner info">
          <strong>Now: {current.bankName}, ending {current.lastFour}</strong>
          The new account replaces it. We tell you by notification whenever it changes.
        </div>
      )}
      <label className="field">
        <span>Bank</span>
        <select className="input" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Bank">
          <option value="">Choose your bank</option>
          {banks.map((b) => (
            <option key={b.code} value={b.code}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field" data-invalid={!!err}>
        <span>Account number</span>
        <input className="input" inputMode="numeric" autoComplete="off" maxLength={10} value={number} onChange={(e) => setNumber(e.target.value.replace(/\D/g, ''))} placeholder="10 digits" aria-invalid={!!err} />
        {err && <span className="field-error">{err}</span>}
      </label>
      {looking && <div className="skeleton" style={{ height: 64 }} />}
      {look && (
        <div className={`banner ${look.matches ? 'success' : 'critical'}`} role="status">
          <strong>{look.accountName}</strong>
          {look.matches ? 'Matches your verified name.' : `This account name does not match your verified name (${look.verifiedName}). Add an account in your own name.`}
        </div>
      )}
      <button className="btn block primary" type="button" disabled={!look?.matches || busy} onClick={() => (hasPin ? setAskPin(true) : void save())}>
        {busy ? 'Saving…' : 'Save bank account'}
      </button>
      {onCancel && (
        <button className="link-btn center" type="button" style={{ display: 'block', margin: '12px auto 0' }} onClick={onCancel}>
          Cancel
        </button>
      )}
      <p className="muted" style={{ marginTop: 16 }}>
        Withdrawals only go to an account in your verified name. Your first withdrawal to a new account waits 24 hours, to keep your money safe.
      </p>
    </>
  );
}

// ---------------------------------------------------------------- PIN setup

function PinSetup({ onDone }: { onDone: () => void }) {
  const [first, setFirst] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!first)
    return (
      <PinPad
        title="Create a withdrawal PIN"
        sub="4 digits. You enter it every time money leaves your wallet."
        error={err}
        onDone={async (pin) => {
          setErr(null);
          // Same strength rule as the server, so people learn before confirming.
          if (/^(\d)\1+$/.test(pin)) return setErr('Avoid the same digit four times.');
          if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return setErr('Avoid digits in a row, like 1234.');
          setFirst(pin);
        }}
      />
    );
  return (
    <PinPad
      title="Enter it again"
      error={err}
      busy={busy}
      onDone={async (pin) => {
        if (pin !== first) {
          setFirst(null);
          return setErr('The PINs did not match. Start again.');
        }
        setBusy(true);
        try {
          await api('/me/pin', { method: 'PUT', body: JSON.stringify({ pin }) });
          onDone();
        } catch (e) {
          setFirst(null);
          setErr(e instanceof ApiError ? e.message : 'Could not save the PIN.');
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

// ---------------------------------------------------------------- the flow

type Step = 'loading' | 'bank' | 'pin' | 'amount' | 'confirm' | 'reset' | 'done';

export function WithdrawFlow({ base, mode = 'withdraw' }: { base: string; mode?: 'withdraw' | 'bank' }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('loading');
  const [bank, setBank] = useState<Bank | null>(null);
  const [hasPin, setHasPin] = useState(false);
  const [wallet, setWallet] = useState<{ availableKobo: number; heldKobo: number; held: string } | null>(null);
  const [recent, setRecent] = useState<Wd[]>([]);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ state: string; message: string } | null>(null);
  const [kycNeeded, setKycNeeded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const idem = useRef(uid());

  const load = async () => {
    const [b, pin, w, list] = await Promise.all([
      api<Bank | null>('/me/bank-account'),
      api<{ set: boolean }>('/me/pin'),
      api<{ availableKobo: number; heldKobo: number; held: string }>('/me/wallet'),
      api<Wd[]>('/me/withdrawals').catch(() => []),
    ]);
    // An empty response body ("no account yet") arrives as {}.
    const account = b && b.bankCode ? b : null;
    setBank(account);
    setHasPin(pin.set);
    setWallet(w);
    setRecent(list);
    return { b: account, pin: pin.set };
  };
  useEffect(() => {
    load()
      .then(({ b, pin }) => setStep(mode === 'bank' ? 'bank' : !b ? 'bank' : !pin ? 'pin' : 'amount'))
      .catch((e) => {
        if (e instanceof ApiError && e.code === 'kyc_required') setKycNeeded(true);
        setStep('amount');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toConfirm = async () => {
    setErr(null);
    const k = toKobo(amount);
    if (!k) return setErr('Enter an amount.');
    setBusy(true);
    try {
      setQuote(await api<Quote>('/me/withdrawals/quote', { method: 'POST', body: JSON.stringify({ amountKobo: k }) }));
      setPinErr(null);
      setStep('confirm');
    } catch (e) {
      if (e instanceof ApiError && e.fields?.[0]?.field === 'bank') setStep('bank');
      setErr(e instanceof ApiError ? e.message : 'Could not check that amount.');
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (pin: string) => {
    if (!quote) return;
    setBusy(true);
    setPinErr(null);
    try {
      const r = await api<{ state: string; message: string }>('/me/withdrawals', {
        method: 'POST',
        headers: { 'Idempotency-Key': idem.current },
        body: JSON.stringify({ amountKobo: quote.amountKobo, pin }),
      });
      haptic([10, 40, 10]);
      setResult(r);
      setStep('done');
      void load();
    } catch (e) {
      const m = e instanceof ApiError ? e.message : 'Could not withdraw. Try again.';
      if (e instanceof ApiError && (e.code === 'pin_wrong' || e.code === 'pin_locked')) setPinErr(m);
      else {
        idem.current = uid();
        setErr(m);
        setStep('amount');
      }
    } finally {
      setBusy(false);
    }
  };

  const title = mode === 'bank' ? 'Bank account' : step === 'pin' ? 'Withdrawal PIN' : step === 'reset' ? 'Forgot PIN' : step === 'bank' ? 'Add a bank account' : 'Withdraw';
  const back = step === 'confirm' ? undefined : base;

  if (kycNeeded)
    return (
      <main className="app bare">
        <Header title={title} back={base} />
        <div className="card empty">
          <strong>Verify your identity first.</strong>
          Withdrawals need a verified identity, so money only goes to you.
        </div>
      </main>
    );

  return (
    <main className="app bare">
      {step === 'confirm' ? (
        <header className="header">
          <button className="back" type="button" aria-label="Back" onClick={() => setStep('amount')}>
            <Icon name="back" />
          </button>
          <h1>Confirm</h1>
        </header>
      ) : (
        <Header title={title} back={back} />
      )}

      {step === 'loading' && <div className="skeleton" style={{ height: 240 }} />}

      {step === 'bank' && (
        <BankForm
          current={bank}
          hasPin={hasPin}
          onCancel={bank ? () => (mode === 'bank' ? router.push(base) : setStep('amount')) : undefined}
          onSaved={(b) => {
            setBank(b);
            if (mode === 'bank') router.push(`${base}?bank=saved`);
            else setStep(hasPin ? 'amount' : 'pin');
          }}
        />
      )}

      {step === 'pin' && (
        <PinSetup
          onDone={() => {
            setHasPin(true);
            setStep('amount');
          }}
        />
      )}

      {step === 'amount' && wallet && (
        <>
          {notice && (
            <div className="banner info" role="status">
              <strong>PIN reset</strong>
              {notice}
            </div>
          )}
          <div className="card">
            <span className="muted">Available to withdraw</span>
            <div className="big-number">{naira(wallet.availableKobo)}</div>
            {wallet.heldKobo > 0 && <span style={{ color: 'var(--color-warning-text)', fontWeight: 600 }}>{wallet.held} pending, released after the hold</span>}
          </div>
          <label className="field" data-invalid={!!err}>
            <span>Amount (₦)</span>
            <input className="input amount-input" inputMode="decimal" value={amount} onChange={(e) => (setAmount(e.target.value), setErr(null))} placeholder="0" aria-invalid={!!err} />
            {err && <span className="field-error">{err}</span>}
          </label>
          <div className="chips" style={{ marginBottom: 12 }}>
            {[500_000, 1_000_000, 2_000_000].map((k) => (
              <button key={k} type="button" aria-pressed={toKobo(amount) === k} onClick={() => setAmount(String(k / 100))}>
                {naira(k)}
              </button>
            ))}
            <button type="button" aria-pressed={toKobo(amount) === wallet.availableKobo} onClick={() => setAmount(String(wallet.availableKobo / 100))}>
              All
            </button>
          </div>
          {bank && (
            <div className="list" style={{ marginBottom: 12 }}>
              <button type="button" className="row" onClick={() => setStep('bank')}>
                <span className="icon">
                  <Icon name="shield" />
                </span>
                <span className="grow">
                  <strong>
                    {bank.bankName}, ending {bank.lastFour}
                  </strong>
                  <span className="sub">{bank.accountName}</span>
                </span>
                <span className="link-btn">Change</span>
              </button>
            </div>
          )}
          <button className="btn block primary" type="button" disabled={busy} onClick={() => void toConfirm()} style={{ minHeight: 56 }}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
          {recent.length > 0 && (
            <>
              <p className="section-label">Recent withdrawals</p>
              <div className="list">
                {recent.slice(0, 5).map((w) => (
                  <div key={w.id} className="row" style={{ cursor: 'default' }}>
                    <span className="grow">
                      <strong>{naira(w.amountKobo)}</strong>
                      <span className="sub">
                        {w.bank} · {new Date(w.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </span>
                    </span>
                    <span className={`chip ${w.state === 'arrived' ? 'success' : w.state === 'failed_refunded' ? 'critical' : w.state === 'held_first' ? 'warning' : 'info'}`}>{w.line}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {step === 'confirm' && quote && (
        <>
          <div className="card confirm-card">
            <p className="confirm-q">{quote.confirm}</p>
            <dl className="facts-list" style={{ margin: 0 }}>
              <div>
                <dt>Amount</dt>
                <dd>{naira(quote.amountKobo)}</dd>
              </div>
              <div>
                <dt>Bank transfer fee</dt>
                <dd>−{naira(quote.feeKobo)}</dd>
              </div>
              <div>
                <dt>You receive</dt>
                <dd>{naira(quote.netKobo)}</dd>
              </div>
            </dl>
          </div>
          <PinPad title={`Enter your PIN to withdraw ${naira(quote.amountKobo)}`} error={pinErr} busy={busy} onDone={(pin) => void withdraw(pin)} onForgot={() => setStep('reset')} />
        </>
      )}

      {step === 'reset' && (
        <ResetPin
          onCancel={() => setStep(quote ? 'confirm' : 'amount')}
          onDone={(m) => {
            setNotice(m);
            setPinErr(null);
            setQuote(null);
            setStep('amount');
          }}
        />
      )}

      {step === 'done' && result && (
        <div className="done-state">
          <span className={`done-badge ${result.state === 'failed_refunded' ? 'bad' : result.state === 'held_first' ? 'wait' : ''}`} aria-hidden>
            <Icon name={result.state === 'failed_refunded' ? 'close' : result.state === 'held_first' ? 'history' : 'check'} size={40} />
          </span>
          <h2>{result.state === 'held_first' ? 'Withdrawal scheduled' : result.state === 'failed_refunded' ? 'Withdrawal failed' : 'On its way'}</h2>
          <p className="muted">
            {result.state === 'processing' && quote
              ? `${naira(quote.netKobo)} is on its way to ${quote.bank.name}. It arrives within 24 hours.`
              : result.state === 'held_first' && quote
                ? `${naira(quote.netKobo)} goes to ${quote.bank.name}, ending ${quote.bank.lastFour}. ${result.message} ${quote.holdReason === 'pin_reset' ? 'Withdrawals wait 24 hours after a PIN reset' : 'Your first withdrawal to a new account waits 24 hours'}, to keep your money safe. We will tell you when it arrives.`
                : result.message}
          </p>
          <LinkButton href={base} className="btn block primary">
            Back to wallet
          </LinkButton>
        </div>
      )}
    </main>
  );
}
