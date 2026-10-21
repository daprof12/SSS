'use client';
// A message to the support team with a reference (Help and support; "Message team" on a repair).
import { Sheet } from '@erp/web-ui/Sheet';
import { useState } from 'react';
import { api, ApiError } from '@/lib/client';

export const TOPICS = [
  ['report', 'A report'],
  ['money', 'Money'],
  ['device', 'Home devices'],
  ['account', 'My account'],
  ['app', 'The app'],
  ['other', 'Something else'],
] as const;

export function MessageSheet({ topic: initial = 'app', relatedId, title = 'Send us a message', onClose, onSent }: { topic?: string; relatedId?: string; title?: string; onClose: () => void; onSent: (m: string) => void }) {
  const [topic, setTopic] = useState(initial);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    if (body.trim().length < 10) return setErr('Tell us a little more, at least 10 characters.');
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ message: string }>('/me/support/tickets', { method: 'POST', body: JSON.stringify({ topic, body: body.trim(), relatedId }) });
      onSent(r.message);
    } catch (e) {
      setErr(e instanceof ApiError ? (e.fields?.[0]?.message ?? e.message) : 'Could not send. Try again.');
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={send} disabled={busy}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </>
      }
    >
      {!relatedId && (
        <div className="chips" role="group" aria-label="What is it about?" style={{ marginBottom: 12 }}>
          {TOPICS.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={topic === k} onClick={() => setTopic(k)}>
              {l}
            </button>
          ))}
        </div>
      )}
      <label className="field" data-invalid={!!err} style={{ marginBottom: 0 }}>
        <span>Your message</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} aria-invalid={!!err} placeholder="What happened, and what you need from us." />
      </label>
      {err && <span className="field-error">{err}</span>}
    </Sheet>
  );
}
