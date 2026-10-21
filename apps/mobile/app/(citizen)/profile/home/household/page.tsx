'use client';

import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
import { Sheet } from '@erp/web-ui/Sheet';
import { useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { api, ApiError } from '@/lib/client';

interface Person {
  id: string;
  name: string;
  role: 'owner' | 'member' | 'invited';
  you: boolean;
  can?: { viewLive: boolean; alerts: boolean; report: boolean };
}
interface Household {
  role: 'owner' | 'member';
  maxMembers: number;
  people: Person[];
}
const ROLE = { owner: ['Owner', 'var(--color-signal-text)'], member: ['Member', 'var(--color-text-secondary)'], invited: ['Invited', 'var(--color-warning-text)'] } as const;
const PERMS = [
  ['viewLive', 'See live cameras'],
  ['alerts', 'Get alerts'],
  ['report', 'Report for the home'],
] as const;

/** Board "Household invite": invite by phone, choose what they can do, see members and invites. */
export default function Household() {
  const [h, setH] = useState<Household | null>(null);
  const [phone, setPhone] = useState('+234');
  const [can, setCan] = useState({ viewLive: true, alerts: true, report: false });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Person | null>(null);
  const [toast, setToast] = useToast();

  const load = () => api<Household>('/me/home/household').then(setH).catch(() => {});
  useEffect(() => {
    void load();
  }, []);

  const digits = phone.replace(/[^\d]/g, '');
  const ready = digits.length >= 11;
  const send = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ message: string }>('/me/home/invites', { method: 'POST', body: JSON.stringify({ phone, ...can }) });
      setToast(r.message);
      setPhone('+234');
      void load();
    } catch (e) {
      setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not send. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (p: Person) => {
    try {
      const r =
        p.role === 'invited'
          ? await api<{ message: string }>(`/me/home/invites/${p.id}`, { method: 'DELETE' })
          : await api<{ message: string }>(`/me/home/members/${p.id}`, { method: 'DELETE' });
      setToast(r.message);
      setRemoving(null);
      if (p.you) window.location.href = '/profile/home';
      else void load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not remove. Try again.');
    }
  };

  const owner = h?.role === 'owner';
  return (
    <main className="app" style={{ paddingBottom: owner ? 110 : undefined }}>
      <Header title={owner ? 'Invite to your home' : 'Household'} back="/profile/home" />
      {owner && (
        <>
          <label className="field" data-invalid={!!err} style={{ marginBottom: err ? 4 : 16 }}>
            <span>Phone number</span>
            <input type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => (setPhone(e.target.value), setErr(null))} aria-invalid={!!err} aria-describedby={err ? 'invite-err' : undefined} />
          </label>
          {err && (
            <span id="invite-err" className="field-error" role="alert" style={{ marginBottom: 12, display: 'block' }}>
              {err}
            </span>
          )}
          <p className="section-label">What can they do?</p>
          <div className="list">
            {PERMS.map(([k, l]) => (
              <div key={k} className="row" style={{ cursor: 'default' }}>
                <span className="grow">
                  <strong>{l}</strong>
                </span>
                <button className="toggle" type="button" role="switch" aria-checked={can[k]} aria-label={l} onClick={() => setCan((c) => ({ ...c, [k]: !c[k] }))} />
              </div>
            ))}
          </div>
        </>
      )}

      <p className="section-label">Members</p>
      {!h && <div className="skeleton" />}
      <div className="member-list">
        {h?.people.map((p) => (
          <div key={`${p.role}-${p.id}`} className="member-row card" style={{ margin: 0 }}>
            <Avatar name={p.name} status={p.role === 'invited' ? 'invited' : null}>
              {p.role === 'invited' ? '+' : undefined}
            </Avatar>
            <span className="grow">
              <strong>{p.name}</strong>
              {p.can && <span className="sub">{PERMS.filter(([k]) => p.can![k]).map(([, l]) => l).join(', ') || 'No access yet'}</span>}
            </span>
            <strong style={{ color: ROLE[p.role][1] }}>{ROLE[p.role][0]}</strong>
            {((owner && p.role !== 'owner') || (!owner && p.you)) && (
              <button className="link-btn" type="button" onClick={() => setRemoving(p)} aria-label={p.you ? 'Leave this home' : `Remove ${p.name}`}>
                {p.you ? 'Leave' : p.role === 'invited' ? 'Cancel' : 'Remove'}
              </button>
            )}
          </div>
        ))}
      </div>
      {h && (
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          Up to {h.maxMembers} people. Members see only what you allow; you can change it by removing and inviting again.
        </p>
      )}

      {owner && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', maxWidth: 520, margin: '0 auto' }}>
          <button className="btn block primary" type="button" onClick={send} disabled={!ready || busy} style={{ minHeight: 56 }}>
            {busy ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      )}

      <Sheet
        open={!!removing}
        title={removing?.you ? 'Leave this home?' : removing?.role === 'invited' ? 'Cancel this invite?' : `Remove ${removing?.name ?? ''}?`}
        description={removing?.you ? 'You will stop seeing its cameras and alerts.' : removing?.role === 'invited' ? 'The invite stops working.' : 'They stop seeing your cameras and alerts at once.'}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setRemoving(null)}>
              Keep
            </button>
            <button className="btn primary" type="button" onClick={() => removing && remove(removing)}>
              {removing?.you ? 'Leave home' : removing?.role === 'invited' ? 'Cancel invite' : `Remove ${removing?.name ?? ''}`}
            </button>
          </>
        }
      >
        <span />
      </Sheet>
      <Toast msg={toast} />
    </main>
  );
}
