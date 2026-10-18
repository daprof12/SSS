'use client';

import { soundsUrgent } from '@erp/domain';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { api, ApiError, uid } from '@/lib/client';
import { AttachPicker, uploadPicked, usePicked } from './Attach';
import { WherePicker, whereBody, type Where } from './WherePicker';

interface Cat {
  code: string;
  label: string;
  agencyLabel: string;
  joined: boolean;
  bounty: { text: string } | null;
  emergencyHint: string | null;
  anonymousDefault: boolean;
}

/** Report a tip (board "Report a tip"; Rewards doc). Two steps: what and who, then details. */
export function TipFlow({ base, sosHref }: { base: string; sosHref: string }) {
  const router = useRouter();
  const [cats, setCats] = useState<Cat[] | null>(null);
  const [pick, setPick] = useState<Cat | null>(null);
  const [anonymous, setAnonymous] = useState(true);
  const [step, setStep] = useState<'pick' | 'details'>('pick');
  const [text, setText] = useState('');
  const [where, setWhere] = useState<Where | null>({ kind: 'none' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const clientRef = useRef(uid());
  const picked = usePicked();
  const [stage, setStage] = useState<'sending' | 'uploading' | null>(null);

  useEffect(() => {
    api<Cat[]>('/tips/categories').then(setCats).catch(() => setCats([]));
  }, []);

  const urgent = soundsUrgent(text);
  const send = async () => {
    const e: Record<string, string> = {};
    if (text.trim().length < 20) e.description = 'Add a little more so the agency can act.';
    setErrs(e);
    if (Object.keys(e).length) return requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
    setBusy(true);
    try {
      const r = await api<{ id: string }>('/tips', {
        method: 'POST',
        body: JSON.stringify({ category: pick!.code, description: text.trim(), anonymous, clientRef: clientRef.current, ...(where ? whereBody(where) : {}) }),
      });
      // The tip is in; files follow. A failed file never loses the tip.
      let failed = 0;
      if (picked.items.length) {
        setStage('uploading');
        failed = await uploadPicked('tip', r.id, picked);
      }
      router.replace(`${base}/${r.id}?sent=1${failed ? `&files=${failed}` : ''}`);
    } catch (x) {
      if (x instanceof ApiError && x.fields?.length) setErrs(Object.fromEntries(x.fields.map((f) => [f.field === 'postcode' ? 'where' : f.field, f.message])));
      else setErrs({ form: x instanceof ApiError ? x.message : 'Could not send. Try again.' });
      setBusy(false);
      setStage(null);
    }
  };

  if (step === 'details' && pick) {
    return (
      <main className="app bare">
        <Header title={pick.label} back={false}>
          <button className="link-btn" type="button" onClick={() => setStep('pick')}>
            Change
          </button>
        </Header>
        {errs.form && (
          <div className="banner critical" role="alert">
            {errs.form}
          </div>
        )}
        <label className="field" data-invalid={!!errs.description}>
          <span>What did you see?</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={1000}
            aria-invalid={!!errs.description}
            placeholder="Who, what, when, and where. Vehicle colour or plate if you saw one."
            style={{ minHeight: 140 }}
          />
          <span className="muted">{text.length < 20 ? `${20 - text.length} more characters needed` : `${1000 - text.length} characters left`}</span>
          {errs.description && <span className="field-error">{errs.description}</span>}
        </label>
        {urgent && (
          <div className="banner critical" role="alert">
            <strong>This sounds urgent</strong>
            Use SOS so help is sent now. <Link href={sosHref}>Open SOS</Link>
          </div>
        )}
        <WherePicker value={where} onChange={setWhere} optional error={errs.where} />
        <p className="section-label">Photos, video or a voice note (optional)</p>
        <AttachPicker picked={picked} disabled={busy} />
        <button className="btn block primary" type="button" onClick={send} disabled={busy}>
          {stage === 'uploading' ? 'Sending files…' : busy ? 'Sending…' : `Send to ${pick.agencyLabel}`}
        </button>
        <p className="muted center">{anonymous ? 'Your name is hidden from the agency.' : 'The agency will see your name.'}</p>
      </main>
    );
  }

  return (
    <main className="app bare">
      <Header title="Report a tip" />
      <p className="muted" style={{ marginTop: -8 }}>
        For crimes and hazards that are not an emergency. If someone is in danger, use <Link href={sosHref}>SOS</Link>.
      </p>
      {!cats && [0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 80 }} />)}
      <div className="tiles" style={{ gridTemplateColumns: '1fr 1fr' }} role="radiogroup" aria-label="What are you reporting?">
        {cats?.map((c) => (
          <button
            key={c.code}
            type="button"
            role="radio"
            aria-checked={pick?.code === c.code}
            aria-pressed={pick?.code === c.code}
            className="tile"
            style={{ placeItems: 'start', textAlign: 'left', minHeight: 84 }}
            onClick={() => {
              setPick(c);
              setAnonymous(c.anonymousDefault);
            }}
          >
            <span>{c.label}</span>
            <span className="muted" style={{ fontWeight: 400, fontSize: 'var(--text-xs)' }}>
              {c.code === 'other' ? 'We will route it' : c.agencyLabel}
            </span>
          </button>
        ))}
      </div>

      {pick && (
        <>
          <div className="list" style={{ marginTop: 12 }}>
            <div className="row" style={{ cursor: 'default' }}>
              <span className="grow sub">This goes to</span>
              <strong style={{ color: 'var(--color-signal-text)' }}>{pick.agencyLabel}</strong>
            </div>
            {!pick.joined && pick.code !== 'other' && (
              <div className="row" style={{ cursor: 'default' }}>
                <span className="grow sub">{pick.agencyLabel} has not joined yet. Our team holds your tip and passes it on.</span>
              </div>
            )}
            <div className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>Keep my name from the agency</strong>
                <span className="sub">Our team still verifies you, so a bounty can be paid.</span>
              </span>
              <button className="toggle" type="button" role="switch" aria-checked={anonymous} aria-label="Keep my name from the agency" onClick={() => setAnonymous((v) => !v)} />
            </div>
          </div>
          {pick.emergencyHint && (
            <div className="banner critical">
              <strong>{pick.emergencyHint}</strong>
              <Link href={sosHref}>Open SOS</Link>
            </div>
          )}
          <div className="banner warning" style={{ display: 'flex', gap: 12 }}>
            <Icon name="money" />
            <span>
              <strong>{pick.bounty ? `Bounty set by ${pick.agencyLabel}: ${pick.bounty.text}` : 'No bounty for this category'}</strong>
              {pick.bounty ? 'Paid to your wallet to the first person whose tip leads to a verified result. Fake tips lower your trust score.' : 'Tips here still help. Fake tips lower your trust score.'}
            </span>
          </div>
        </>
      )}
      <button className="btn block primary" type="button" disabled={!pick} onClick={() => setStep('details')} style={{ marginTop: 8 }}>
        {pick ? 'Continue' : 'Choose what you are reporting'}
      </button>
    </main>
  );
}
