'use client';
// One lesson on its own page (search results, topics, shared links).
import { use, useEffect, useRef, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { compact, lengthText, markSeen, MoreSheet, Quiz, shareLesson, StepPlayer, useReactions, VideoPlayer, type LearnItem } from '@/components/learn/shared';
import { api, ApiError } from '@/lib/client';

export default function Lesson({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [it, setIt] = useState<LearnItem | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<LearnItem>(`/learn/posts/${id}`)
      .then((x) => {
        setIt(x);
        void markSeen(x.id);
      })
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load this lesson.'));
  }, [id]);
  if (err)
    return (
      <main className="app">
        <Header title="Learn" back="/learn?tab=general" />
        <div className="card empty">
          <strong>{err}</strong>
        </div>
      </main>
    );
  if (!it)
    return (
      <main className="app">
        <div className="skeleton" style={{ height: 300 }} />
      </main>
    );
  return <LessonView it={it} />;
}

function LessonView({ it }: { it: LearnItem }) {
  const r = useReactions(it);
  const [more, setMore] = useState(false);
  const [toast, setToast] = useToast();
  const doneOnce = useRef(false);
  const done = () => {
    if (doneOnce.current) return;
    doneOnce.current = true;
    void markSeen(it.id, { completed: true });
  };
  // Reading to the end of an article counts as done.
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (it.format !== 'article' || !end.current) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && done(), { threshold: 1 });
    io.observe(end.current);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [it]);

  return (
    <main className="app lesson">
      <Header title={it.topic.label} back="/learn?tab=general">
        <button type="button" className="link-btn" aria-label="More options" onClick={() => setMore(true)}>
          <Icon name="more" />
        </button>
      </Header>
      {it.format === 'video' && <div className={`lesson-stage tone-${it.topic.tone}`}>{it.media ? <VideoPlayer it={it} active onDone={done} /> : <StepPlayer it={it} active onDone={done} />}</div>}
      <p className="feed-source" style={{ marginTop: 16 }}>
        {it.source} · {lengthText(it)}
      </p>
      <h1 className="lesson-title">{it.title}</h1>
      <p className="lesson-caption">{it.caption}</p>
      {it.format === 'article' && (
        <article className="lesson-body">
          {(it.body ?? '').split(/\n{2,}/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
          <div ref={end} />
        </article>
      )}
      {it.format === 'quiz' && (
        <div className="card">
          <Quiz it={it} onDone={done} />
        </div>
      )}
      <div className="lesson-actions">
        <button type="button" className="btn" aria-pressed={r.liked} onClick={() => void r.toggleLike()}>
          <span key={r.pop} className={r.pop ? 'pop' : ''}>
            <Icon name="heart" filled={r.liked} size={20} />
          </span>
          {compact(r.likes)}
        </button>
        <button type="button" className="btn" aria-pressed={r.saved} onClick={async () => setToast((await r.toggleSave()) ? 'Saved.' : 'Removed from saved.')}>
          <Icon name="bookmark" filled={r.saved} size={20} /> {r.saved ? 'Saved' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={async () => setToast(await shareLesson(it))}>
          <Icon name="share" size={20} /> Share
        </button>
      </div>
      {more && <MoreSheet it={it} onClose={() => setMore(false)} onToast={setToast} />}
      <Toast msg={toast} />
    </main>
  );
}
