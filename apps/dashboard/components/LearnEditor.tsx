'use client';
// Learn feed editor (board "Admin learn feed"): Live, In review, Drafts, Removed; a new post is
// reviewed by someone else before it goes live. Agencies use the same editor for their own posts, in
// the topics they handle; only the platform team approves. Videos use the checked media pipeline.
import { learnLanguages, learnTopics } from '@erp/domain';
import { API_URL, api, ApiError, ensureFreshToken, getSession } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { dateTime, useToast } from './Agency';

/** Where the editor talks to: the platform team (/admin/learn) or one agency (/agencies/:id/learn). */
const Scope = createContext<{ base: string; agency: string | null }>({ base: '/admin/learn', agency: null });

type State = 'live' | 'in_review' | 'draft' | 'removed';
type Format = 'video' | 'article' | 'quiz';
interface Question {
  q: string;
  options: string[];
  answer: number;
  why: string;
}
interface Post {
  id: string;
  title: string;
  caption: string;
  format: Format;
  topic: { code: string; label: string; tone: string };
  language: string;
  durationS: number | null;
  source: string;
  sourceAgencyId: string | null;
  media: { id: string; kind: string; url: string } | null;
  likes: number;
  views: number;
  publishedAt: string | null;
  state: State;
  body: string | null;
  quiz: Question[] | null;
  audienceState: string | null;
  author: string;
  submittedBy: string | null;
  submittedByMe: boolean;
  reviewNote: string | null;
  removedReason: string | null;
  updatedAt: string;
}
const TABS: [State, string][] = [
  ['live', 'Live'],
  ['in_review', 'In review'],
  ['draft', 'Drafts'],
  ['removed', 'Removed'],
];
const STATE_CHIP: Record<State, [string, string]> = { live: ['Live', 'success'], in_review: ['In review', 'warning'], draft: ['Draft', 'neutral'], removed: ['Removed', 'critical'] };
const FORMAT: Record<Format, string> = { video: 'Video', article: 'Article', quiz: 'Quiz' };
interface Sources {
  agencies: { id: string; name: string }[];
  states: { code: string; name: string }[];
  /** An agency's allowed topics; null for the platform team (all topics). */
  topics: string[] | null;
}

export function LearnEditor({ base, agency }: { base: string; agency: string | null }) {
  return (
    <Scope.Provider value={{ base, agency }}>
      <Editor />
    </Scope.Provider>
  );
}

function Editor() {
  const { base, agency } = useContext(Scope);
  const [tab, setTab] = useState<State>('live');
  const [data, setData] = useState<{ counts: Record<State, number>; items: Post[] } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [panel, setPanel] = useState<{ mode: 'new' } | { mode: 'view'; id: string } | { mode: 'edit'; id: string }>({ mode: 'new' });
  const [toast, setToast] = useToast();
  const [sources, setSources] = useState<Sources | null>(null);

  const load = useCallback(
    () =>
      api<{ counts: Record<State, number>; items: Post[] }>(`${base}/posts?state=${tab}`)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch(setError),
    [tab, base],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    api<Sources>(`${base}/sources`).then(setSources).catch(() => {});
  }, [base]);

  if (error?.status === 403)
    return (
      <div className="card empty">
        <strong>This page is for platform staff.</strong>
      </div>
    );
  const current = panel.mode !== 'new' ? data?.items.find((x) => x.id === panel.id) : null;
  const done = (m: string, state?: State) => {
    setToast(m);
    if (state && state !== tab) setTab(state);
    else void load();
    setPanel({ mode: 'new' });
  };

  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Learn feed</h1>
          <p className="lede">
            {agency
              ? `Short safety videos, articles and quizzes from ${agency}, in the topics you handle. The platform team reviews each post before it goes live.`
              : 'Short safety videos and tips shown to citizens, reviewed before they go live.'}
          </p>
        </div>
        <button className="btn primary" type="button" onClick={() => setPanel({ mode: 'new' })}>
          New post
        </button>
      </div>
      <div className="bounty-grid">
        <section className="card" style={{ padding: 16 }}>
          <div className="segmented tabs" role="tablist" aria-label="Posts">
            {TABS.map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => (setTab(k), setPanel({ mode: 'new' }))}>
                {l} {data && <span className="count">{data.counts[k]}</span>}
              </button>
            ))}
          </div>
          {error && (
            <div className="banner critical" role="alert">
              {error.message}
            </div>
          )}
          {!data ? (
            [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 88 }} />)
          ) : !data.items.length ? (
            <div className="empty">
              <strong>{tab === 'in_review' ? 'Nothing waiting for review.' : tab === 'draft' ? 'No drafts.' : tab === 'removed' ? 'Nothing removed.' : 'No live posts yet.'}</strong>
              {tab === 'live' ? 'Write a post and send it for review.' : ''}
            </div>
          ) : (
            <div className="post-list">
              {data.items.map((p) => (
                <button key={p.id} type="button" className="post-row" aria-current={current?.id === p.id} onClick={() => setPanel({ mode: 'view', id: p.id })}>
                  <span className={`post-thumb tone-${p.topic.tone}`} aria-hidden>
                    {p.format === 'video' ? '▶' : p.format === 'quiz' ? '?' : '¶'}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong>{p.title}</strong>
                    <span className="muted" style={{ display: 'block' }}>
                      {p.topic.label} · {p.source} · {FORMAT[p.format]}
                      {p.state === 'live' ? ` · ${p.views.toLocaleString()} views` : ''}
                    </span>
                  </span>
                  <span className={`chip ${STATE_CHIP[p.state][1]}`}>{STATE_CHIP[p.state][0]}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="card" aria-live="polite">
          {panel.mode === 'new' && sources && <PostForm key="new" sources={sources} onDone={done} />}
          {panel.mode === 'edit' && current && sources && <PostForm key={current.id} post={current} sources={sources} onDone={done} />}
          {panel.mode === 'view' && current && <PostView p={current} onEdit={() => setPanel({ mode: 'edit', id: current.id })} onDone={done} />}
        </section>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- one post

function PostView({ p, onEdit, onDone }: { p: Post; onEdit: () => void; onDone: (m: string, s?: State) => void }) {
  const { base, agency } = useContext(Scope);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ask, setAsk] = useState<'send_back' | 'remove' | null>(null);
  const act = async (event: string, note?: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ state: State; message: string }>(`${base}/posts/${p.id}/actions`, { method: 'POST', body: JSON.stringify({ event, note }) });
      onDone(r.message, r.state);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not do that. Try again.');
      setBusy(false);
    }
  };
  return (
    <>
      <h2 style={{ marginTop: 0 }}>{p.title}</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {p.topic.label} · {p.source} · {FORMAT[p.format]} · {learnLanguages.find((l) => l.code === p.language)?.label}
        {p.audienceState ? ` · ${p.audienceState} only` : ' · Everyone'}
      </p>
      {p.reviewNote && p.state === 'draft' && (
        <div className="banner warning">
          <strong>Sent back</strong>
          {p.reviewNote}
        </div>
      )}
      {p.removedReason && (
        <div className="banner critical">
          <strong>Removed</strong>
          {p.removedReason}
        </div>
      )}
      {p.media && <MediaPreview path={p.media.url} kind={p.media.kind} />}
      <p className="quote" style={{ marginTop: 12 }}>
        {p.caption || 'No caption yet.'}
      </p>
      {p.format !== 'quiz' && p.body && (
        <details style={{ marginTop: 12 }}>
          <summary>{p.format === 'video' ? 'Steps' : 'Article'}</summary>
          <div className="post-body">{p.body}</div>
        </details>
      )}
      {p.format === 'quiz' && p.quiz && (
        <ol className="post-quiz">
          {p.quiz.map((q, i) => (
            <li key={i}>
              <strong>{q.q}</strong>
              <span>
                {q.options.map((o, k) => (k === q.answer ? `✓ ${o}` : o)).join(' · ')}
              </span>
            </li>
          ))}
        </ol>
      )}
      <dl className="facts" style={{ marginTop: 12 }}>
        <div>
          <dt>Written by</dt>
          <dd>{p.author}</dd>
        </div>
        {p.submittedBy && (
          <div>
            <dt>Sent for review by</dt>
            <dd>{p.submittedBy}</dd>
          </div>
        )}
        {p.state === 'live' && (
          <div>
            <dt>Views and likes</dt>
            <dd>
              {p.views.toLocaleString()} · {p.likes.toLocaleString()}
            </dd>
          </div>
        )}
        <div>
          <dt>Updated</dt>
          <dd>{dateTime(p.updatedAt)}</dd>
        </div>
      </dl>
      {err && (
        <div className="banner critical" role="alert" style={{ marginTop: 12 }}>
          {err}
        </div>
      )}
      <div className="actions">
        {p.state === 'draft' && (
          <>
            <button className="btn" type="button" onClick={onEdit} disabled={busy}>
              Edit
            </button>
            <button className="btn primary" type="button" onClick={() => void act('submit')} disabled={busy}>
              Send for review
            </button>
          </>
        )}
        {p.state === 'in_review' && agency && (
          <p className="muted" style={{ margin: 0 }}>
            Waiting for the platform team to review it.
          </p>
        )}
        {p.state === 'in_review' &&
          !agency &&
          (p.submittedByMe ? (
            <p className="muted" style={{ margin: 0 }}>
              You sent this. Someone else on the team reviews it.
            </p>
          ) : (
            <>
              <button className="btn" type="button" onClick={() => setAsk('send_back')} disabled={busy}>
                Send back
              </button>
              <button className="btn primary" type="button" onClick={() => void act('approve')} disabled={busy}>
                Approve and publish
              </button>
            </>
          ))}
        {p.state !== 'removed' && !agency && (
          <button className="btn danger" type="button" onClick={() => setAsk('remove')} disabled={busy}>
            Remove
          </button>
        )}
        {p.state === 'removed' && !agency && (
          <button className="btn" type="button" onClick={() => void act('restore')} disabled={busy}>
            Restore as draft
          </button>
        )}
      </div>
      {ask && <NoteSheet kind={ask} onClose={() => setAsk(null)} onConfirm={(n) => (setAsk(null), void act(ask, n))} />}
    </>
  );
}

function NoteSheet({ kind, onClose, onConfirm }: { kind: 'send_back' | 'remove'; onClose: () => void; onConfirm: (note: string) => void }) {
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const bad = note.trim().length < 3;
  return (
    <Sheet
      open
      title={kind === 'remove' ? 'Remove from the feed' : 'Send back to draft'}
      description={kind === 'remove' ? 'Citizens stop seeing it at once. The reason is kept in the audit log.' : 'The writer sees your note on the draft.'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${kind === 'remove' ? 'danger' : 'primary'}`} type="button" onClick={() => (setTried(true), !bad && onConfirm(note.trim()))}>
            {kind === 'remove' ? 'Remove' : 'Send back'}
          </button>
        </>
      }
    >
      <label className="field" data-invalid={tried && bad}>
        <span>{kind === 'remove' ? 'Why is it being removed?' : 'What needs to change?'}</span>
        <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} aria-invalid={tried && bad} />
        {tried && bad && <span className="field-error">{kind === 'remove' ? 'Say why it is being removed.' : 'Say what needs to change.'}</span>}
      </label>
    </Sheet>
  );
}

function MediaPreview({ path, kind }: { path: string; kind: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    let alive = true;
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
  if (!url) return <div className="skeleton" style={{ height: 180 }} />;
  return kind === 'video' ? <video src={url} controls className="post-media" /> : <img src={url} alt="" className="post-media" />;
}

// ---------------------------------------------------------------- write or edit

function PostForm({ post, sources, onDone }: { post?: Post; sources: Sources; onDone: (m: string, s?: State) => void }) {
  const { base, agency } = useContext(Scope);
  const topics = sources.topics ? learnTopics.filter((t) => sources.topics!.includes(t.code)) : learnTopics;
  const [format, setFormat] = useState<Format>(post?.format ?? 'video');
  const [title, setTitle] = useState(post?.title ?? '');
  const [topic, setTopic] = useState(post?.topic.code ?? topics[0]?.code ?? 'fire_safety');
  const [language, setLanguage] = useState(post?.language ?? 'en');
  const [source, setSource] = useState(post?.sourceAgencyId ?? '');
  const [audience, setAudience] = useState(post?.audienceState ?? '');
  const [caption, setCaption] = useState(post?.caption ?? '');
  const [body, setBody] = useState(post?.body ?? '');
  const [quiz, setQuiz] = useState<Question[]>(post?.quiz ?? [{ q: '', options: ['', ''], answer: 0, why: '' }]);
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(post?.durationS ?? null);
  const [progress, setProgress] = useState<number | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const pickFile = (f: File | null) => {
    setErrs((e) => ({ ...e, media: '' }));
    if (!f) return;
    if (!['video/mp4', 'video/quicktime', 'image/jpeg', 'image/png', 'image/webp'].includes(f.type) || f.size > 10 * 1024 * 1024) {
      return setErrs((e) => ({ ...e, media: 'Use an MP4 or MOV video, or a JPEG/PNG image, up to 10 MB.' }));
    }
    setFile(f);
    if (f.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        setDuration(Math.round(v.duration));
        URL.revokeObjectURL(v.src);
      };
      v.src = URL.createObjectURL(f);
    }
  };

  const upload = async (postId: string, f: File) => {
    await ensureFreshToken();
    const reg = await api<{ uploadUrl: string }>('/media', {
      method: 'POST',
      body: JSON.stringify({ ownerType: 'learn_post', ownerId: postId, contentType: f.type, sizeBytes: f.size, ...(duration ? { durationS: duration } : {}) }),
    });
    await new Promise<void>((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', `${API_URL}${reg.uploadUrl}`);
      x.setRequestHeader('Content-Type', f.type);
      x.setRequestHeader('Authorization', `Bearer ${getSession()?.token ?? ''}`);
      x.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total);
      x.onload = () => (x.status < 300 ? resolve() : reject(new ApiError(x.status, 'upload_failed', 'The file was not accepted.')));
      x.onerror = () => reject(new ApiError(0, 'offline', 'Upload failed. Check your connection.'));
      x.send(f);
    });
  };

  const save = async (submit: boolean) => {
    setErrs({});
    setBusy(true);
    try {
      const payload = {
        title,
        caption,
        topic,
        format,
        language,
        body: format === 'quiz' ? null : body || null,
        quiz: format === 'quiz' ? quiz : null,
        durationS: format === 'video' ? duration : null,
        sourceAgencyId: source || null,
        audienceState: audience || null,
      };
      const id = post
        ? (await api<{ id: string }>(`${base}/posts/${post.id}`, { method: 'PATCH', body: JSON.stringify(payload) }), post.id)
        : (await api<{ id: string }>(`${base}/posts`, { method: 'POST', body: JSON.stringify(payload) })).id;
      if (file) await upload(id, file);
      if (submit) {
        const r = await api<{ state: State; message: string }>(`${base}/posts/${id}/actions`, { method: 'POST', body: JSON.stringify({ event: 'submit' }) });
        onDone(r.message, r.state);
      } else onDone('Draft saved.', 'draft');
    } catch (e) {
      if (e instanceof ApiError && e.fields?.length) setErrs(Object.fromEntries(e.fields.map((f) => [f.field, f.message])));
      else setErrs({ form: e instanceof ApiError ? e.message : 'Could not save. Try again.' });
      setBusy(false);
      setProgress(null);
    }
  };

  const setQ = (i: number, patch: Partial<Question>) => setQuiz((qs) => qs.map((q, k) => (k === i ? { ...q, ...patch } : q)));
  return (
    <>
      <h2 style={{ marginTop: 0 }}>{post ? 'Edit draft' : 'New post'}</h2>
      {errs.form && (
        <div className="banner critical" role="alert">
          {errs.form}
        </div>
      )}
      <div className="segmented" role="radiogroup" aria-label="Format" style={{ marginBottom: 12 }}>
        {(['video', 'article', 'quiz'] as const).map((f) => (
          <button key={f} type="button" role="radio" aria-checked={format === f} aria-pressed={format === f} onClick={() => setFormat(f)}>
            {FORMAT[f]}
          </button>
        ))}
      </div>
      <label className="field" data-invalid={!!errs.title} style={{ marginBottom: 12 }}>
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder="What to do first in a house fire" aria-invalid={!!errs.title} />
        {errs.title && <span className="field-error">{errs.title}</span>}
      </label>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <label className="field">
          <span>Topic</span>
          <select value={topic} onChange={(e) => setTopic(e.target.value)}>
            {topics.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {learnLanguages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>From</span>
          <select value={agency ? sources.agencies[0]?.id : source} onChange={(e) => setSource(e.target.value)} disabled={!!agency}>
            {!agency && <option value="">Platform team</option>}
            {sources.agencies.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Show to</span>
          <select value={audience} onChange={(e) => setAudience(e.target.value)}>
            <option value="">Everyone</option>
            {sources.states.map((s) => (
              <option key={s.code} value={s.code}>
                Everyone in {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {format !== 'quiz' && (
        <div className="field" data-invalid={!!errs.media} style={{ marginBottom: 12 }}>
          <button type="button" className="upload-drop" onClick={() => fileInput.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), pickFile(e.dataTransfer.files[0] ?? null))}>
            {file ? (
              <>
                <strong>{file.name}</strong>
                <span className="muted">
                  {(file.size / 1024 / 1024).toFixed(1)} MB{duration ? ` · ${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}` : ''} · Click to change
                </span>
              </>
            ) : post?.media ? (
              <>
                <strong>File uploaded</strong>
                <span className="muted">Click to replace</span>
              </>
            ) : (
              <>
                <strong>Upload a video or image</strong>
                <span className="muted">MP4 or MOV up to 10 MB, or a cover image{format === 'video' ? '. Videos need footage before review.' : ''}</span>
              </>
            )}
          </button>
          <input ref={fileInput} type="file" hidden accept="video/mp4,video/quicktime,image/jpeg,image/png,image/webp" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
          {progress != null && (
            <span className="upload-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <i style={{ transform: `scaleX(${progress})` }} />
            </span>
          )}
          {errs.media && <span className="field-error">{errs.media}</span>}
        </div>
      )}

      <label className="field" data-invalid={!!errs.caption} style={{ marginBottom: 12 }}>
        <span>Caption</span>
        <textarea value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={300} placeholder="Short tip, one or two lines" style={{ minHeight: 64 }} aria-invalid={!!errs.caption} />
        {errs.caption && <span className="field-error">{errs.caption}</span>}
      </label>

      {format !== 'quiz' && (
        <label className="field" data-invalid={!!errs.body} style={{ marginBottom: 12 }}>
          <span>{format === 'article' ? 'Article' : 'Steps (optional, one per line)'}</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={8000}
            placeholder={format === 'article' ? 'Short paragraphs. Leave a blank line between them.' : 'Shown as a step-by-step card if the video cannot play.'}
            style={{ minHeight: format === 'article' ? 180 : 96 }}
            aria-invalid={!!errs.body}
          />
          {errs.body && <span className="field-error">{errs.body}</span>}
        </label>
      )}

      {format === 'quiz' && (
        <div className="field" data-invalid={!!errs.quiz} style={{ marginBottom: 12 }}>
          <span>Questions</span>
          {quiz.map((q, i) => (
            <fieldset key={i} className="quiz-edit">
              <legend>Question {i + 1}</legend>
              <input value={q.q} onChange={(e) => setQ(i, { q: e.target.value })} placeholder="Smoke is filling the corridor. What do you do?" aria-label={`Question ${i + 1}`} />
              {q.options.map((o, k) => (
                <div key={k} className="quiz-edit-opt">
                  <input type="radio" name={`ans-${i}`} checked={q.answer === k} onChange={() => setQ(i, { answer: k })} aria-label={`Answer ${k + 1} is right`} />
                  <input value={o} onChange={(e) => setQ(i, { options: q.options.map((x, j) => (j === k ? e.target.value : x)) })} placeholder={`Answer ${k + 1}`} aria-label={`Answer ${k + 1}`} />
                  {q.options.length > 2 && (
                    <button type="button" className="link-btn" aria-label={`Remove answer ${k + 1}`} onClick={() => setQ(i, { options: q.options.filter((_, j) => j !== k), answer: q.answer >= k && q.answer > 0 ? q.answer - 1 : q.answer })}>
                      ×
                    </button>
                  )}
                </div>
              ))}
              {q.options.length < 5 && (
                <button type="button" className="link-btn" onClick={() => setQ(i, { options: [...q.options, ''] })}>
                  Add an answer
                </button>
              )}
              <input value={q.why} onChange={(e) => setQ(i, { why: e.target.value })} placeholder="Why this is right (shown after answering)" aria-label={`Explanation for question ${i + 1}`} />
              {quiz.length > 1 && (
                <button type="button" className="link-btn" onClick={() => setQuiz((qs) => qs.filter((_, k) => k !== i))}>
                  Remove question
                </button>
              )}
            </fieldset>
          ))}
          {quiz.length < 10 && (
            <button type="button" className="btn" onClick={() => setQuiz((qs) => [...qs, { q: '', options: ['', ''], answer: 0, why: '' }])}>
              Add a question
            </button>
          )}
          {errs.quiz && <span className="field-error">{errs.quiz}</span>}
        </div>
      )}

      <div className="actions">
        <button className="btn" type="button" onClick={() => void save(false)} disabled={busy}>
          Save draft
        </button>
        <button className="btn signal" type="button" onClick={() => void save(true)} disabled={busy} style={{ flex: 1 }}>
          {busy ? (progress != null ? `Uploading ${Math.round(progress * 100)}%` : 'Saving…') : 'Send for review'}
        </button>
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        Another member of the team reviews it before it goes live.
      </p>
    </>
  );
}
