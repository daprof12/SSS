'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, setSession } from '@erp/web-ui/api';

// Dev sign-in against the seeded demo accounts. Production replaces this page
// with the OIDC provider (phone OTP first, then 2FA — C6 decision).
const ACCOUNTS = [
  { key: 'head', name: 'CSP Ngozi Eze', roleLabel: 'Station head' },
  { key: 'agencyAdmin', name: 'Agency Admin', roleLabel: 'Agency admin' },
  { key: 'platformAdmin', name: 'Platform Admin', roleLabel: 'Platform admin' },
] as const;

export default function SignIn() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signIn = async (a: (typeof ACCOUNTS)[number]) => {
    setBusy(a.key);
    setError(null);
    try {
      const seed = await api<{ users: Record<string, string> }>('/dev/seed', { method: 'POST' });
      const { token } = await api<{ token: string }>('/dev/token', { method: 'POST', body: JSON.stringify({ userId: seed.users[a.key] }) });
      setSession({ token, name: a.name, roleLabel: a.roleLabel });
      router.replace(a.key === 'head' ? '/incidents' : a.key === 'agencyAdmin' ? '/agency/overview' : '/admin/overview');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in.');
      setBusy(null);
    }
  };

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="card" style={{ width: '100%', maxWidth: 420 }}>
        <div className="brand-mark" aria-hidden style={{ marginBottom: 16 }}>
          ERP
        </div>
        <h1>Sign in</h1>
        <p className="lede">Development accounts. Two-step login is already passed for these demo users.</p>
        {error && (
          <div className="banner critical" role="alert">
            <strong>Could not sign in</strong>
            {error} Is the API running on port 4000?
          </div>
        )}
        <div className="grid">
          {ACCOUNTS.map((a) => (
            <button key={a.key} className="btn" type="button" disabled={!!busy} onClick={() => signIn(a)} style={{ justifyContent: 'space-between', display: 'flex', alignItems: 'center' }}>
              <span>{a.name}</span>
              <span className="chip neutral">{busy === a.key ? 'Signing in…' : a.roleLabel}</span>
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
