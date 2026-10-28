'use client';
// Messages on one report between the citizen who made it and the officers and staff responding to it.
// Either side can write first. Refreshes every few seconds; the other side gets a notification.
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

interface Msg {
  id: number;
  body: string;
  side: 'citizen' | 'responder';
  mine: boolean;
  name: string;
  at: string;
}

export function ReportMessages({ incidentId, perspective, refreshMs = 6000 }: { incidentId: string; perspective: 'citizen' | 'responder'; refreshMs?: number }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      setMsgs((await api<{ messages: Msg[] }>(`/incidents/${incidentId}/messages`)).messages);
    } catch {
      setMsgs((m) => m ?? []);
    }
  };
  useEffect(() => {
    void load();
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId, refreshMs]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [msgs?.length]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    setErr(null);
    try {
      await api(`/incidents/${incidentId}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
      setText('');
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not send. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const other = perspective === 'citizen' ? 'the officers on your report' : 'the person who reported this';
  return (
    <section className="card" aria-labelledby={`msg-${incidentId}`} style={{ display: 'grid', gap: 10 }}>
      <h2 id={`msg-${incidentId}`} style={{ margin: 0, fontSize: 'var(--text-md, 1rem)' }}>
        Messages
      </h2>
      <div role="log" aria-live="polite" style={{ display: 'grid', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
        {msgs === null ? (
          <div className="skeleton" style={{ height: 48 }} />
        ) : !msgs.length ? (
          <span className="muted">No messages yet. Write to {other}.</span>
        ) : (
          msgs.map((m) => (
            <div key={m.id} style={{ justifySelf: m.mine ? 'end' : 'start', maxWidth: '85%', padding: '8px 12px', borderRadius: 14, background: m.mine ? 'var(--color-action-primary, #e11d48)' : 'var(--color-surface-raised, #1e1e1e)', color: m.mine ? '#fff' : 'inherit' }}>
              {!m.mine && <strong style={{ display: 'block', fontSize: 12 }}>{m.name}</strong>}
              <span style={{ overflowWrap: 'anywhere' }}>{m.body}</span>
              <small style={{ display: 'block', opacity: 0.7, fontSize: 11 }}>{new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
            </div>
          ))
        )}
        <div ref={end} />
      </div>
      {err && (
        <span className="field-error" role="alert">
          {err}
        </span>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        style={{ display: 'flex', gap: 8 }}
      >
        <input type="text" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder={`Message ${other}`} aria-label="Message" style={{ flex: 1, minWidth: 0 }} />
        <button className="btn primary" type="submit" disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
