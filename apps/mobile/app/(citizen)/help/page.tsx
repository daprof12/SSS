'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { MessageSheet, TOPICS } from '@/components/MessageSheet';
import { api } from '@/lib/client';

interface Support {
  faq: { q: string; a: string }[];
  emergency: { number: string; note: string };
  tickets: { id: string; number: string; topic: string; body: string; state: 'open' | 'answered' | 'closed'; reply: string | null; at: string }[];
}
const STATE = { open: ['Waiting for us', 'warning'], answered: ['Answered', 'success'], closed: ['Closed', 'neutral'] } as const;

/** Help and support: answers first, then a message to the team with a reference. 112 always shown. */
export default function Help() {
  const [s, setS] = useState<Support | null>(null);
  const [writing, setWriting] = useState(false);
  const [toast, setToast] = useToast();
  const load = () => api<Support>('/me/support').then(setS).catch(() => {});
  useEffect(() => {
    void load();
  }, []);
  return (
    <main className="app">
      <Header title="Help and support" back="/profile" />
      <Link className="btn primary" href="/chat" style={{ width: '100%', margin: '0 0 12px' }}>
        Chat with us now
      </Link>
      <a className="banner critical" href={`tel:${s?.emergency.number ?? '112'}`} style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none' }}>
        <Icon name="phone" />
        <span style={{ flex: 1 }}>
          <strong>In danger and the app is not working?</strong>
          Call {s?.emergency.number ?? '112'} now.
        </span>
      </a>

      <p className="section-label">Common questions</p>
      <div className="list">
        {(s?.faq ?? []).map((f) => (
          <details key={f.q} className="help-item">
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
        {!s && <div className="skeleton" />}
      </div>

      <p className="section-label">Talk to us</p>
      <button className="btn block signal" type="button" onClick={() => setWriting(true)}>
        <Icon name="message" /> Send us a message
      </button>
      <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
        We usually reply within one working day, here and by notification.
      </p>

      {!!s?.tickets.length && (
        <>
          <p className="section-label">Your messages</p>
          <div className="list">
            {s.tickets.map((t) => (
              <details key={t.id} className="help-item">
                <summary style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ flex: 1 }}>
                    {t.number} · {TOPICS.find(([k]) => k === t.topic)?.[1]}
                  </span>
                  <span className={`chip ${STATE[t.state][1]}`}>{STATE[t.state][0]}</span>
                </summary>
                <p>{t.body}</p>
                {t.reply && (
                  <p style={{ color: 'var(--color-text-primary)' }}>
                    <strong>Reply: </strong>
                    {t.reply}
                  </p>
                )}
              </details>
            ))}
          </div>
        </>
      )}

      {writing && (
        <MessageSheet
          onClose={() => setWriting(false)}
          onSent={(m) => {
            setWriting(false);
            setToast(m);
            void load();
          }}
        />
      )}
      <Toast msg={toast} />
    </main>
  );
}
