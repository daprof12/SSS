'use client';
// Sign out (citizen and officer): an in-app confirmation (browser pop-ups are blocked in installed
// apps), a visible "Signing out…" state, and a message on the sign-in screen afterwards. An officer
// on duty is taken off duty first, so the station stops offering them reports.
import { Sheet } from '@erp/web-ui/Sheet';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { api, setSession } from '@/lib/client';

export function SignOutButton({ onDuty = false }: { onDuty?: boolean }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const out = async () => {
    setBusy(true);
    setErr(null);
    if (onDuty) {
      const ok = await api('/me/officer/duty', { method: 'PATCH', body: JSON.stringify({ onDuty: false }) })
        .then(() => true)
        .catch(() => false);
      if (!ok) {
        setBusy(false);
        return setErr('Could not take you off duty. Check your connection and try again.');
      }
    }
    // Revoke on the server first, so this device's tokens stop working at once.
    await api('/auth/sign-out', { method: 'POST', body: '{}' }).catch(() => {});
    setSession(null);
    router.replace('/sign-in?signedOut=1');
  };
  return (
    <>
      <button className="row" type="button" onClick={() => setAsking(true)} disabled={busy}>
        <span className="icon">
          <Icon name="out" />
        </span>
        <span className="grow">
          <strong>{busy ? 'Signing out…' : 'Sign out'}</strong>
          {onDuty && <span className="sub">You will be taken off duty</span>}
        </span>
      </button>
      <Sheet
        open={asking}
        title="Sign out?"
        description={onDuty ? 'You are on duty. Signing out takes you off duty, so new reports go to other officers.' : 'You will need your phone number and a code to sign in again.'}
        onClose={() => !busy && setAsking(false)}
        busy={busy}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setAsking(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn primary" type="button" onClick={out} disabled={busy}>
              {busy ? 'Signing out…' : onDuty ? 'Go off duty and sign out' : 'Sign out'}
            </button>
          </>
        }
      >
        {err && (
          <div className="banner critical" role="alert" style={{ margin: 0 }}>
            {err}
          </div>
        )}
      </Sheet>
    </>
  );
}
