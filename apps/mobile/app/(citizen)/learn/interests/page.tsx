'use client';
// Board "Learn choose interests": pick at least 3; languages; "You stay in control".
import { Sheet } from '@erp/web-ui/Sheet';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { LEARN_SKIP_KEY } from '@/components/learn/Learn';
import { api, ApiError, haptic } from '@/lib/client';

interface Catalogue {
  topics: { code: string; label: string }[];
  languages: { code: string; label: string }[];
}

function Interests() {
  const router = useRouter();
  const next = useSearchParams().get('next') || '/learn';
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [topics, setTopics] = useState<string[]>([]);
  const [langs, setLangs] = useState<string[]>(['en']);
  const [min, setMin] = useState(3);
  const [langSheet, setLangSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Catalogue>('/learn/topics').then(setCat).catch(() => {});
    api<{ topics: string[]; languages: string[]; min: number }>('/me/learn/interests')
      .then((r) => {
        setTopics(r.topics);
        setLangs(r.languages.length ? r.languages : ['en']);
        setMin(r.min);
      })
      .catch(() => {});
  }, []);

  const toggle = (c: string) => {
    haptic(6);
    setErr(null);
    setTopics((xs) => (xs.includes(c) ? xs.filter((x) => x !== c) : [...xs, c]));
  };
  const save = async () => {
    if (topics.length < min) return setErr(`Pick at least ${min}.`);
    setBusy(true);
    try {
      await api('/me/learn/interests', { method: 'PUT', body: JSON.stringify({ topics, languages: langs }) });
      router.replace(next);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save. Try again.');
      setBusy(false);
    }
  };
  const langLabel = langs.map((l) => cat?.languages.find((x) => x.code === l)?.label ?? l).join(', ');

  return (
    <main className="app bare">
      <Header title="What do you want to learn?" back={next} />
      <p className="muted" style={{ marginTop: 0 }}>
        Pick at least {min}. We use this for your feed, and learn from what you watch.
      </p>
      {!cat ? (
        <div className="skeleton" style={{ height: 240 }} />
      ) : (
        <div className="chips interest-chips" role="group" aria-label="Topics">
          {cat.topics.map((t) => (
            <button key={t.code} type="button" aria-pressed={topics.includes(t.code)} onClick={() => toggle(t.code)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="row" style={{ cursor: 'default', margin: '16px 0 12px' }}>
        <span className="grow">
          <strong>Languages</strong>
          <span className="sub">{langLabel || 'English'}</span>
        </span>
        <button type="button" className="link-btn" onClick={() => setLangSheet(true)}>
          Change
        </button>
      </div>
      <div className="banner info">
        <strong>You stay in control</strong>
        Tap Not interested on any lesson to see less of it. Change this any time in Learn, Your interests.
      </div>
      <p className="center muted" style={{ margin: '20px 0 8px' }} aria-live="polite">
        {topics.length} picked
      </p>
      {err && (
        <p className="field-error center" role="alert">
          {err}
        </p>
      )}
      <button className="btn block primary" type="button" onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Continue'}
      </button>
      <button
        className="link-btn center"
        type="button"
        style={{ display: 'block', margin: '12px auto 0' }}
        onClick={() => {
          try {
            localStorage.setItem(LEARN_SKIP_KEY, '1');
          } catch {}
          router.replace(next.startsWith('/learn?') ? next : '/learn?tab=general');
        }}
      >
        Skip for now
      </button>
      {langSheet && cat && (
        <Sheet
          open
          title="Languages"
          description="Lessons in these languages come first."
          onClose={() => setLangSheet(false)}
          footer={
            <button className="btn primary" type="button" onClick={() => setLangSheet(false)} disabled={!langs.length}>
              Done
            </button>
          }
        >
          <div className="chips interest-chips">
            {cat.languages.map((l) => (
              <button key={l.code} type="button" aria-pressed={langs.includes(l.code)} onClick={() => setLangs((xs) => (xs.includes(l.code) ? xs.filter((x) => x !== l.code) : [...xs, l.code]))}>
                {l.label}
              </button>
            ))}
          </div>
          {!langs.length && <span className="field-error">Choose at least one language.</span>}
        </Sheet>
      )}
    </main>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Interests />
    </Suspense>
  );
}
