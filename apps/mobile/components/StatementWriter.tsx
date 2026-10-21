'use client';
// The person writing their own statement (B7): citizens, and officers giving an officer's statement.

import { STATEMENT_LANGUAGES, STATEMENT_RULES, languageName } from '@erp/domain';
import { downloadFile } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { uploadPicked, usePicked, VoiceRecorder } from '@/components/reports/Attach';
import { PinPad } from '@/components/WithdrawFlow';
import { api, ApiError, haptic } from '@/lib/client';

interface Version {
  version: number;
  language: string;
  languageName: string;
  original: string;
  english: string;
  signedAt: string;
  seal: string;
}
interface Statement {
  id: string;
  number: string;
  state: 'requested' | 'draft' | 'signed' | 'change_requested';
  report: { id: string; label: string };
  station: string | null;
  form?: string;
  mode?: 'self' | 'in_person';
  requestNote: string | null;
  changeNote: string | null;
  draft: { language: string | null; original: string | null; english: string | null; confidence: number | null; flagged: string[] } | null;
  versions: Version[];
  latest: { version: number; of: number; seal: string; signedAt: string } | null;
}
type Step = 'record' | 'review' | 'signed';
const OFFLINE_KEY = (id: string) => `erp:statement:${id}`;

/** Boards "Statement record in any language", "Statement review and sign", "Statement signed, download". */
export function StatementWriter({ id, home = '/activity', reportHref = (r: string) => `/reports/${r}` }: { id: string; home?: string; reportHref?: (reportId: string) => string }) {
  const router = useRouter();
  const [s, setS] = useState<Statement | null | undefined>(undefined);
  const [step, setStep] = useState<Step>('record');
  const [lang, setLang] = useState('auto');
  const [original, setOriginal] = useState('');
  const [english, setEnglish] = useState('');
  const [busy, setBusy] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [toast, setToast] = useToast();
  const picked = usePicked();
  const savedOriginal = useRef('');

  const apply = (x: Statement) => {
    setS(x);
    if (x.state === 'signed') return setStep('signed');
    if (x.draft) {
      setLang(x.draft.language ?? 'auto');
      setOriginal(x.draft.original ?? '');
      setEnglish(x.draft.english ?? '');
      savedOriginal.current = x.draft.original ?? '';
    }
  };
  useEffect(() => {
    api<Statement>(`/me/statements/${id}`)
      .then(apply)
      .catch(() => setS(null));
  }, [id]);

  /** Saves the words and gets the AI English record (only when the words or language changed). */
  const translate = async (opts: { keepEnglish?: boolean; quiet?: boolean } = {}) => {
    // A save when the field loses focus only refreshes the English; it never blocks the button.
    const set = opts.quiet ? setTranslating : setBusy;
    set(true);
    setErr(null);
    try {
      const x = await api<Statement>(`/me/statements/${id}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ language: lang, original, ...(opts.keepEnglish ? { english } : {}) }),
      });
      apply(x);
      return x;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save. Try again.');
      return null;
    } finally {
      set(false);
    }
  };

  const toReview = async () => {
    if (original.trim().length < STATEMENT_RULES.minChars) return setErr(`Say a little more first, at least ${STATEMENT_RULES.minChars} characters.`);
    if (picked.items.some((p) => p.state !== 'done')) await uploadPicked('statement', id, picked);
    const x = await translate();
    if (x) setStep('review');
  };

  if (s === null) {
    return (
      <main className="app">
        <Header title="Your statement" back={home} />
        <div className="empty">
          <strong>Statement not found.</strong>
          <Link href={home}>Go back</Link>
        </div>
      </main>
    );
  }
  if (!s) return <main className="app">{<div className="skeleton" style={{ height: 300 }} />}</main>;

  if (step === 'signed') return <Signed s={s} onAmend={async () => apply(await api<Statement>(`/me/statements/${id}/amend`, { method: 'POST' }))} onToast={setToast} toast={toast} onDone={() => router.push(reportHref(s.report.id))} back={reportHref(s.report.id)} />;
  if (step === 'review') {
    return (
      <Review
        s={s}
        original={original}
        english={english}
        setEnglish={setEnglish}
        onBack={() => setStep('record')}
        onSaveEnglish={() => translate({ keepEnglish: true })}
        onSigned={(m) => {
          setToast(m);
          api<Statement>(`/me/statements/${id}`).then(apply).catch(() => {});
        }}
      />
    );
  }

  const shown = lang === 'auto' ? 'your language' : languageName(lang);
  return (
    <main className="app" style={{ paddingBottom: 110 }}>
      <Header title={s.form ?? 'Your statement'} back={reportHref(s.report.id)} />
      <div className="banner info">
        <strong>
          {s.station ?? 'The station'} {s.state === 'change_requested' ? 'asked for more detail' : 'asked for your statement'}
        </strong>
        {s.state === 'change_requested' && s.changeNote ? `"${s.changeNote}" ` : s.requestNote ? `"${s.requestNote}" ` : ''}
        For {s.number}, {s.report.label}. Speak in the language you are most comfortable in.
      </div>

      <p className="section-label">Language</p>
      <div className="chips" role="radiogroup" aria-label="Language" style={{ marginBottom: 16 }}>
        {STATEMENT_LANGUAGES.map((l) => (
          <button key={l.code} type="button" role="radio" aria-checked={lang === l.code} aria-pressed={lang === l.code} onClick={() => setLang(l.code)}>
            {l.label}
          </button>
        ))}
      </div>

      <div className="card center" style={{ display: 'grid', justifyItems: 'center', gap: 8 }}>
        {recording ? (
          <VoiceRecorder
            onDone={(file, secs) => {
              setRecording(false);
              const bad = picked.addVoice(file, secs);
              setToast(bad ?? 'Recording kept with your statement. Type what you said below.');
            }}
            onCancel={() => setRecording(false)}
            onError={(m) => {
              setRecording(false);
              setToast(m);
            }}
          />
        ) : (
          <>
            <button type="button" className="sos" onClick={() => (haptic(20), setRecording(true))} aria-label="Record your statement" style={{ width: 96, height: 96, borderRadius: '50%', border: 0, background: 'var(--color-action-primary)', color: '#fff', display: 'grid', placeItems: 'center' }}>
              <Icon name="mic" size={40} />
            </button>
            <strong>{picked.items.length ? `${picked.items.length} recording${picked.items.length === 1 ? '' : 's'} kept` : 'Record your statement'}</strong>
            <span className="muted">Or type it. You can add more later.</span>
          </>
        )}
      </div>

      <label className="field" style={{ marginTop: 12 }}>
        <span className="section-label" style={{ margin: 0 }}>
          What you said, {shown}
        </span>
        <textarea value={original} onChange={(e) => setOriginal(e.target.value)} rows={5} maxLength={STATEMENT_RULES.maxChars} placeholder={`Your words in ${shown}, exactly as you would say them.`} onBlur={() => original.trim() && original !== savedOriginal.current && void translate({ quiet: true })} />
      </label>
      <p className="section-label">English record, made by AI</p>
      <div className="banner info" style={{ minHeight: 64 }} aria-live="polite">
        {busy || translating ? 'Making the English version…' : english || 'The English version appears here. You check it before you sign.'}
      </div>
      {err && (
        <span className="field-error" role="alert">
          {err}
        </span>
      )}
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', maxWidth: 520, margin: '0 auto' }}>
        <button className="btn block primary" type="button" onClick={toReview} disabled={busy || recording} style={{ minHeight: 56 }}>
          {busy ? 'Saving…' : 'Review and sign'}
        </button>
      </div>
      <Toast msg={toast} />
    </main>
  );
}

function Review({
  s,
  original,
  english,
  setEnglish,
  onBack,
  onSaveEnglish,
  onSigned,
}: {
  s: Statement;
  original: string;
  english: string;
  setEnglish: (v: string) => void;
  onBack: () => void;
  onSaveEnglish: () => Promise<Statement | null>;
  onSigned: (m: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pinErr, setPinErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const lang = languageName(s.draft?.language ?? 'auto');
  const flagged = s.draft?.flagged ?? [];
  const canListen = typeof window !== 'undefined' && 'speechSynthesis' in window;

  const sign = async (pin: string) => {
    setBusy(true);
    setPinErr(null);
    try {
      const r = await api<{ message: string }>(`/me/statements/${s.id}/sign`, { method: 'POST', body: JSON.stringify({ pin, confirm, method: 'pin' }) });
      haptic([40, 30, 40]);
      setSigning(false);
      onSigned(r.message);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'pin_wrong' || e.code === 'pin_locked' || e.code === 'pin_not_set')) setPinErr(e.message);
      else {
        setSigning(false);
        setErr(e instanceof ApiError ? e.message : 'Could not sign. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app" style={{ paddingBottom: 140 }}>
      <Header title="Review and sign" back={false}>
        <button className="link-btn" type="button" onClick={onBack}>
          Back
        </button>
      </Header>
      <div className="card">
        <span className="section-label" style={{ margin: 0 }}>
          Your words, {lang}
        </span>
        <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{original}</p>
      </div>
      <div className="banner info">
        <strong style={{ letterSpacing: '0.04em' }}>OFFICIAL ENGLISH RECORD</strong>
        {editing ? (
          <textarea value={english} onChange={(e) => setEnglish(e.target.value)} rows={6} style={{ width: '100%', marginTop: 8 }} aria-label="English record" />
        ) : (
          <span style={{ whiteSpace: 'pre-wrap', display: 'block' }}>{english}</span>
        )}
        {canListen && !editing && (
          <button
            className="link-btn"
            type="button"
            style={{ color: 'inherit', fontWeight: 700, marginTop: 6 }}
            onClick={() => {
              const u = new SpeechSynthesisUtterance(english);
              u.lang = 'en-NG';
              window.speechSynthesis.cancel();
              window.speechSynthesis.speak(u);
            }}
          >
            Listen to it read back
          </button>
        )}
      </div>
      <div className="banner warning" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ flex: 1 }}>
          <strong>Check the English is right</strong>
          AI can make mistakes with names, places and times{flagged.length ? `, like ${flagged.slice(0, 4).join(', ')}` : ''}. Nothing is sent until you sign.
        </span>
        <button
          className="link-btn"
          type="button"
          style={{ color: 'inherit', fontWeight: 800 }}
          onClick={async () => {
            if (editing) {
              await onSaveEnglish();
              setConfirm(false);
            }
            setEditing(!editing);
          }}
        >
          {editing ? 'Save' : 'Edit'}
        </button>
      </div>
      <div className="list">
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>I confirm this says what I meant</strong>
            <span className="sub">Signed with your PIN</span>
          </span>
          <button className="toggle" type="button" role="switch" aria-checked={confirm} aria-label="I confirm this says what I meant" disabled={editing} onClick={() => setConfirm((v) => !v)} />
        </div>
      </div>
      {err && (
        <div className="banner critical" role="alert">
          {err}
        </div>
      )}
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', maxWidth: 520, margin: '0 auto' }}>
        <button className="btn block primary" type="button" disabled={!confirm || editing} onClick={() => setSigning(true)} style={{ minHeight: 56 }}>
          Sign with PIN
        </button>
        <p className="muted center" style={{ margin: '8px 0 0', fontSize: 'var(--text-sm)' }}>
          After signing it is locked. Officers can read it but cannot change it.
        </p>
      </div>
      <Sheet open={signing} title="Sign your statement" onClose={() => setSigning(false)} busy={busy} footer={null}>
        <PinPad title="Your 4-digit PIN" error={pinErr} busy={busy} onDone={sign} />
        <p className="muted center" style={{ margin: 0 }}>
          No PIN yet? Set one in <Link href="/profile/security">Security</Link>.
        </p>
      </Sheet>
    </main>
  );
}

function Signed({ s, onAmend, onToast, toast, onDone, back }: { s: Statement; onAmend: () => void; onToast: (m: string) => void; toast: string | null; onDone: () => void; back: string }) {
  const v = s.versions[s.versions.length - 1]!;
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    try {
      setOffline(!!localStorage.getItem(OFFLINE_KEY(s.id)));
    } catch {
      /* private mode */
    }
  }, [s.id]);
  const toggleOffline = () => {
    try {
      if (offline) localStorage.removeItem(OFFLINE_KEY(s.id));
      else localStorage.setItem(OFFLINE_KEY(s.id), JSON.stringify({ number: s.number, report: s.report.label, ...v }));
      setOffline(!offline);
    } catch {
      onToast('This phone will not save it for offline.');
    }
  };
  const share = async () => {
    try {
      const r = await api<{ path: string; expiresInDays: number }>(`/me/statements/${s.id}/share`, { method: 'POST' });
      const url = `${window.location.origin}${r.path}`;
      if (navigator.share) await navigator.share({ title: `Statement ${s.number}`, url }).catch(() => {});
      else {
        await navigator.clipboard.writeText(url);
        onToast(`Link copied. It works for ${r.expiresInDays} days, view only.`);
      }
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : 'Could not make a link. Try again.');
    }
  };
  const signed = new Date(v.signedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <main className="app" style={{ paddingBottom: 110 }}>
      <Header title="Statement signed" back={back} />
      <div className="banner success">
        <strong>Sealed and sent to {s.station ?? 'the station'}</strong>
        Signed {signed}. Any later change is a new signed version, never an edit.
      </div>
      <div className="facts-list">
        <div>
          <span className="muted">Report</span>
          <strong>{s.report.label}</strong>
        </div>
        <div>
          <span className="muted">Languages</span>
          <strong>{v.language === 'en' ? 'English' : `${v.languageName} and English`}</strong>
        </div>
        <div>
          <span className="muted">Version</span>
          <strong>
            {v.version} of {s.versions.length}
          </strong>
        </div>
        <div>
          <span className="muted">Seal code</span>
          <strong style={{ fontFamily: 'ui-monospace, monospace' }}>{v.seal}</strong>
        </div>
      </div>
      <p className="section-label">Your copy</p>
      <div className="list">
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>Download PDF</strong>
            <span className="sub">English record and your original</span>
          </span>
          <button
            className="link-btn"
            type="button"
            style={{ color: 'var(--color-signal-text)', fontWeight: 800 }}
            onClick={() => downloadFile(`/me/statements/${s.id}/statement.pdf`, `${s.number}-v${v.version}.pdf`).catch((e) => onToast(e instanceof ApiError ? e.message : 'Could not download.'))}
          >
            Download
          </button>
        </div>
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>Save for offline</strong>
            <span className="sub">Opens without internet, with the seal code</span>
          </span>
          <button className="toggle" type="button" role="switch" aria-checked={offline} aria-label="Save for offline" onClick={toggleOffline} />
        </div>
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>Share copy</strong>
            <span className="sub">Lawyer or family, view only, 7 days</span>
          </span>
          <button className="link-btn" type="button" style={{ color: 'var(--color-signal-text)', fontWeight: 800 }} onClick={share}>
            Share
          </button>
        </div>
      </div>
      <div className="list">
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>Add more later</strong>
            <span className="sub">New information is added as another signed version</span>
          </span>
          <button className="link-btn" type="button" style={{ color: 'var(--color-signal-text)', fontWeight: 800 }} onClick={onAmend}>
            Add
          </button>
        </div>
      </div>
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', maxWidth: 520, margin: '0 auto' }}>
        <button className="btn block" type="button" onClick={onDone} style={{ minHeight: 56 }}>
          Done
        </button>
      </div>
      <Toast msg={toast} />
    </main>
  );
}
