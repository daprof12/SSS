'use client';
// Help inbox → Live chats: conversations the assistant handed over (or the person asked for a person).
// The help team replies in the same chat, adds notes only the team sees, hands back to the
// assistant, or closes it. Opening a chat checks for new messages every few seconds.
import { api, ApiError } from '@erp/web-ui/api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dateTime } from '@/components/Agency';

interface Item {
  id: string;
  state: string;
  stateLabel: string;
  handoffReason: string | null;
  person: string;
  surface: string;
  assignee: string | null;
  last: string | null;
  messages: number;
  at: string;
}
interface Chat {
  id: string;
  state: string;
  stateLabel: string;
  handoffReason: string | null;
  person: string;
  phone: string | null;
  surface: string;
  ticket: string | null;
  rating: number | null;
  messages: { id: number; role: 'user' | 'bot' | 'agent' | 'note'; body: string; author: string | null; at: string }[];
}
const FILTERS: [string, string][] = [
  ['open', 'Needs a person'],
  ['bot', 'With the assistant'],
  ['closed', 'Closed'],
  ['all', 'All'],
];
const TONE: Record<string, string> = { waiting_human: 'critical', human: 'info', bot: 'neutral', closed: 'neutral' };

export function HelpChats({ onToast, initial }: { onToast: (m: string) => void; initial?: string | null }) {
  const [status, setStatus] = useState('open');
  const [list, setList] = useState<{ counts: Record<string, number>; items: Item[] } | null>(null);
  const [sel, setSel] = useState<string | null>(initial ?? null);
  const [chat, setChat] = useState<Chat | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const loadList = useCallback(() => {
    api<typeof list>(`/admin/support/chats?status=${status}`)
      .then(setList)
      .catch(() => setList({ counts: {}, items: [] }));
  }, [status]);
  useEffect(loadList, [loadList]);
  const loadChat = useCallback(() => {
    if (!sel) return setChat(null);
    api<Chat>(`/admin/support/chats/${sel}`)
      .then(setChat)
      .catch((e) => onToast(e instanceof ApiError ? e.message : 'Could not open the chat.'));
  }, [sel, onToast]);
  useEffect(loadChat, [loadChat]);
  useEffect(() => {
    if (!sel) return;
    const t = setInterval(() => (loadChat(), loadList()), 5000);
    return () => clearInterval(t);
  }, [sel, loadChat, loadList]);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [chat?.messages.length]);

  const act = async (path: string, body?: object) => {
    setBusy(true);
    try {
      onToast((await api<{ message: string }>(`/admin/support/chats/${sel}/${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) })).message);
      if (body) setText('');
      loadChat();
      loadList();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : 'Could not do that.');
    } finally {
      setBusy(false);
    }
  };
  const waiting = list?.counts.waiting_human ?? 0;
  return (
    <div className="grid two" style={{ gridTemplateColumns: 'minmax(260px, 1fr) minmax(0, 2fr)' }}>
      <section className="card" style={{ padding: 0 }}>
        <div className="segmented" role="group" aria-label="Chats" style={{ margin: 12, flexWrap: 'wrap' }}>
          {FILTERS.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)}>
              {l}
              {k === 'open' && waiting ? ` ${waiting}` : ''}
            </button>
          ))}
        </div>
        {!list && <div className="skeleton" style={{ margin: 12 }} />}
        {list?.items.length === 0 && <div className="empty">No chats here.</div>}
        {list?.items.map((c) => (
          <button
            key={c.id}
            type="button"
            className="row"
            onClick={() => setSel(c.id)}
            style={{ width: '100%', border: 0, background: sel === c.id ? 'var(--color-surface-sunken)' : 'transparent', color: 'inherit', textAlign: 'left', padding: '10px 14px', cursor: 'pointer' }}
          >
            <div className="label">
              <strong>
                {c.person} <span className="muted">({c.surface})</span>
              </strong>
              <span>{c.handoffReason ?? c.last ?? '—'}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {dateTime(c.at)}
                {c.assignee ? `, with ${c.assignee}` : ''}
              </span>
            </div>
            <span className={`chip ${TONE[c.state] ?? 'neutral'}`}>{c.stateLabel}</span>
          </button>
        ))}
      </section>
      <section className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 480 }}>
        {!chat ? (
          <p className="muted">Choose a chat. The assistant answers first; it hands chats here when the person asks for a person, or when it cannot help.</p>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div>
                <h2 style={{ margin: 0 }}>{chat.person}</h2>
                <p className="muted" style={{ margin: 0 }}>
                  {chat.surface} app{chat.phone ? `, ${chat.phone}` : ''}
                  {chat.ticket ? `, ticket ${chat.ticket}` : ''}
                  {chat.rating ? `, rated ${chat.rating} of 5` : ''}
                </p>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {chat.state !== 'bot' && chat.state !== 'closed' && (
                  <button className="btn small" type="button" disabled={busy} onClick={() => act('release')}>
                    Hand back to assistant
                  </button>
                )}
                {chat.state !== 'closed' && (
                  <button className="btn small" type="button" disabled={busy} onClick={() => act('close')}>
                    Close chat
                  </button>
                )}
              </div>
            </div>
            {chat.handoffReason && (
              <div className="banner warning" style={{ margin: '10px 0 0' }}>
                <strong style={{ display: 'block' }}>Why it came to a person</strong>
                {chat.handoffReason}
              </div>
            )}
            <div ref={box} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0', maxHeight: 460 }}>
              {chat.messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    alignSelf: m.role === 'user' ? 'flex-start' : 'flex-end',
                    maxWidth: '80%',
                    padding: '8px 12px',
                    borderRadius: 12,
                    border: '1px solid var(--color-divider)',
                    background: m.role === 'note' ? 'color-mix(in srgb, var(--color-warning) 14%, transparent)' : m.role === 'agent' ? 'color-mix(in srgb, var(--color-success) 12%, transparent)' : m.role === 'bot' ? 'var(--color-surface-sunken)' : 'var(--color-surface)',
                  }}
                >
                  <small className="muted">
                    {m.role === 'user' ? chat.person : m.role === 'bot' ? 'Assistant' : m.role === 'note' ? `Note by ${m.author} (team only)` : m.author}, {dateTime(m.at)}
                  </small>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
                </div>
              ))}
            </div>
            {chat.state !== 'closed' && (
              <>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={4000} placeholder="Write a reply they will see, or a note for the team" aria-label="Reply" />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                  <button className="btn" type="button" disabled={busy || text.trim().length < 2} onClick={() => act('note', { body: text })}>
                    Add note
                  </button>
                  <button className="btn primary" type="button" disabled={busy || text.trim().length < 2} onClick={() => act('reply', { body: text })}>
                    {chat.state === 'waiting_human' ? 'Take chat and reply' : 'Reply'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
