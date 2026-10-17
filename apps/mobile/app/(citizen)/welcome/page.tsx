'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';
import { api, ApiError, getSession, locate, setSession } from '@/lib/client';

type Step = 'name' | 'tour' | 'permissions' | 'kyc' | 'home' | 'done';
interface Me {
  name: string;
  kyc: { status: string };
  onboarding: { steps: Record<string, string>; done: boolean; needsName: boolean };
}

// Feature tour (boards "Feature tour", "Tour 2–5 of 5"). Short, skippable, replayable later (AUTH-2).
const TOUR = [
  { icon: 'shield', title: 'Help in two taps', body: 'Tap SOS, pick what is happening, confirm. No typing. You have 5 seconds to cancel a mistake.' },
  { icon: 'pin', title: 'Your exact building', body: 'Your postcode finds the building, so the team comes to the right door.' },
  { icon: 'activity', title: 'Follow help live', body: 'See who accepted, where they are and when they arrive.' },
  { icon: 'check', title: 'Trusted responders', body: 'Every officer is verified with a badge, and you rate each response.' },
  { icon: 'home', title: 'Protect your home', body: 'Add a camera and street light, installed and looked after by our team.' },
];

/** Onboarding after first sign-in (App Flow: sign up → tour → KYC → home). Resumes where you left off. */
export default function Welcome() {
  const router = useRouter();
  const [step, setStep] = useState<Step | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  const mark = (s: string) => api('/me/onboarding', { method: 'PATCH', body: JSON.stringify({ step: s }) }).catch(() => {});

  useEffect(() => {
    void (async () => {
      const m = await api<Me>('/me');
      setMe(m);
      if (m.onboarding.done) return router.replace('/home');
      const homes = await api<Array<{ isHome: boolean }>>('/me/places').catch(() => []);
      const s = m.onboarding.steps;
      setStep(
        m.onboarding.needsName ? 'name' : !s.tour ? 'tour' : !s.permissions ? 'permissions' : m.kyc.status !== 'verified' && !s.kyc_skipped ? 'kyc' : !homes.some((h) => h.isHome) && !s.home ? 'home' : 'done',
      );
    })();
  }, [router]);

  const next = (from: Step) => {
    const order: Step[] = ['name', 'tour', 'permissions', 'kyc', 'home', 'done'];
    setStep(order[order.indexOf(from) + 1]!);
  };

  if (!step || !me) return <main className="app bare">{[0, 1].map((i) => <div key={i} className="skeleton" style={{ height: 120 }} />)}</main>;
  const idx = ['name', 'tour', 'permissions', 'kyc', 'home'].indexOf(step);

  return (
    <main className="app bare">
      {step !== 'done' && (
        <div className="steps-mini" aria-label={`Step ${idx + 1} of 5`}>
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} className={i <= idx ? 'on' : ''} />
          ))}
        </div>
      )}
      {step === 'name' && (
        <NameStep
          onDone={(name) => {
            const s = getSession();
            if (s) setSession({ ...s, name });
            next('name');
          }}
        />
      )}
      {step === 'tour' && <TourStep onDone={() => void mark('tour').then(() => next('tour'))} />}
      {step === 'permissions' && <PermissionsStep onDone={() => void mark('permissions').then(() => next('permissions'))} />}
      {step === 'kyc' && <KycStep name={me.name || getSession()?.name || ''} onDone={() => next('kyc')} onSkip={() => void mark('kyc_skipped').then(() => next('kyc'))} />}
      {step === 'home' && <HomeStep onDone={() => void mark('home').then(() => next('home'))} />}
      {step === 'done' && (
        <div className="center">
          <div className="check">
            <Icon name="check" size={44} />
          </div>
          <h1>You are ready</h1>
          <p className="muted">If something happens, tap SOS. We are two taps away.</p>
          <button
            className="btn block primary"
            type="button"
            onClick={async () => {
              await mark('done');
              router.replace('/home');
            }}
          >
            Go to Home
          </button>
        </div>
      )}
    </main>
  );
}

function NameStep({ onDone }: { onDone: (name: string) => void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (name.trim().length < 2) return setErr('Enter your name.');
        setBusy(true);
        try {
          await api('/me/profile', { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
          onDone(name.trim());
        } catch (x) {
          setErr(x instanceof ApiError ? x.message : 'Could not save. Try again.');
          setBusy(false);
        }
      }}
    >
      <h1 style={{ marginTop: 0 }}>What should we call you?</h1>
      <p className="muted">Use the name on your ID. Responders see "Verified citizen", not your name, unless you agree.</p>
      <label className="field" data-invalid={!!err}>
        <span>Full name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" aria-invalid={!!err} autoFocus />
        {err && <span className="field-error">{err}</span>}
      </label>
      <button className="btn block primary" type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Continue'}
      </button>
    </form>
  );
}

function TourStep({ onDone }: { onDone: () => void }) {
  const [i, setI] = useState(0);
  const card = TOUR[i]!;
  const start = useRef(0);
  return (
    <div
      onTouchStart={(e) => (start.current = e.touches[0]!.clientX)}
      onTouchEnd={(e) => {
        const dx = e.changedTouches[0]!.clientX - start.current;
        if (dx < -40 && i < TOUR.length - 1) setI(i + 1);
        if (dx > 40 && i > 0) setI(i - 1);
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="muted">
          {i + 1} of {TOUR.length}
        </span>
        <button className="link-btn" type="button" onClick={onDone}>
          Skip
        </button>
      </div>
      <div className="tour-art" key={i} aria-hidden>
        <Icon name={card.icon} size={96} />
      </div>
      <h1 style={{ margin: '0 0 8px' }} aria-live="polite">
        {card.title}
      </h1>
      <p className="muted" style={{ fontSize: 'var(--text-md)', minHeight: 72 }}>
        {card.body}
      </p>
      <div className="dots" aria-hidden>
        {TOUR.map((_, k) => (
          <i key={k} className={k === i ? 'on' : ''} />
        ))}
      </div>
      <button className="btn block primary" type="button" onClick={() => (i < TOUR.length - 1 ? setI(i + 1) : onDone())}>
        {i < TOUR.length - 1 ? 'Next' : 'Get started'}
      </button>
    </div>
  );
}

/** Asked at the moment needed, with one line of why (States doc "Permissions"). */
function PermissionsStep({ onDone }: { onDone: () => void }) {
  const [loc, setLoc] = useState<'idle' | 'on' | 'off'>('idle');
  const [notif, setNotif] = useState<'idle' | 'on' | 'off'>(typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'on' : 'idle');
  const row = (icon: string, title: string, why: string, state: string, ask: () => void) => (
    <div className="row" style={{ cursor: 'default' }}>
      <span className="icon">
        <Icon name={icon} />
      </span>
      <span className="grow">
        <strong>{title}</strong>
        <span className="sub">{state === 'off' ? 'Off. You can turn it on later in your phone settings.' : why}</span>
      </span>
      {state === 'on' ? (
        <span className="chip success">On</span>
      ) : (
        <button className="btn small" type="button" onClick={ask}>
          Allow
        </button>
      )}
    </div>
  );
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Two permissions</h1>
      <p className="muted">Both help the team find you faster. You can still report without them.</p>
      <div className="list">
        {row('pin', 'Location', 'So help finds you when you are away from home.', loc, async () => setLoc((await locate()) ? 'on' : 'off'))}
        {row('bell', 'Notifications', 'So you know the moment help is on the way.', notif, async () => {
          if (typeof Notification === 'undefined') return setNotif('off');
          setNotif((await Notification.requestPermission()) === 'granted' ? 'on' : 'off');
        })}
      </div>
      <button className="btn block primary" type="button" onClick={onDone}>
        Continue
      </button>
    </div>
  );
}

function KycStep({ name, onDone, onSkip }: { name: string; onDone: () => void; onSkip: () => void }) {
  const [phase, setPhase] = useState<'intro' | 'form' | 'selfie' | 'checking' | 'result'>('intro');
  const [first, ...rest] = name.split(' ');
  const [form, setForm] = useState({ idType: 'nin', idNumber: '', firstName: first ?? '', lastName: rest.join(' '), dateOfBirth: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ status: string; message?: string; triesLeft?: number } | null>(null);
  const [camera, setCamera] = useState<'idle' | 'live' | 'none'>('idle');
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);

  useEffect(() => () => stream.current?.getTracks().forEach((t) => t.stop()), []);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!/^\d{11}$/.test(form.idNumber)) e.idNumber = 'Check your ID number. It has 11 digits.';
    if (!form.firstName.trim()) e.firstName = 'Enter your first name as on your ID.';
    if (!form.lastName.trim()) e.lastName = 'Enter your last name as on your ID.';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.dateOfBirth)) e.dateOfBirth = 'Enter your date of birth.';
    setErrs(e);
    return !Object.keys(e).length;
  };

  const openCamera = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      stream.current = s;
      setCamera('live');
      requestAnimationFrame(() => {
        if (video.current) video.current.srcObject = s;
      });
    } catch {
      setCamera('none');
    }
  };

  const check = async () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    setPhase('checking');
    try {
      // Liveness itself runs in the KYC provider's SDK (TRD); the mock provider receives its result.
      const r = await api<{ status: string; message?: string; triesLeft?: number }>('/me/kyc', { method: 'POST', body: JSON.stringify({ ...form, liveness: true }) });
      setResult(r);
    } catch (x) {
      setResult({ status: 'failed', message: x instanceof ApiError ? x.message : 'Could not reach the check. Try again.' });
    }
    setPhase('result');
  };

  if (phase === 'intro')
    return (
      <div>
        <h1 style={{ marginTop: 0 }}>Verify your identity</h1>
        <p className="muted">Verified people are trusted by responders and can use the wallet. It takes about two minutes.</p>
        <div className="list">
          {[
            ['shield', 'Your NIN or BVN', 'We keep only a masked copy, never the full number'],
            ['user', 'A quick selfie', 'To check it is really you. Your face is not stored by us'],
          ].map(([i, t, d]) => (
            <div key={t} className="row" style={{ cursor: 'default' }}>
              <span className="icon">
                <Icon name={i!} />
              </span>
              <span className="grow">
                <strong>{t}</strong>
                <span className="sub">{d}</span>
              </span>
            </div>
          ))}
        </div>
        <button className="btn block primary" type="button" onClick={() => setPhase('form')}>
          Start
        </button>
        <button className="btn block" type="button" onClick={onSkip} style={{ marginTop: 8 }}>
          Not now
        </button>
        <p className="muted center">You can look around without verifying. Verify before you need the wallet.</p>
      </div>
    );

  if (phase === 'form')
    return (
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (validate()) setPhase('selfie');
          else requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
        }}
      >
        <h1 style={{ marginTop: 0 }}>Your ID</h1>
        <div className="segmented" role="group" aria-label="ID type" style={{ marginBottom: 16 }}>
          {(['nin', 'bvn'] as const).map((t) => (
            <button key={t} type="button" aria-pressed={form.idType === t} onClick={() => setForm({ ...form, idType: t })}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
        {(
          [
            ['idNumber', `${form.idType.toUpperCase()} number`, 'numeric', 'off'],
            ['firstName', 'First name', 'text', 'given-name'],
            ['lastName', 'Last name', 'text', 'family-name'],
          ] as const
        ).map(([k, l, mode, ac]) => (
          <label key={k} className="field" data-invalid={!!errs[k]}>
            <span>{l}</span>
            <input className="input" inputMode={mode} autoComplete={ac} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} aria-invalid={!!errs[k]} maxLength={k === 'idNumber' ? 11 : 60} />
            {errs[k] && <span className="field-error">{errs[k]}</span>}
          </label>
        ))}
        <label className="field" data-invalid={!!errs.dateOfBirth}>
          <span>Date of birth</span>
          <input className="input" type="date" value={form.dateOfBirth} onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })} aria-invalid={!!errs.dateOfBirth} max={new Date().toISOString().slice(0, 10)} />
          {errs.dateOfBirth && <span className="field-error">{errs.dateOfBirth}</span>}
        </label>
        <button className="btn block primary" type="submit">
          Continue
        </button>
      </form>
    );

  if (phase === 'selfie')
    return (
      <div>
        <h1 style={{ marginTop: 0 }}>Take a quick selfie</h1>
        <p className="muted">Find good light, remove glasses and hats, and look at the screen.</p>
        <div className="tour-art" style={{ overflow: 'hidden', borderRadius: '50%', width: 220, height: 220, margin: '16px auto' }}>
          {camera === 'live' ? <video ref={video} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }} /> : <Icon name="user" size={96} />}
        </div>
        {camera === 'none' && <div className="banner warning">The camera is not available here. On phones the check opens the provider's camera screen.</div>}
        {camera !== 'live' && camera !== 'none' && (
          <button className="btn block" type="button" onClick={openCamera} style={{ marginBottom: 8 }}>
            Open camera
          </button>
        )}
        <button className="btn block primary" type="button" onClick={check} disabled={camera === 'idle' && process.env.NODE_ENV === 'production'}>
          {camera === 'live' ? 'Check my selfie' : process.env.NODE_ENV === 'production' ? 'Check my selfie' : 'Run the check (test)'}
        </button>
      </div>
    );

  if (phase === 'checking')
    return (
      <div className="center" role="status">
        <div className="tour-art">
          <Icon name="shield" size={72} />
        </div>
        <h1>Checking your details</h1>
        <p className="muted">This usually takes a few seconds.</p>
      </div>
    );

  // result
  const ok = result?.status === 'verified';
  const review = result?.status === 'manual_review';
  return (
    <div className="center">
      <div className="check" style={ok ? undefined : { background: review ? 'var(--color-signal-soft)' : 'var(--color-warning-soft)', color: review ? 'var(--color-signal-text)' : 'var(--color-warning-text)' }}>
        <Icon name={ok ? 'check' : review ? 'history' : 'violence'} size={44} />
      </div>
      <h1>{ok ? 'You are verified' : review ? 'We are checking' : 'We could not verify you'}</h1>
      <p className="muted">{ok ? 'Responders now see you as a verified citizen.' : result?.message}</p>
      {ok || review ? (
        <button className="btn block primary" type="button" onClick={onDone}>
          Continue
        </button>
      ) : (
        <>
          {(result?.triesLeft ?? 1) > 0 && (
            <button className="btn block primary" type="button" onClick={() => setPhase('form')}>
              Try again
            </button>
          )}
          <button className="btn block" type="button" onClick={onSkip} style={{ marginTop: 8 }}>
            Not now
          </button>
        </>
      )}
    </div>
  );
}

function HomeStep({ onDone }: { onDone: () => void }) {
  const [postcode, setPostcode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const save = async (pc: string) => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ address: string; postcode: string }>('/me/places/home', { method: 'PUT', body: JSON.stringify({ postcode: pc }) });
      setSaved(`${r.address}, ${r.postcode}`);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const here = async () => {
    setErr(null);
    const p = await locate();
    if (!p) return setErr('Turn on location, or type your postcode.');
    try {
      const b = await api<{ postcode: string }>(`/places/nearest?lat=${p.lat}&lng=${p.lng}`);
      await save(b.postcode);
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : 'We could not find a building here. Type your postcode instead.');
    }
  };

  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Where do you live?</h1>
      <p className="muted">Your home building is used when you report from home, so help comes to the right door.</p>
      {saved ? (
        <div className="banner success">
          <strong>Home saved</strong>
          {saved}
        </div>
      ) : (
        <>
          <button className="btn block" type="button" onClick={here} disabled={busy} style={{ marginBottom: 12 }}>
            <Icon name="pin" /> I am at home now
          </button>
          <label className="field" data-invalid={!!err}>
            <span>Or type your postcode</span>
            <input className="input" value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="AB 12 C" autoCapitalize="characters" aria-invalid={!!err} />
            {err && <span className="field-error">{err}</span>}
          </label>
          <button className="btn block" type="button" disabled={busy || postcode.trim().length < 3} onClick={() => save(postcode)}>
            {busy ? 'Checking…' : 'Use this postcode'}
          </button>
        </>
      )}
      <button className="btn block primary" type="button" onClick={onDone} style={{ marginTop: 12 }}>
        {saved ? 'Continue' : 'Skip for now'}
      </button>
    </div>
  );
}
