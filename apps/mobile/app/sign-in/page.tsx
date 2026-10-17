'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, setSession } from '@/lib/client';

// Dev sign-in with the seeded demo people. Production: phone OTP first (C6),
// then KYC for citizens and two-step login for officers.
const PEOPLE = [
  { key: 'citizen', name: 'Ada Obi', role: 'Citizen', surface: 'citizen' },
  { key: 'neighbour', name: 'Chidi Neighbour', role: 'Citizen', surface: 'citizen' },
  { key: 'officer', name: 'Insp. Musa Bello', role: 'Officer', surface: 'officer' },
  { key: 'officer2', name: 'Sgt. Bola Ade', role: 'Officer', surface: 'officer' },
] as const;

export default function SignIn() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const go = async (p: (typeof PEOPLE)[number]) => {
    setBusy(p.key);
    setError(null);
    try {
      const seed = await api<{ users: Record<string, string> }>('/dev/seed', { method: 'POST' });
      const { token } = await api<{ token: string }>('/dev/token', { method: 'POST', body: JSON.stringify({ userId: seed.users[p.key] }) });
      setSession({ token, name: p.name, roleLabel: p.role, surface: p.surface });
      router.replace(p.surface === 'officer' ? '/officer' : '/home');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in.');
      setBusy(null);
    }
  };

  return (
    <main className="app bare">
      <div style={{ width: 64, height: 64, borderRadius: 18, background: 'var(--color-action-primary)', color: 'var(--color-on-action-primary)', display: 'grid', placeItems: 'center', fontWeight: 800, margin: '24px 0 16px' }}>ERP</div>
      <h1 style={{ fontSize: 'var(--text-xxl)', margin: '0 0 4px', lineHeight: 1.1 }}>Welcome</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Demo accounts. In the real app you sign in with your phone number.
      </p>
      {error && (
        <div className="banner critical" role="alert">
          <strong>Could not sign in</strong>
          {error} Is the API running on port 4000?
        </div>
      )}
      <div className="list">
        {PEOPLE.map((p) => (
          <button key={p.key} className="row" type="button" disabled={!!busy} onClick={() => go(p)}>
            <span className="avatar" aria-hidden>
              {p.name
                .split(' ')
                .map((w) => w[0])
                .join('')
                .slice(0, 2)}
            </span>
            <span className="grow">
              <strong>{p.name}</strong>
              <span className="sub">{p.role}</span>
            </span>
            <span className="chip neutral">{busy === p.key ? 'Signing in…' : 'Sign in'}</span>
          </button>
        ))}
      </div>
      <p className="muted center">
        In danger right now? <a href="tel:112">Call 112</a>
      </p>
    </main>
  );
}
