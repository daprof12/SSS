'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError, haptic } from '@/lib/client';

const TAGS = [
  ['fast', 'Arrived fast'],
  ['polite', 'Polite'],
  ['solved', 'Problem solved'],
  ['professional', 'Professional'],
  ['slow', 'Slow'],
  ['rude', 'Rude'],
  ['not_solved', 'Not solved'],
] as const;
const WORDS = ['', 'Very poor', 'Poor', 'Okay', 'Good', 'Excellent'];

/** Rate the response, then after-care (Design Brief: rating, tips, optional donation, thanks). */
export default function Rate({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [stars, setStars] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    if (!stars) return setErr('Choose 1 to 5 stars.');
    setBusy(true);
    setErr(null);
    try {
      await api(`/incidents/${id}/rating`, { method: 'POST', body: JSON.stringify({ stars, tags, comment: comment.trim() || undefined }) });
      haptic(30);
      setDone(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'already_rated') setDone(true);
      else setErr(e instanceof ApiError ? e.message : 'Could not send. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <main className="app bare center">
        <div className="check">
          <Icon name="check" size={44} />
        </div>
        <h1>Thank you</h1>
        <p className="muted">Your rating helps teams improve. We hope you are safe.</p>
        <div className="card" style={{ textAlign: 'left' }}>
          <h2>After an emergency</h2>
          <p className="muted" style={{ margin: 0 }}>
            Check on the people around you, keep any evidence safe, and rest. If anything changes, report again in two taps.
          </p>
        </div>
        <Link href="/donate" className="btn block" style={{ marginBottom: 8 }}>
          <Icon name="heart" /> Support responders
        </Link>
        <Link href="/home" className="btn block signal">
          Back to Home
        </Link>
      </main>
    );
  }

  return (
    <main className="app bare">
      <Header title="Rate the response" back={`/reports/${id}`} />
      <p className="muted">How did the team do?</p>
      <div className="stars" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={stars === n}
            aria-label={`${n} star${n > 1 ? 's' : ''}, ${WORDS[n]}`}
            className={n <= stars ? 'lit' : ''}
            onClick={() => {
              setStars(n);
              setErr(null);
              haptic(10);
            }}
          >
            <Icon name="star" size={44} filled={n <= stars} />
          </button>
        ))}
      </div>
      <p className="center" style={{ fontWeight: 700, minHeight: 24 }}>
        {WORDS[stars]}
      </p>
      <div className="chips" role="group" aria-label="What stood out" style={{ justifyContent: 'center', marginBottom: 16 }}>
        {TAGS.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={tags.includes(k)} onClick={() => setTags((t) => (t.includes(k) ? t.filter((x) => x !== k) : [...t, k]))}>
            {l}
          </button>
        ))}
      </div>
      <label className="field">
        <span>Anything else? (optional)</span>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
      </label>
      {err && (
        <p className="field-error" role="alert">
          {err}
        </p>
      )}
      <button className="btn block signal" type="button" onClick={submit} disabled={busy}>
        {busy ? 'Sending…' : 'Send rating'}
      </button>
      <Link href="/home" className="btn block" style={{ marginTop: 8 }}>
        Skip
      </Link>
      <p className="muted center">You can rate this later from Activity.</p>
    </main>
  );
}
