'use client';

import { Avatar } from '@erp/web-ui/Avatar';
import { Rating } from '@erp/web-ui/Rating';
import { Sheet } from '@erp/web-ui/Sheet';
import { useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError } from '@/lib/client';

interface Contact {
  id: string;
  name: string;
  phone: string;
  share_location: boolean;
  include_violence_reports: boolean;
}

/** Emergency contacts (MVP, decided 2026-10-17): up to 3, get an area-only link when you send SOS. */
export default function Contacts() {
  const [list, setList] = useState<Contact[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Contact | null>(null);
  const [toast, setToast] = useToast();

  const load = () => api<{ contacts: Contact[] }>('/me/emergency-contacts').then((r) => setList(r.contacts)).catch(() => setList([]));
  useEffect(() => {
    void load();
  }, []);

  return (
    <main className="app">
      <Header title="Emergency contacts" back="/profile" />
      <p className="muted" style={{ marginTop: -8 }}>
        When you send SOS, they get a text with a link showing your status and the general area, never your exact building. Not sent for discreet reports.
      </p>
      {list === null && [0, 1].map((i) => <div key={i} className="skeleton" />)}
      {list?.length === 0 && (
        <div className="empty">
          <strong>No contacts yet.</strong>
          Add up to 3 people who should know when you need help.
        </div>
      )}
      {list && list.length > 0 && (
        <div className="list">
          {list.map((c) => (
            <div key={c.id} className="row" style={{ cursor: 'default' }}>
              <Avatar name={c.name} />
              <span className="grow">
                <strong>{c.name}</strong>
                <span className="sub">
                  {c.phone}
                  {c.share_location ? ' · sees your live location' : ''}
                </span>
              </span>
              <button className="link-btn" type="button" onClick={() => setRemoving(c)} aria-label={`Remove ${c.name}`}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <button className="btn block signal" type="button" disabled={!list || list.length >= 3} onClick={() => setAdding(true)}>
        <Icon name="plus" /> {list && list.length >= 3 ? 'You have 3 contacts' : 'Add a contact'}
      </button>

      {adding && (
        <AddSheet
          onClose={() => setAdding(false)}
          onDone={(name) => {
            setAdding(false);
            setToast(`${name} added.`);
            void load();
          }}
        />
      )}
      <Sheet
        open={!!removing}
        title={`Remove ${removing?.name ?? ''}?`}
        description="They will no longer be told when you send SOS."
        onClose={() => setRemoving(null)}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setRemoving(null)}>
              Keep
            </button>
            <button
              className="btn primary"
              type="button"
              onClick={async () => {
                const c = removing!;
                await api(`/me/emergency-contacts/${c.id}`, { method: 'DELETE' }).catch(() => {});
                setRemoving(null);
                setToast(`${c.name} removed.`);
                void load();
              }}
            >
              Remove {removing?.name}
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

function AddSheet({ onClose, onDone }: { onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('+234');
  const [share, setShare] = useState(false);
  const [violence, setViolence] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});

  const normalise = (p: string) => {
    const d = p.replace(/[^\d+]/g, '');
    return d.startsWith('0') ? `+234${d.slice(1)}` : d;
  };
  const save = async () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Enter their name.';
    if (!/^\+234\d{10}$/.test(normalise(phone))) e.phone = 'Enter a Nigerian phone number.';
    setErrs(e);
    if (Object.keys(e).length) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.sheet [aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    try {
      await api('/me/emergency-contacts', { method: 'POST', body: JSON.stringify({ name: name.trim(), phone: normalise(phone), shareLocation: share, includeViolenceReports: violence }) });
      onDone(name.trim());
    } catch (err) {
      setErrs({ form: err instanceof ApiError ? err.message : 'Could not save. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      title="Add an emergency contact"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn signal" type="button" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Add contact'}
          </button>
        </>
      }
    >
      {errs.form && <div className="banner critical">{errs.form}</div>}
      <label className="field" data-invalid={!!errs.name} style={{ marginBottom: 0 }}>
        <span>Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errs.name} autoComplete="name" />
        {errs.name && <span className="field-error">{errs.name}</span>}
      </label>
      <label className="field" data-invalid={!!errs.phone} style={{ marginBottom: 0 }}>
        <span>Phone</span>
        <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!errs.phone} inputMode="tel" autoComplete="tel" />
        {errs.phone && <span className="field-error">{errs.phone}</span>}
      </label>
      <div className="row" style={{ padding: 0 }}>
        <span className="grow">
          <strong>Share my live location</strong>
          <span className="sub">Only while help is on the way</span>
        </span>
        <button className="toggle" type="button" role="switch" aria-checked={share} aria-label="Share my live location" onClick={() => setShare((v) => !v)} />
      </div>
      <div className="row" style={{ padding: 0 }}>
        <span className="grow">
          <strong>Include violence reports</strong>
          <span className="sub">Off by default for your safety</span>
        </span>
        <button className="toggle" type="button" role="switch" aria-checked={violence} aria-label="Include violence reports" onClick={() => setViolence((v) => !v)} />
      </div>
    </Sheet>
  );
}
