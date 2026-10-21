'use client';
// Floating help chat (citizen and officer apps, staff dashboards). The assistant answers first; the
// person can ask for someone on the help team at any time, and the team's replies arrive here. While
// a person has the chat it checks for new messages every few seconds.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

interface Msg {
  id: number;
  role: 'user' | 'bot' | 'agent';
  body: string;
  sources: { title: string; url?: string }[];
  author: string | null;
  at: string;
}
interface Chat {
  id: string;
  state: 'bot' | 'waiting_human' | 'human' | 'closed';
  stateLabel: string;
  messages: Msg[];
}
/** Any page can open the chat: window.dispatchEvent(new Event(OPEN_HELP_CHAT)). */
export const OPEN_HELP_CHAT = 'erp:open-help-chat';
export const openHelpChat = () => window.dispatchEvent(new Event(OPEN_HELP_CHAT));
const SUGGESTIONS = ['How do I report an emergency?', 'Which agency handles fake drugs?', 'How do statements work?', 'Where is my withdrawal?'];

export function HelpChat({ bottom = 24, suggestions = SUGGESTIONS }: { bottom?: number; suggestions?: string[] }) {
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState<Chat | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [unread, setUnread] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const merge = useCallback((x: Chat | null, replace = false) => {
    if (!x || !('id' in x)) return setChat(null);
    setChat((c) => {
      if (replace || !c || c.id !== x.id) return x;
      const seen = new Set(c.messages.map((m) => m.id));
      const fresh = x.messages.filter((m) => !seen.has(m.id));
      if (fresh.some((m) => m.role !== 'user')) setUnread(true);
      return { ...x, messages: [...c.messages, ...fresh] };
    });
  }, []);

  // Load the open chat once; open it straight away when a link says so (?chat=open).
  useEffect(() => {
    api<Chat | Record<string, never>>('/me/help/chat')
      .then((x) => merge('id' in x ? (x as Chat) : null, true))
      .catch(() => {});
    if (new URLSearchParams(window.location.search).get('chat') === 'open') setOpen(true);
    const show = () => setOpen(true);
    window.addEventListener(OPEN_HELP_CHAT, show);
    return () => window.removeEventListener(OPEN_HELP_CHAT, show);
  }, [merge]);

  // A person has it: check for their replies (often while open, now and then while closed).
  useEffect(() => {
    if (!chat || chat.state === 'bot' || chat.state === 'closed') return;
    const t = setInterval(() => {
      const last = chat.messages.at(-1)?.id ?? 0;
      api<Chat>(`/me/help/chat/${chat.id}?after=${last}`)
        .then((x) => merge(x))
        .catch(() => {});
    }, open ? 4000 : 15000);
    return () => clearInterval(t);
  }, [chat, open, merge]);

  useEffect(() => {
    if (open) {
      setUnread(false);
      setTimeout(() => list.current?.scrollTo({ top: list.current.scrollHeight }), 0);
      input.current?.focus();
    }
  }, [open, chat?.messages.length]);

  const send = async (message: string) => {
    const m = message.trim();
    if (!m || busy) return;
    setBusy(true);
    setErr(null);
    setText('');
    // Show it straight away; the server's copy replaces it.
    setChat((c) => (c ? { ...c, messages: [...c.messages, { id: -Date.now(), role: 'user', body: m, sources: [], author: null, at: new Date().toISOString() }] } : c));
    try {
      const x = await api<Chat>('/me/help/chat', { method: 'POST', body: JSON.stringify({ message: m, conversationId: chat && chat.state !== 'closed' ? chat.id : undefined }) });
      setChat((c) => (c && c.id === x.id ? { ...x, messages: [...c.messages.filter((y) => y.id > 0), ...x.messages] } : x));
      setUnread(false);
    } catch (e) {
      setChat((c) => (c ? { ...c, messages: c.messages.filter((y) => y.id > 0) } : c));
      setText(m);
      setErr(e instanceof ApiError ? e.message : 'Could not send. Check your connection.');
    } finally {
      setBusy(false);
    }
  };
  const human = async () => {
    if (!chat) return send('I would like to talk to a person, please.');
    setBusy(true);
    try {
      merge(await api<Chat>(`/me/help/chat/${chat.id}/human`, { method: 'POST', body: '{}' }), true);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not reach the help team.');
    } finally {
      setBusy(false);
    }
  };
  const end = async () => {
    if (!chat) return setOpen(false);
    await api(`/me/help/chat/${chat.id}/close`, { method: 'POST', body: '{}' }).catch(() => {});
    setChat(null);
  };

  return (
    <>
      <style>{CSS}</style>
      {!open && (
        <button type="button" className="hc-fab" style={{ bottom }} onClick={() => setOpen(true)} aria-label={unread ? 'Help chat, new reply' : 'Help chat'}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>Help</span>
          {unread && <i className="hc-dot" aria-hidden />}
        </button>
      )}
      {open && (
        <section className="hc-panel" style={{ bottom }} role="dialog" aria-label="Help chat">
          <header className="hc-head">
            <div>
              <strong>Help</strong>
              <small>{chat ? chat.stateLabel : 'Assistant, with people on the help team'}</small>
            </div>
            <div className="hc-actions">
              {chat?.state === 'bot' || !chat ? (
                <button type="button" onClick={human} disabled={busy}>
                  Talk to a person
                </button>
              ) : null}
              {chat && (
                <button type="button" onClick={end}>
                  End chat
                </button>
              )}
              <button type="button" onClick={() => setOpen(false)} aria-label="Minimise help chat">
                ✕
              </button>
            </div>
          </header>
          <div className="hc-sos">In danger now? Press SOS or call 112.</div>
          <div className="hc-list" ref={list} aria-live="polite">
            {!chat?.messages.length && (
              <div className="hc-empty">
                <p>Ask anything: reporting, statements, fines, money, devices, agencies, or anything else on your mind.</p>
                <div className="hc-sugs">
                  {suggestions.map((s) => (
                    <button key={s} type="button" onClick={() => send(s)} disabled={busy}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {chat?.messages.map((m) => (
              <div key={m.id} className={`hc-msg ${m.role}`}>
                {m.role !== 'user' && <small>{m.role === 'agent' ? `${m.author}, help team` : 'Assistant'}</small>}
                <p>{m.body}</p>
                {!!m.sources?.length && (
                  <ul>
                    {m.sources.map((s) => (
                      <li key={s.url ?? s.title}>
                        {s.url ? (
                          <a href={s.url} target={s.url.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
                            {s.title}
                          </a>
                        ) : (
                          s.title
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            {busy && (
              <div className="hc-msg bot">
                <small>Assistant</small>
                <p className="hc-typing">Thinking…</p>
              </div>
            )}
            {chat?.state === 'waiting_human' && <div className="hc-note">A person from the help team will join here. You can keep this open or come back later.</div>}
          </div>
          {err && (
            <div className="hc-err" role="alert">
              {err}
            </div>
          )}
          <form
            className="hc-input"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <textarea
              ref={input}
              rows={1}
              value={text}
              maxLength={4000}
              placeholder="Type your question"
              aria-label="Your message"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(text);
                }
              }}
            />
            <button type="submit" disabled={busy || !text.trim()}>
              Send
            </button>
          </form>
        </section>
      )}
    </>
  );
}

const CSS = `
.hc-fab{position:fixed;right:16px;z-index:60;display:flex;align-items:center;gap:8px;padding:0 18px;height:48px;border-radius:24px;border:0;background:var(--color-signal,#22d3ee);color:var(--color-on-signal,#04111a);font:inherit;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,.3);cursor:pointer}
.hc-fab .hc-dot{position:absolute;top:6px;right:8px;width:10px;height:10px;border-radius:50%;background:var(--color-emergency,#ef4444);border:2px solid var(--color-bg,#000)}
.hc-panel{position:fixed;right:16px;z-index:61;width:min(400px,calc(100vw - 32px));height:min(600px,calc(100vh - 120px));display:flex;flex-direction:column;background:var(--color-surface-raised,#1b1b1b);color:var(--color-text-primary,#fff);border:1px solid var(--color-divider,#333);border-radius:20px;box-shadow:0 24px 64px rgba(0,0,0,.45);overflow:hidden}
.hc-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--color-divider,#333)}
.hc-head strong{display:block}
.hc-head small{color:var(--color-text-secondary,#aaa);font-size:12px}
.hc-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.hc-actions button{border:1px solid var(--color-divider,#333);background:transparent;color:inherit;border-radius:14px;padding:6px 10px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.hc-sos{font-size:12px;padding:6px 14px;background:color-mix(in srgb,var(--color-emergency,#ef4444) 14%,transparent);color:var(--color-emergency-text,#fca5a5)}
.hc-list{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.hc-msg{max-width:85%;padding:8px 12px;border-radius:14px;background:var(--color-surface,#111);border:1px solid var(--color-divider,#333)}
.hc-msg p{margin:0;white-space:pre-wrap;font-size:14px;line-height:1.45}
.hc-msg small{display:block;font-size:11px;color:var(--color-text-secondary,#aaa);margin-bottom:2px}
.hc-msg ul{margin:6px 0 0;padding-left:16px;font-size:12px}
.hc-msg a{color:var(--color-signal,#22d3ee)}
.hc-msg.user{align-self:flex-end;background:var(--color-signal,#22d3ee);color:var(--color-on-signal,#04111a);border-color:transparent}
.hc-msg.agent{border-color:var(--color-success,#34d399)}
.hc-typing{opacity:.7}
.hc-note,.hc-empty p{font-size:13px;color:var(--color-text-secondary,#aaa);margin:0}
.hc-sugs{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.hc-sugs button{border:1px solid var(--color-divider,#333);background:var(--color-surface,#111);color:inherit;border-radius:14px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer;text-align:left}
.hc-err{font-size:12px;padding:6px 14px;color:var(--color-emergency-text,#fca5a5)}
.hc-input{display:flex;gap:8px;padding:10px;border-top:1px solid var(--color-divider,#333)}
.hc-input textarea{flex:1;resize:none;min-height:40px;max-height:120px;border-radius:12px;border:1px solid var(--color-divider,#333);background:var(--color-surface-sunken,#0a0a0a);color:inherit;font:inherit;font-size:14px;padding:9px 12px}
.hc-input button{border:0;border-radius:12px;padding:0 16px;background:var(--color-signal,#22d3ee);color:var(--color-on-signal,#04111a);font:inherit;font-weight:700;cursor:pointer}
.hc-input button:disabled,.hc-actions button:disabled{opacity:.5;cursor:not-allowed}
@media (max-width:600px){.hc-panel{right:0;left:0;width:100%;border-radius:20px 20px 0 0;height:min(78vh,620px)}}
`;
