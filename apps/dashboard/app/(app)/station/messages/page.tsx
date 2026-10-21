'use client';
// Board "Station messages": message officers on duty, everyone, or one officer; see who read it.
import { api, ApiError } from '@erp/web-ui/api';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';

interface Data {
  audience: { onDuty: number; everyone: number };
  officers: { id: string; name: string }[];
  recent: { id: string; title: string; body: string; urgent: boolean; needsConfirm: boolean; audience: string; total: number; read: number; confirmed: number; at: string }[];
}
interface Detail {
  id: string;
  title: string;
  needsConfirm: boolean;
  recipients: { id: string; name: string; readAt: string | null; confirmedAt: string | null }[];
}
type Aud = 'on_duty' | 'everyone' | 'officer';

export default function Messages() {
  const [d, setD] = useState<Data | null>(null);
  const [aud, setAud] = useState<Aud>('on_duty');
  const [officer, setOfficer] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [confirm, setConfirm] = useState(true);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Detail | null>(null);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<Data>('/me/station/messages')
      .then((x) => {
        setD(x);
        if (x.recent[0]) api<Detail>(`/me/station/messages/${x.recent[0].id}`).then(setOpen).catch(() => {});
      })
      .catch(() => {});
  }, []);
  useEffect(load, [load]);
  const count = aud === 'on_duty' ? d?.audience.onDuty : aud === 'everyone' ? d?.audience.everyone : officer ? 1 : 0;
  const send = async (test: boolean) => {
    setTried(true);
    if (!body.trim() || !title.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ message: string }>('/me/station/messages', { method: 'POST', body: JSON.stringify({ audience: aud, officerId: officer || undefined, title, body, urgent, needsConfirm: confirm, test }) });
      setToast(r.message);
      if (!test) {
        setTitle('');
        setBody('');
        setTried(false);
      }
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not send.');
    } finally {
      setBusy(false);
    }
  };
  const read = open?.recipients.filter((r) => r.readAt).length ?? 0;
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Messages</h1>
          <p className="lede">Message your officers and staff, in the app with a notification.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" type="button" disabled={busy} onClick={() => send(true)}>
            Send test to me
          </button>
          <button className="btn signal" type="button" disabled={busy} onClick={() => send(false)}>
            Send
          </button>
        </div>
      </div>
      <div className="grid two">
        <section className="card" aria-labelledby="who">
          <h2 id="who" style={{ marginTop: 0 }}>
            1. Who
          </h2>
          <div style={{ display: 'grid', gap: 8 }}>
            {(
              [
                ['on_duty', 'Officers on duty now'],
                ['everyone', 'Everyone at the station'],
                ['officer', 'One officer'],
              ] as [Aud, string][]
            ).map(([k, l]) => (
              <button key={k} type="button" className="choice-card" aria-pressed={aud === k} onClick={() => setAud(k)}>
                <strong>{l}</strong>
              </button>
            ))}
          </div>
          {aud === 'officer' && (
            <label className="field" style={{ marginTop: 12 }}>
              <span>Officer</span>
              <select value={officer} onChange={(e) => setOfficer(e.target.value)}>
                <option value="">Choose…</option>
                {d?.officers.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="banner info" style={{ marginTop: 12, marginBottom: 0 }}>
            <strong>Audience</strong>
            {count ?? '…'} {count === 1 ? 'officer' : 'officers'} get it in the app with a notification.
          </div>
        </section>
        <section className="card" aria-labelledby="how">
          <h2 id="how" style={{ marginTop: 0 }}>
            2. How
          </h2>
          <div className="row">
            <div className="label">
              <strong>Urgent</strong>
              <span>Goes to the dispatch channel. Use for danger or a station call-out only.</span>
            </div>
            <button className="toggle" type="button" role="switch" aria-checked={urgent} aria-label="Urgent" onClick={() => setUrgent((v) => !v)} />
          </div>
          <div className="row">
            <div className="label">
              <strong>Needs reply</strong>
              <span>Officers must confirm they read it.</span>
            </div>
            <button className="toggle" type="button" role="switch" aria-checked={confirm} aria-label="Officers must confirm" onClick={() => setConfirm((v) => !v)} />
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            SMS and WhatsApp fallback come with the messaging provider; today messages are in-app with a notification.
          </p>
        </section>
      </div>
      <section className="card" aria-labelledby="msg">
        <h2 id="msg" style={{ marginTop: 0 }}>
          3. Message
        </h2>
        <label className="field" data-invalid={tried && !title.trim()}>
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Roster change tonight" aria-invalid={tried && !title.trim()} />
          {tried && !title.trim() && <span className="field-error">Give it a title.</span>}
        </label>
        <label className="field" data-invalid={tried && !body.trim()}>
          <span>Message</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={4} aria-invalid={tried && !body.trim()} />
          {tried && !body.trim() && <span className="field-error">Write a message before sending.</span>}
        </label>
        {urgent && (
          <div className="banner warning" style={{ marginBottom: 0 }}>
            <strong>Urgent messages</strong>Urgent ignores quiet hours. Use for danger or a station call-out only.
          </div>
        )}
      </section>
      <div className="grid two">
        <section className="card" aria-labelledby="read">
          <h2 id="read" style={{ marginTop: 0 }}>
            Who has read it{open ? `: ${open.title}` : ''}
          </h2>
          {!open && <p className="muted">Send a message to see who read it.</p>}
          {open && (
            <>
              <dl className="facts">
                <div>
                  <dt>Read</dt>
                  <dd className="success">
                    {read} of {open.recipients.length}
                  </dd>
                </div>
                <div>
                  <dt>Not yet</dt>
                  <dd className="warning">{open.recipients.length - read}</dd>
                </div>
                {open.needsConfirm && (
                  <div>
                    <dt>Confirmed</dt>
                    <dd>{open.recipients.filter((r) => r.confirmedAt).length}</dd>
                  </div>
                )}
              </dl>
              {open.recipients.map((r) => (
                <div className="row" key={r.id}>
                  <span>{r.name}</span>
                  <span className={`chip ${r.confirmedAt ? 'success' : r.readAt ? 'info' : 'warning'}`}>{r.confirmedAt ? 'Confirmed' : r.readAt ? 'Read' : 'Not yet'}</span>
                </div>
              ))}
              <button
                className="btn signal"
                type="button"
                style={{ marginTop: 12 }}
                onClick={async () => {
                  try {
                    setToast((await api<{ message: string }>(`/me/station/messages/${open.id}/resend`, { method: 'POST' })).message);
                  } catch (e) {
                    setToast(e instanceof ApiError ? e.message : 'Could not resend.');
                  }
                }}
              >
                Resend to unread
              </button>
            </>
          )}
        </section>
        <section className="card" aria-labelledby="recent">
          <h2 id="recent" style={{ marginTop: 0 }}>
            Recent messages
          </h2>
          {d?.recent.length === 0 && <p className="muted">No messages yet.</p>}
          {d?.recent.map((m) => (
            <button key={m.id} type="button" className="row" style={{ width: '100%', background: 'none', border: 0, color: 'inherit', cursor: 'pointer', textAlign: 'left' }} onClick={() => api<Detail>(`/me/station/messages/${m.id}`).then(setOpen)}>
              <span className="muted">{new Date(m.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              <strong>
                {m.title}, {m.read === m.total ? 'read by all' : `read by ${m.read} of ${m.total}`}
                {m.needsConfirm ? `, ${m.confirmed} confirmed` : ''}
              </strong>
            </button>
          ))}
        </section>
      </div>
    </>
  );
}
