'use client';
// Learn tab (boards: Learn feed, For you, General, filter, end of feed).
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/client';
import { compact, LearnRow, lengthText, markSeen, MoreSheet, Quiz, shareLesson, StepPlayer, useReactions, VideoPlayer, type LearnItem } from './shared';

interface Topic {
  code: string;
  label: string;
  icon: string;
  tone: string;
  items: number;
}
interface Catalogue {
  topics: Topic[];
  languages: readonly { code: string; label: string }[];
  sources: { id: string; name: string }[];
}
const SKIP = 'erp-learn-skip-interests';

export function Learn() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get('tab') === 'general' ? 'general' : 'for_you';
  const go = (t: 'general' | 'for_you') => router.replace(t === 'general' ? '/learn?tab=general' : '/learn', { scroll: false });
  return (
    <>
      <header className={`learn-top ${tab === 'for_you' ? 'over' : ''}`}>
        <span className="spacer" />
        <nav className="learn-tabs" role="tablist" aria-label="Learn">
          <button type="button" role="tab" aria-selected={tab === 'general'} onClick={() => go('general')}>
            General
          </button>
          <button type="button" role="tab" aria-selected={tab === 'for_you'} onClick={() => go('for_you')}>
            For you
          </button>
        </nav>
        <span className="spacer" style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Link href="/learn/search" className="learn-icon-btn" aria-label="Search Learn">
            <Icon name="search" />
          </Link>
        </span>
      </header>
      {tab === 'for_you' ? <ForYou onBrowse={() => go('general')} /> : <General />}
    </>
  );
}

// ---------------------------------------------------------------- For you

function ForYou({ onBrowse }: { onBrowse: () => void }) {
  const router = useRouter();
  const [items, setItems] = useState<(LearnItem & { reason: string | null })[] | null>(null);
  const [next, setNext] = useState<number | null>(0);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useToast();
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (offset: number) => {
      setLoading(true);
      try {
        const r = await api<{ items: (LearnItem & { reason: string | null })[]; next: number | null; needsInterests: boolean }>(`/learn/feed?offset=${offset}`);
        if (offset === 0 && r.needsInterests) {
          let skipped = false;
          try {
            skipped = localStorage.getItem(SKIP) === '1';
          } catch {}
          if (!skipped) return router.replace('/learn/interests?next=/learn');
        }
        // A first page replaces the list; later pages append, skipping anything already shown.
        setItems((xs) => {
          if (offset === 0) return r.items;
          const shown = new Set((xs ?? []).map((x) => x.id));
          return [...(xs ?? []), ...r.items.filter((x) => !shown.has(x.id))];
        });
        setNext(r.next);
      } catch {
        setItems((xs) => xs ?? []);
        setNext(null);
      } finally {
        setLoading(false);
      }
    },
    [router],
  );
  useEffect(() => {
    void load(0);
  }, [load]);

  // The card most in view is "active": it plays, gets marked seen, and pulls in more.
  useEffect(() => {
    const root = box.current;
    if (!root || !items) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting && e.intersectionRatio > 0.6) setActive(Number((e.target as HTMLElement).dataset.i));
      },
      { root, threshold: [0.6] },
    );
    root.querySelectorAll('[data-i]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [items]);
  useEffect(() => {
    if (items && next != null && !loading && active >= items.length - 3) void load(next);
  }, [active, items, next, loading, load]);

  if (!items) return <div className="learn-feed">{<div className="feed-card skeleton-card" />}</div>;
  return (
    <div className="learn-feed" ref={box}>
      {items.map((it, i) => (
        <FeedCard
          key={it.id}
          it={it}
          i={i}
          active={i === active}
          first={i === 0}
          onToast={setToast}
          onHidden={() => {
            setItems((xs) => xs?.filter((x) => x.topic.code !== it.topic.code || x.id === it.id) ?? null);
            box.current?.scrollBy({ top: box.current.clientHeight, behavior: 'smooth' });
          }}
        />
      ))}
      {next == null && (
        <section className="feed-card feed-end" data-i={items.length}>
          <span className="done-badge" aria-hidden>
            <Icon name="check" size={40} />
          </span>
          <h2>You are all caught up</h2>
          <p className="muted">New videos land here every day. Try a topic you have not watched yet.</p>
          <button type="button" className="btn signal" onClick={onBrowse}>
            Browse topics
          </button>
          <Link href="/learn/interests?next=/learn" className="link-btn">
            Edit my interests
          </Link>
        </section>
      )}
      <Toast msg={toast} />
    </div>
  );
}

function FeedCard({ it, i, active, first, onToast, onHidden }: { it: LearnItem & { reason: string | null }; i: number; active: boolean; first: boolean; onToast: (m: string) => void; onHidden: () => void }) {
  const r = useReactions(it);
  const [more, setMore] = useState(false);
  const seen = useRef(false);
  const reported = useRef(0);

  // Seen after 1.5 s on screen; progress reported every 10 s and at the end.
  useEffect(() => {
    if (!active || seen.current) return;
    const t = setTimeout(() => {
      seen.current = true;
      void markSeen(it.id);
    }, 1500);
    return () => clearTimeout(t);
  }, [active, it.id]);
  const progress = (s: number) => {
    if (s - reported.current >= 10) {
      reported.current = s;
      void markSeen(it.id, { watchedS: Math.round(s) });
    }
  };
  const done = () => void markSeen(it.id, { completed: true, watchedS: it.durationS ?? 0 });

  return (
    <section className={`feed-card tone-${it.topic.tone}`} data-i={i} aria-roledescription="lesson" aria-label={it.title}>
      <div className="feed-stage">
        {it.format === 'video' ? (
          it.media ? (
            <VideoPlayer it={it} active={active} onProgress={progress} onDone={done} />
          ) : (
            <StepPlayer it={it} active={active} onProgress={progress} onDone={done} />
          )
        ) : it.format === 'quiz' ? (
          <div className="feed-quiz">
            <span className="feed-kind">
              <Icon name="quiz" size={18} /> Quiz, {lengthText(it)}
            </span>
            <Quiz it={it} onDone={() => done()} />
          </div>
        ) : (
          <div className="feed-article">
            <span className="feed-kind">
              <Icon name="article" size={18} /> Article, {lengthText(it)}
            </span>
            <p className="feed-excerpt">{(it.body ?? it.caption).split('\n').filter(Boolean).slice(0, 2).join(' ')}</p>
            <Link href={`/learn/p/${it.id}`} className="btn signal small">
              Read the article
            </Link>
          </div>
        )}
      </div>

      <div className="feed-meta">
        <span className="feed-source">{it.source}</span>
        <h2 className="feed-title">{it.title}</h2>
        {it.format === 'video' && <p className="feed-caption">{it.caption}</p>}
        {it.reason && <span className="feed-reason">{it.reason}</span>}
        {first && <span className="swipe-hint">Swipe up for the next one</span>}
      </div>

      <div className="feed-rail">
        <button type="button" className="rail-btn" aria-pressed={r.liked} aria-label={r.liked ? 'Unlike' : 'Like'} onClick={() => void r.toggleLike()}>
          <span key={r.pop} className={r.pop ? 'pop' : ''}>
            <Icon name="heart" filled={r.liked} />
          </span>
          <small>{compact(r.likes)}</small>
        </button>
        <button
          type="button"
          className="rail-btn"
          aria-pressed={r.saved}
          aria-label={r.saved ? 'Remove from saved' : 'Save'}
          onClick={async () => onToast((await r.toggleSave()) ? 'Saved. Find it in General, Saved.' : 'Removed from saved.')}
        >
          <Icon name="bookmark" filled={r.saved} />
          <small>{r.saved ? 'Saved' : 'Save'}</small>
        </button>
        <button type="button" className="rail-btn" aria-label="Share" onClick={async () => onToast(await shareLesson(it))}>
          <Icon name="share" />
          <small>Share</small>
        </button>
        <button type="button" className="rail-btn" aria-label="More options" onClick={() => setMore(true)}>
          <Icon name="more" />
        </button>
      </div>
      {more && <MoreSheet it={it} onClose={() => setMore(false)} onHidden={onHidden} onToast={onToast} />}
    </section>
  );
}

// ---------------------------------------------------------------- General

interface Filters {
  format: 'all' | 'video' | 'article' | 'quiz';
  topics: string[];
  languages: string[];
  length: '' | 'short' | 'medium' | 'long';
  from: string;
  sort: 'best' | 'newest' | 'most_viewed';
}
const EMPTY: Filters = { format: 'all', topics: [], languages: [], length: '', from: '', sort: 'best' };
export const browseQuery = (f: Partial<Filters> & { q?: string; saved?: boolean }) => {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.format && f.format !== 'all') p.set('format', f.format);
  if (f.topics?.length) p.set('topics', f.topics.join(','));
  if (f.languages?.length) p.set('languages', f.languages.join(','));
  if (f.length) p.set('length', f.length);
  if (f.from) p.set('from', f.from);
  if (f.sort && f.sort !== 'best') p.set('sort', f.sort);
  if (f.saved) p.set('saved', '1');
  return p.toString();
};

function General() {
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [mine, setMine] = useState<string[]>([]);
  const [chip, setChip] = useState<'all' | 'video' | 'article' | 'quiz' | 'saved'>('all');
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [filtering, setFiltering] = useState(false);
  const [list, setList] = useState<LearnItem[] | null>(null);

  useEffect(() => {
    api<Catalogue>('/learn/topics').then(setCat).catch(() => {});
    api<{ topics: string[] }>('/me/learn/interests').then((r) => setMine(r.topics)).catch(() => {});
  }, []);

  const filtered = JSON.stringify(filters) !== JSON.stringify(EMPTY);
  const showList = chip !== 'all' || filtered;
  useEffect(() => {
    if (!showList) return setList(null);
    setList(null);
    const q = browseQuery({ ...filters, format: chip === 'saved' || chip === 'all' ? filters.format : chip, saved: chip === 'saved' });
    api<{ items: LearnItem[] }>(`/learn/browse?${q}`)
      .then((r) => setList(r.items))
      .catch(() => setList([]));
  }, [chip, filters, showList]);

  const label = (code: string) => cat?.topics.find((t) => t.code === code)?.label ?? code;
  return (
    <main className="app learn-general">
      <div className="learn-search-row">
        <Link href="/learn/search" className="learn-search-box">
          <Icon name="search" size={20} />
          <span>Search topics, tips, agencies</span>
        </Link>
        <button type="button" className="learn-icon-btn filled" aria-label="Filter" aria-pressed={filtered} onClick={() => setFiltering(true)}>
          <Icon name="filter" />
          {filtered && <span className="dot" aria-hidden />}
        </button>
      </div>
      <div className="chips learn-chips" role="tablist" aria-label="Show">
        {(
          [
            ['all', 'All'],
            ['video', 'Videos'],
            ['article', 'Articles'],
            ['quiz', 'Quizzes'],
            ['saved', 'Saved'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={chip === k} aria-pressed={chip === k} onClick={() => setChip(k)}>
            {l}
          </button>
        ))}
      </div>
      {filtered && (
        <p className="muted" style={{ margin: '0 0 8px' }}>
          Filters on.{' '}
          <button type="button" className="link-btn" onClick={() => setFilters(EMPTY)}>
            Clear
          </button>
        </p>
      )}

      {showList ? (
        !list ? (
          [0, 1, 2].map((i) => <div key={i} className="skeleton" />)
        ) : !list.length ? (
          <div className="card empty">
            <strong>{chip === 'saved' ? 'Nothing saved yet.' : 'Nothing matches.'}</strong>
            {chip === 'saved' ? 'Tap Save on a lesson to keep it here.' : 'Try fewer filters.'}
          </div>
        ) : (
          <div className="learn-list">
            {list.map((it) => (
              <LearnRow key={it.id} it={it} />
            ))}
          </div>
        )
      ) : (
        <>
          <div className="section-head">
            <h2>Your interests</h2>
            <Link href="/learn/interests?next=/learn?tab=general" className="link-btn">
              Edit
            </Link>
          </div>
          {mine.length ? (
            <div className="chips learn-chips">
              {mine.map((c) => (
                <Link key={c} href={`/learn/topic/${c}`} className="chip-link interest">
                  {label(c)}
                </Link>
              ))}
            </div>
          ) : (
            <p className="muted">
              <Link href="/learn/interests?next=/learn?tab=general">Pick what you want to learn</Link> and your feed follows it.
            </p>
          )}
          <h2 className="section-title">Browse topics</h2>
          {!cat ? (
            [0, 1, 2, 3].map((i) => <div key={i} className="skeleton" />)
          ) : (
            <div className="learn-topics">
              {cat.topics.map((t) => (
                <Link key={t.code} href={`/learn/topic/${t.code}`} className="topic-tile">
                  <span className={`topic-icon tone-${t.tone}`} aria-hidden>
                    <Icon name={t.icon} />
                  </span>
                  <span className="grow">
                    <strong>{t.label}</strong>
                    <span className="sub">{t.items === 1 ? '1 item' : `${t.items} items`}</span>
                  </span>
                </Link>
              ))}
            </div>
          )}
        </>
      )}
      {filtering && cat && <FilterSheet cat={cat} value={filters} onClose={() => setFiltering(false)} onApply={(f) => (setFilters(f), setFiltering(false), setChip('all'))} />}
    </main>
  );
}

/** Board "Learn filter": format, topic, language, length, source and sort, with a live count. */
export function FilterSheet({ cat, value, onClose, onApply }: { cat: Catalogue; value: Filters; onClose: () => void; onApply: (f: Filters) => void }) {
  const [f, setF] = useState<Filters>(value);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api<{ total: number }>(`/learn/browse?${browseQuery(f)}`)
        .then((r) => setCount(r.total))
        .catch(() => setCount(null));
    }, 200);
    return () => clearTimeout(t);
  }, [f]);
  const toggle = (key: 'topics' | 'languages', v: string) => setF((x) => ({ ...x, [key]: x[key].includes(v) ? x[key].filter((y) => y !== v) : [...x[key], v] }));
  const one = <K extends 'format' | 'length' | 'from' | 'sort'>(key: K, opts: [Filters[K], string][]) => (
    <div className="chips learn-chips">
      {opts.map(([v, l]) => (
        <button key={String(v)} type="button" aria-pressed={f[key] === v} onClick={() => setF((x) => ({ ...x, [key]: v }))}>
          {l}
        </button>
      ))}
    </div>
  );
  return (
    <Sheet
      open
      title="Filter"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={() => setF(EMPTY)}>
            Reset
          </button>
          <button className="btn primary" type="button" onClick={() => onApply(f)} disabled={count === 0}>
            {count == null ? 'Show results' : count === 0 ? 'No results' : `Show ${count} ${count === 1 ? 'result' : 'results'}`}
          </button>
        </>
      }
    >
      <p className="section-label">Format</p>
      {one('format', [
        ['all', 'All'],
        ['video', 'Videos'],
        ['article', 'Articles'],
        ['quiz', 'Quizzes'],
      ])}
      <p className="section-label">Topic</p>
      <div className="chips learn-chips">
        {cat.topics.map((t) => (
          <button key={t.code} type="button" aria-pressed={f.topics.includes(t.code)} onClick={() => toggle('topics', t.code)}>
            {t.label}
          </button>
        ))}
      </div>
      <p className="section-label">Language</p>
      <div className="chips learn-chips">
        {cat.languages.map((l) => (
          <button key={l.code} type="button" aria-pressed={f.languages.includes(l.code)} onClick={() => toggle('languages', l.code)}>
            {l.label}
          </button>
        ))}
      </div>
      <p className="section-label">Length</p>
      {one('length', [
        ['', 'Any'],
        ['short', 'Under 1 min'],
        ['medium', '1 to 3 min'],
        ['long', 'Over 3 min'],
      ])}
      <p className="section-label">From</p>
      {one('from', [['', 'All agencies'], ...cat.sources.map((s) => [s.id, s.name] as [string, string])])}
      <p className="section-label">Sort by</p>
      {one('sort', [
        ['best', 'Best for me'],
        ['newest', 'Newest'],
        ['most_viewed', 'Most viewed'],
      ])}
    </Sheet>
  );
}

export { SKIP as LEARN_SKIP_KEY };
