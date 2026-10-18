'use client';
// Security: two-step login status and where the account is signed in; end other sessions.
import { useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError } from '@/lib/client';

interface Session {
  id: string;
  label: string;
  platform: string | null;
  lastSeen: string;
  signedIn: string;
  current: boolean;
}

export default function Security() {
  const [list, setList] = useState<Session[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const load = () => api<Session[]>('/auth/sessions').then(setList).catch(() => setList([]));
  useEffect(() => {
    void load();
  }, []);
  const end = async (id: string) => {
    setBusy(id);
    try {
      await api(`/auth/sessions/${id}`, { method: 'DELETE' });
      setToast('Signed out on that device.');
      await load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not end that session.');
    } finally {
      setBusy(null);
    }
  };
  const others = list?.filter((s) => !s.current) ?? [];
  return (
    <main className="app">
      <Header title="Security" back="/officer/profile" />
      <div className="banner success">
        <strong>Two-step login is on</strong>
        Officers always confirm a second step when signing in. This keeps dispatch and evidence safe.
      </div>
      <p className="section-label">Where you are signed in</p>
      {!list ? (
        <div className="skeleton" />
      ) : (
        <div className="list">
          {list.map((s) => (
            <div key={s.id} className="row" style={{ cursor: 'default' }}>
              <span className="icon">
                <Icon name="phone" />
              </span>
              <span className="grow">
                <strong>
                  {s.label}
                  {s.current ? ' (this phone)' : ''}
                </strong>
                <span className="sub">Last used {new Date(s.lastSeen).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              </span>
              {!s.current && (
                <button type="button" className="btn small" disabled={busy === s.id} onClick={() => void end(s.id)}>
                  {busy === s.id ? 'Ending…' : 'Sign out'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {others.length > 1 && (
        <button type="button" className="btn block" style={{ marginTop: 12 }} disabled={!!busy} onClick={async () => { for (const s of others) await end(s.id); }}>
          Sign out of all other devices
        </button>
      )}
      <p className="muted">If you lose your phone, ask your station head to suspend your account at once.</p>
      <Toast msg={toast} />
    </main>
  );
}
