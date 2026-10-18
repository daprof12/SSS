'use client';
// Pieces shared by the Learn feed, General, search, topic and lesson screens.
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { API_URL, ensureFreshToken } from '@erp/web-ui/api';
import { api, ApiError, getSession, haptic } from '@/lib/client';

export interface LearnItem {
  id: string;
  title: string;
  caption: string;
  format: 'video' | 'article' | 'quiz';
  topic: { code: string; label: string; icon: string; tone: 'emergency' | 'warning' | 'success' | 'signal' };
  language: string;
  durationS: number | null;
  source: string;
  media: { id: string; kind: string; url: string } | null;
  likes: number;
  views: number;
  publishedAt: string | null;
  me: { liked: boolean; saved: boolean; seen: boolean; completed: boolean; quizScore: number | null };
  reason?: string | null;
  body?: string | null;
  quiz?: { q: string; options: string[] }[] | null;
}

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
export const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));

/** "Fire safety, 0:30" · "2 min read" · "3 questions" */
export function lengthText(it: Pick<LearnItem, 'format' | 'durationS' | 'quiz'>, quizCount?: number) {
  if (it.format === 'video') return it.durationS ? clock(it.durationS) : 'Video';
  if (it.format === 'article') return `${Math.max(1, Math.round((it.durationS ?? 60) / 60))} min read`;
  const n = quizCount ?? it.quiz?.length ?? Math.max(1, Math.round((it.durationS ?? 20) / 20));
  return `${n} ${n === 1 ? 'question' : 'questions'}`;
}
export const FORMAT_LABEL = { video: 'Video', article: 'Article', quiz: 'Quiz' } as const;
export const FORMAT_ICON = { video: 'play', article: 'article', quiz: 'quiz' } as const;

/** Like and save with an instant change on screen; rolls back if the server says no. */
export function useReactions(it: LearnItem) {
  const [liked, setLiked] = useState(it.me.liked);
  const [saved, setSaved] = useState(it.me.saved);
  const [likes, setLikes] = useState(it.likes);
  const [pop, setPop] = useState(0);
  const send = (b: Record<string, unknown>) => api<{ likes: number }>(`/learn/posts/${it.id}/react`, { method: 'POST', body: JSON.stringify(b) });
  return {
    liked,
    saved,
    likes,
    pop,
    toggleLike: async () => {
      const next = !liked;
      setLiked(next);
      setLikes((n) => n + (next ? 1 : -1));
      if (next) setPop((n) => n + 1);
      haptic(8);
      try {
        setLikes((await send({ liked: next })).likes);
      } catch {
        setLiked(!next);
        setLikes((n) => n + (next ? -1 : 1));
      }
    },
    toggleSave: async () => {
      const next = !saved;
      setSaved(next);
      haptic(8);
      try {
        await send({ saved: next });
      } catch {
        setSaved(!next);
      }
      return next;
    },
  };
}

export const markSeen = (id: string, extra: Record<string, unknown> = {}) =>
  api(`/learn/posts/${id}/react`, { method: 'POST', body: JSON.stringify({ seen: true, ...extra }) }).catch(() => {});

export async function shareLesson(it: Pick<LearnItem, 'id' | 'title' | 'caption'>): Promise<string> {
  const url = `${location.origin}/learn/p/${it.id}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: it.title, text: it.caption, url });
      return '';
    }
    await navigator.clipboard.writeText(url);
    return 'Link copied.';
  } catch {
    return '';
  }
}

/** Search results, topic lists and saved: one row per lesson. */
export function LearnRow({ it }: { it: LearnItem }) {
  return (
    <Link href={`/learn/p/${it.id}`} className="learn-row">
      <span className={`learn-thumb tone-${it.topic.tone}`} aria-hidden>
        <Icon name={FORMAT_ICON[it.format]} size={22} filled={it.format === 'video'} />
      </span>
      <span className="grow">
        <strong>{it.title}</strong>
        <span className="sub">
          {it.source}, {lengthText(it)}
          {it.me.completed ? ' · Done' : ''}
        </span>
      </span>
      <span className="learn-format">{FORMAT_LABEL[it.format]}</span>
    </Link>
  );
}

/** Media from the API needs the session token, so it is fetched into a local URL. */
export function useMediaUrl(path: string | null | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    let made: string | null = null;
    (async () => {
      await ensureFreshToken();
      const r = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${getSession()?.token ?? ''}` } }).catch(() => null);
      if (!r?.ok || !alive) return;
      made = URL.createObjectURL(await r.blob());
      setUrl(made);
    })();
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  return url;
}

/**
 * A lesson filmed as steps (no footage yet, or a slideshow lesson): one line per step, each
 * held for its share of the duration, with progress bars like a story. Tap pauses.
 */
export function StepPlayer({ it, active, onProgress, onDone }: { it: LearnItem; active: boolean; onProgress?: (s: number) => void; onDone?: () => void }) {
  const steps = (it.body ?? it.caption).split('\n').filter((x) => x.trim());
  const total = Math.max(steps.length * 4, it.durationS ?? steps.length * 6);
  const per = total / steps.length;
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const done = useRef(false);
  useEffect(() => {
    if (!active) setPlaying(false);
  }, [active]);
  useEffect(() => {
    if (!playing) return;
    const started = performance.now() - t * 1000;
    let raf = 0;
    const tick = (now: number) => {
      const s = Math.min(total, (now - started) / 1000);
      setT(s);
      onProgress?.(s);
      if (s >= total) {
        setPlaying(false);
        if (!done.current) {
          done.current = true;
          onDone?.();
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);
  const i = Math.min(steps.length - 1, Math.floor(t / per));
  const started = t > 0;
  return (
    <div className="steps-player" onClick={() => started && setPlaying((p) => !p)}>
      <div className="steps-bars" aria-hidden style={{ visibility: t > 0 ? 'visible' : 'hidden' }}>
        {steps.map((_, k) => (
          <span key={k}>
            <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, (t - k * per) / per))})` }} />
          </span>
        ))}
      </div>
      {started ? (
        <p key={i} className="step-line" aria-live="polite">
          <span className="step-no">
            {i + 1}/{steps.length}
          </span>
          {steps[i]}
        </p>
      ) : (
        <button
          type="button"
          className="big-play"
          aria-label={`Play: ${it.title}`}
          onClick={(e) => {
            e.stopPropagation();
            setPlaying(true);
          }}
        >
          <Icon name="play" size={44} filled />
        </button>
      )}
      {!started && (
        <span className="play-label">
          {it.topic.label}, {clock(total)}
        </span>
      )}
      {started && !playing && t < total && <span className="paused-tag">Paused. Tap to continue.</span>}
      {t >= total && (
        <button
          type="button"
          className="btn small replay"
          onClick={(e) => {
            e.stopPropagation();
            setT(0);
            setPlaying(true);
          }}
        >
          Watch again
        </button>
      )}
    </div>
  );
}

/** Real footage: plays with sound on tap, reports how far the person watched. */
export function VideoPlayer({ it, active, onProgress, onDone }: { it: LearnItem; active: boolean; onProgress?: (s: number) => void; onDone?: () => void }) {
  const src = useMediaUrl(it.media?.url);
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!active) ref.current?.pause();
  }, [active]);
  return (
    <div className="steps-player" onClick={() => ref.current && (ref.current.paused ? void ref.current.play() : ref.current.pause())}>
      {src && <video ref={ref} src={src} playsInline preload="metadata" className="learn-video" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(e) => onProgress?.(e.currentTarget.currentTime)} onEnded={onDone} />}
      {!playing && (
        <>
          <span className="big-play" aria-hidden>
            <Icon name="play" size={44} filled />
          </span>
          <span className="play-label">
            {it.topic.label}
            {it.durationS ? `, ${clock(it.durationS)}` : ''}
          </span>
        </>
      )}
    </div>
  );
}

/** Answers are marked on the server; the phone never holds them. */
export function Quiz({ it, onDone }: { it: LearnItem; onDone?: (score: number) => void }) {
  const [quiz, setQuiz] = useState(it.quiz ?? null);
  const [picked, setPicked] = useState<number[]>([]);
  const [result, setResult] = useState<{ score: number; total: number; results: { correct: boolean; answer: number; why: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!quiz) void api<LearnItem>(`/learn/posts/${it.id}`).then((d) => setQuiz(d.quiz ?? [])).catch(() => setQuiz([]));
  }, [it.id, quiz]);
  if (!quiz) return <div className="skeleton" style={{ height: 160 }} />;
  const n = picked.length;
  const q = quiz[Math.min(n, quiz.length - 1)];

  const pick = async (k: number) => {
    const next = [...picked, k];
    setPicked(next);
    haptic(8);
    if (next.length < quiz.length) return;
    setBusy(true);
    try {
      const r = await api<NonNullable<typeof result>>(`/learn/posts/${it.id}/quiz`, { method: 'POST', body: JSON.stringify({ answers: next }) });
      setResult(r);
      haptic(r.score === r.total ? [10, 40, 10] : 15);
      onDone?.(r.score);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not check your answers.');
    } finally {
      setBusy(false);
    }
  };

  if (result)
    return (
      <div className="quiz" aria-live="polite">
        <p className="quiz-score">
          {result.score} of {result.total} right{result.score === result.total ? '. Well done.' : '.'}
        </p>
        <ol className="quiz-review">
          {quiz.map((x, i) => (
            <li key={i} data-correct={result.results[i]!.correct}>
              <strong>{x.q}</strong>
              <span>
                {result.results[i]!.correct ? 'Right: ' : `Answer: ${x.options[result.results[i]!.answer]}. `}
                {result.results[i]!.why}
              </span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            setPicked([]);
            setResult(null);
          }}
        >
          Try again
        </button>
      </div>
    );
  return (
    <div className="quiz">
      <p className="quiz-count">
        Question {Math.min(n + 1, quiz.length)} of {quiz.length}
      </p>
      <p className="quiz-q">{q?.q}</p>
      <div className="quiz-options" role="group" aria-label="Answers">
        {q?.options.map((o, k) => (
          <button key={k} type="button" className="quiz-opt" disabled={busy} onClick={() => void pick(k)}>
            {o}
          </button>
        ))}
      </div>
      {err && <span className="field-error">{err}</span>}
    </div>
  );
}

/** "…" on a lesson: Not interested, share, and copy link. */
export function MoreSheet({ it, onClose, onHidden, onToast }: { it: LearnItem; onClose: () => void; onHidden?: () => void; onToast: (m: string) => void }) {
  return (
    <Sheet
      open
      title={it.title}
      onClose={onClose}
      footer={
        <button className="btn" type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="list">
        <button
          type="button"
          className="row"
          onClick={async () => {
            await api(`/learn/posts/${it.id}/react`, { method: 'POST', body: JSON.stringify({ notInterested: true, seen: true }) }).catch(() => {});
            onClose();
            onHidden?.();
            onToast(`You will see less ${it.topic.label}. Change this in Your interests.`);
          }}
        >
          <Icon name="eye" />
          <span className="grow">
            <strong>Not interested</strong>
            <span className="sub">See less {it.topic.label}</span>
          </span>
        </button>
        <button
          type="button"
          className="row"
          onClick={async () => {
            const m = await shareLesson(it);
            onClose();
            if (m) onToast(m);
          }}
        >
          <Icon name="share" />
          <span className="grow">
            <strong>Share</strong>
            <span className="sub">Send it to family or a friend</span>
          </span>
        </button>
        <Link href={`/learn/topic/${it.topic.code}`} className="row" onClick={onClose}>
          <Icon name={it.topic.icon} />
          <span className="grow">
            <strong>More {it.topic.label}</strong>
            <span className="sub">Everything in this topic</span>
          </span>
        </Link>
      </div>
    </Sheet>
  );
}
