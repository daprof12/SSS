'use client';
// Board "Admin AI review detail": a low-confidence statement translation. The signed record never
// changes: add a note, send it to a certified translator, or ask the reporter to record it again.
import { LinkButton } from '@erp/web-ui/LinkButton';
import { api, ApiError } from '@erp/web-ui/api';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';

interface Review {
  statementId: string;
  number: string;
  version: number;
  language: string;
  confidencePct: number | null;
  thresholdPct: number;
  signedAt: string;
  original: string;
  english: string;
  flagged: string[];
  hasAudio: boolean;
  status: string;
  cause: string;
  decision: { decision: string; note: string | null; by: string; at: string } | null;
  trend: { reviewed: number; corrected: number };
}
type Decision = 'looks_right' | 'note' | 'translator' | 'rerecord';
const DONE: Record<string, string> = { looks_right: 'Marked as right', note: 'Note added', translator: 'Sent to a translator', rerecord: 'Re-record asked' };

/** The text with flagged words marked. */
function Marked({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return (
    <>
      {text.split(re).map((part, i) =>
        words.includes(part) ? (
          <mark key={i} style={{ background: 'rgba(250, 204, 21, 0.25)', color: 'inherit', borderRadius: 4, padding: '0 2px' }}>
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export default function AiReview() {
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteErr, setNoteErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  const load = useCallback(() => {
    api<Review>(`/admin/ai/reviews/${id}`)
      .then(setR)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the review.'));
  }, [id]);
  useEffect(load, [load]);
  const decide = async (decision: Decision) => {
    if (decision !== 'looks_right' && note.trim().length < 3) return setNoteErr('A note is required.');
    setBusy(true);
    setNoteErr(null);
    try {
      setToast((await api<{ message: string }>(`/admin/ai/reviews/${id}`, { method: 'POST', body: JSON.stringify({ decision, note: note.trim() || undefined }) })).message);
      load();
    } catch (e) {
      if (e instanceof ApiError && e.fields?.length) setNoteErr(e.fields[0]!.message);
      else setToast(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  const Row = ({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) => (
    <div className="row">
      <span className="muted">{k}</span>
      <strong style={{ color: tone, textAlign: 'right' }}>{v}</strong>
    </div>
  );
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Review: statement translation {r?.number ?? ''}</h1>
          <p className="lede">
            {r ? `${r.language} to English, confidence ${r.confidencePct ?? '—'}%, signed ${new Date(r.signedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ' '}
          </p>
        </div>
        <LinkButton className="btn" href="/admin/ai">
          Back to review queue
        </LinkButton>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      {!r && !error && <div className="skeleton" style={{ height: 300 }} />}
      {r && (
        <>
          <div className="grid two">
            <section className="card" aria-labelledby="orig">
              <h2 id="orig" style={{ marginTop: 0 }}>
                Reporter original, {r.language}
              </h2>
              <p style={{ background: 'var(--color-surface-sunken)', padding: 12, borderRadius: 10, margin: 0 }}>
                <Marked text={r.original} words={r.flagged} />
              </p>
              <Row k="Audio" v={r.hasAudio ? 'Recorded' : 'Typed, no audio'} />
            </section>
            <section className="card" aria-labelledby="eng">
              <h2 id="eng" style={{ marginTop: 0 }}>
                AI English record
              </h2>
              <p style={{ background: 'var(--color-info-surface, rgba(34, 211, 238, 0.08))', padding: 12, borderRadius: 10, margin: 0 }}>
                <Marked text={r.english} words={r.flagged} />
              </p>
              <Row k="Flagged words" v={r.flagged.length} tone="var(--color-warning-text)" />
              <Row k="Status" v={r.status} tone="var(--color-success-text)" />
            </section>
          </div>
          <section className="card" aria-labelledby="why">
            <h2 id="why" style={{ marginTop: 0 }}>
              Why it was flagged
            </h2>
            <Row k="Confidence" v={`${r.confidencePct ?? '—'}% below ${r.thresholdPct}%`} tone="var(--color-warning-text)" />
            <Row k="Cause" v={r.cause} />
            <Row k="Language check" v={r.language} />
          </section>
          <div className="grid two">
            <section className="card" aria-labelledby="dec">
              <h2 id="dec" style={{ marginTop: 0 }}>
                Your decision
              </h2>
              {r.decision ? (
                <div className="banner info" style={{ margin: 0 }}>
                  <strong style={{ display: 'block' }}>{DONE[r.decision.decision]}</strong>
                  {r.decision.by}, {new Date(r.decision.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  {r.decision.note ? `: “${r.decision.note}”` : '.'}
                </div>
              ) : (
                <>
                  <div className="banner warning" style={{ margin: '0 0 12px' }}>
                    <strong style={{ display: 'block' }}>You cannot change the signed record</strong>
                    Add a note beside the AI text or send it to a certified translator. The reporter signs any new version.
                  </div>
                  <label className="field" data-invalid={!!noteErr}>
                    <span>Reviewer note</span>
                    <textarea value={note} onChange={(e) => (setNote(e.target.value), setNoteErr(null))} maxLength={1000} />
                  </label>
                  {noteErr && (
                    <span className="field-error" role="alert">
                      {noteErr}
                    </span>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginTop: 12 }}>
                    <button className="btn primary" type="button" disabled={busy} onClick={() => decide('looks_right')}>
                      Looks right
                    </button>
                    <button className="btn" type="button" disabled={busy} onClick={() => decide('note')}>
                      Add note
                    </button>
                    <button className="btn signal" type="button" disabled={busy} onClick={() => decide('translator')}>
                      Send to translator
                    </button>
                    <button className="btn" type="button" disabled={busy} onClick={() => decide('rerecord')}>
                      Ask reporter to re-record
                    </button>
                  </div>
                </>
              )}
            </section>
            <section className="card" aria-labelledby="tch">
              <h2 id="tch" style={{ marginTop: 0 }}>
                What this teaches
              </h2>
              <Row k="Added to test set" v="Yes, after approval" />
              <Row k="Used to train" v="No, only to measure accuracy" />
              <div className="banner info" style={{ margin: '8px 0 0' }}>
                <strong style={{ display: 'block' }}>Quality trend</strong>
                {r.language} reviews this week: {r.trend.reviewed}, corrected: {r.trend.corrected}.
              </div>
            </section>
          </div>
        </>
      )}
    </>
  );
}
