'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { api, ApiError } from '@/lib/client';

/** Welcome and phone entry (boards "Welcome sign up or log in", "Sign in"). Phone first (C6). */
export default function SignIn() {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ phone: string }>('/auth/otp/start', { method: 'POST', body: JSON.stringify({ phone }) });
      router.push(`/sign-in/code?phone=${encodeURIComponent(phone)}&masked=${encodeURIComponent(r.phone)}`);
    } catch (x) {
      // A cooldown still means a code is on its way: go to the code screen.
      if (x instanceof ApiError && x.code === 'resend_cooldown') return router.push(`/sign-in/code?phone=${encodeURIComponent(phone)}`);
      setErr(x instanceof ApiError ? x.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <main className="app bare">
      <div style={{ width: 64, height: 64, borderRadius: 18, background: 'var(--color-action-primary)', color: 'var(--color-on-action-primary)', display: 'grid', placeItems: 'center', fontWeight: 800, margin: '32px 0 20px' }}>ERP</div>
      <h1 style={{ fontSize: 'var(--text-xxl)', margin: '0 0 8px', lineHeight: 1.1 }}>Help in two taps</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 'var(--text-md)' }}>
        Report an emergency, and follow help to your exact building.
      </p>

      <form onSubmit={go} noValidate style={{ marginTop: 32 }}>
        <label className="field" data-invalid={!!err}>
          <span>Your phone number</span>
          <input
            className="input"
            type="tel"
            aria-label="Your phone number"
            inputMode="tel"
            autoComplete="tel"
            placeholder="0803 123 4567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            aria-invalid={!!err}
            aria-describedby={err ? 'phone-err' : 'phone-help'}
            style={{ fontSize: 'var(--text-lg)' }}
          />
          {err ? (
            <span className="field-error" id="phone-err" role="alert">
              {err}
            </span>
          ) : (
            <span className="muted" id="phone-help">
              We send a 6-digit code by SMS. New here? This creates your account.
            </span>
          )}
        </label>
        <button className="btn block primary" type="submit" disabled={busy || phone.replace(/\D/g, '').length < 10}>
          {busy ? 'Sending code…' : 'Continue'}
        </button>
      </form>

      <a className="btn block" href="tel:112" style={{ marginTop: 12 }}>
        <Icon name="phone" /> In danger now? Call 112
      </a>
      <p className="muted center" style={{ marginTop: 24 }}>
        By continuing you agree to the Terms and Privacy notice.
      </p>
      {process.env.NODE_ENV !== 'production' && (
        <p className="center">
          <Link href="/sign-in/demo">Demo accounts (development)</Link>
        </p>
      )}
    </main>
  );
}
