'use client';
// Board "Learn search": suggestions as you type, then Top / Videos / Articles / Quizzes / Agencies.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { LearnRow, type LearnItem } from '@/components/learn/shared';
import { api } from '@/lib/client';

type Tab = 'top' | 'video' | 'article' | 'quiz' | 'agencies';

export default function Search() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('top');
  const [suggest, setSuggest] = useState<string[]>([]);
  const [res, setRes] = useState<{ total: number; items: LearnItem[]; agencies: { id: string; name: string }[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setSuggest([]);
      setRes(null);
      return;
    }
    const t = setTimeout(() => {
      api<string[]>(`/learn/suggest?q=${encodeURIComponent(term)}`).then(setSuggest).catch(() => setSuggest([]));
      const fmt = tab === 'top' || tab === 'agencies' ? '' : `&format=${tab}`;
      api<typeof res>(`/learn/browse?q=${encodeURIComponent(term)}${fmt}`).then(setRes).catch(() => setRes(null));
    }, 200);
    return () => clearTimeout(t);
  }, [q, tab]);

  return (
    <main className="app learn-search">
      <div className="learn-search-row">
        <button type="button" className="learn-icon-btn filled" aria-label="Back" onClick={() => router.back()}>
          <Icon name="back" />
        </button>
        <label className="learn-search-box active">
          <Icon name="search" size={20} />
          <input ref={input} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search topics, tips, agencies" aria-label="Search Learn" enterKeyHint="search" />
        </label>
      </div>
      <div className="chips learn-chips" role="tablist" aria-label="Results">
        {(
          [
            ['top', 'Top'],
            ['video', 'Videos'],
            ['article', 'Articles'],
            ['quiz', 'Quizzes'],
            ['agencies', 'Agencies'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {q.trim().length < 2 ? (
        <p className="muted">Try “fire”, “first aid” or “scam”.</p>
      ) : (
        <>
          {suggest.length > 0 && tab === 'top' && (
            <>
              <p className="section-label">Suggestions</p>
              <ul className="suggest-list">
                {suggest.map((s) => (
                  <li key={s}>
                    <button type="button" onClick={() => setQ(s)}>
                      <Icon name="search" size={18} /> {s}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {tab === 'agencies' ? (
            <>
              <p className="section-label">Agencies</p>
              {!res?.agencies.length ? (
                <p className="muted">No agency matches “{q.trim()}”.</p>
              ) : (
                <div className="learn-list">
                  {res.agencies.map((a) => (
                    <Link key={a.id} href={`/learn?tab=general`} className="learn-row">
                      <span className="learn-thumb tone-signal" aria-hidden>
                        <Icon name="shield" size={22} />
                      </span>
                      <span className="grow">
                        <strong>{a.name}</strong>
                        <span className="sub">Lessons from this agency</span>
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <p className="section-label">{tab === 'top' ? 'Top results' : 'Results'}</p>
              {!res ? (
                <div className="skeleton" />
              ) : !res.items.length ? (
                <div className="card empty">
                  <strong>Nothing found.</strong>Try a shorter word, or browse topics.
                </div>
              ) : (
                <div className="learn-list" aria-live="polite">
                  {res.items.map((it) => (
                    <LearnRow key={it.id} it={it} />
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}
    </main>
  );
}
