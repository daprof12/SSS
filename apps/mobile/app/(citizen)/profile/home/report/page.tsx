'use client';

import { DEVICE_PROBLEMS } from '@erp/domain';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Header } from '@/components/AppFrame';
import { AttachPicker, uploadPicked, usePicked } from '@/components/reports/Attach';
import { api, ApiError } from '@/lib/client';

interface Device {
  id: string;
  type: 'camera' | 'street_light';
  name: string;
  status: string;
}
const TIMES = ['Weekday mornings', 'Weekday afternoons', 'Evenings', 'Weekends', 'Any time'];

/** Board "Report a device problem": which device, what is wrong, a few words, photo and best time. */
export default function ReportProblemPage() {
  return (
    <Suspense>
      <ReportProblem />
    </Suspense>
  );
}

function ReportProblem() {
  const router = useRouter();
  const pre = useSearchParams().get('device');
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [deviceId, setDeviceId] = useState<string>('');
  const [problem, setProblem] = useState('');
  const [text, setText] = useState('');
  const [time, setTime] = useState('');
  const [photo, setPhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const picked = usePicked();

  useEffect(() => {
    api<{ devices?: Device[] }>('/me/home')
      .then((o) => {
        const list = o.devices ?? [];
        setDevices(list);
        const first = list.find((d) => d.id === pre) ?? list.find((d) => d.status !== 'online') ?? list[0];
        if (first) {
          setDeviceId(first.id);
          if (first.status === 'offline') setProblem('offline');
        }
      })
      .catch(() => setDevices([]));
  }, [pre]);

  const device = devices?.find((d) => d.id === deviceId);
  const problems = DEVICE_PROBLEMS.filter((p) => !device || (p.for as readonly string[]).includes(device.type));
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const ready = !!deviceId && !!problem && words >= 3;

  const send = async () => {
    const e: Record<string, string> = {};
    if (!problem) e.problem = 'Choose what is wrong.';
    if (words < 3) e.description = 'Add at least a few words so the team knows what to bring.';
    setErrs(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await api<{ id: string }>('/me/repairs', { method: 'POST', body: JSON.stringify({ deviceId, problem, description: text.trim(), bestTime: time || undefined }) });
      if (picked.items.length) await uploadPicked('repair', r.id, picked);
      router.replace(`/profile/home/repairs/${r.id}?new=1`);
    } catch (err) {
      setErrs({ form: err instanceof ApiError ? (err.fields?.[0]?.message ?? err.message) : 'Could not send. Try again.' });
      setBusy(false);
    }
  };

  return (
    <main className="app" style={{ paddingBottom: 110 }}>
      <Header title="Report a problem" back={pre ? `/profile/home/devices/${pre}` : '/profile/home/devices'} />
      <p className="muted" style={{ marginTop: -8 }}>
        Which device and what is wrong? Faults covered by your plan are repaired free.
      </p>
      <label className="field">
        <span>Device</span>
        <select value={deviceId} onChange={(e) => (setDeviceId(e.target.value), setProblem(''))} disabled={!devices}>
          {devices?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <div className="chips" role="radiogroup" aria-label="What is wrong" style={{ marginBottom: errs.problem ? 4 : 16 }}>
        {problems.map((p) => (
          <button key={p.code} type="button" role="radio" aria-checked={problem === p.code} aria-pressed={problem === p.code} onClick={() => (setProblem(p.code), setErrs((x) => ({ ...x, problem: '' })))}>
            {p.label}
          </button>
        ))}
      </div>
      {errs.problem && <span className="field-error">{errs.problem}</span>}
      <label className="field" data-invalid={!!errs.description} style={{ marginBottom: errs.description ? 4 : 16 }}>
        <span>Tell us more</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} aria-invalid={!!errs.description} placeholder="What you see, since when, anything you tried." />
      </label>
      {errs.description && (
        <span className="field-error" role="alert">
          {errs.description}
        </span>
      )}
      <div className="btn-row" style={{ margin: '12px 0' }}>
        <button className="btn" type="button" onClick={() => setPhoto((v) => !v)} aria-expanded={photo}>
          {picked.items.length ? `${picked.items.length} photo${picked.items.length === 1 ? '' : 's'}` : 'Add photo'}
        </button>
        <select className="btn" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Best time to visit" style={{ appearance: 'none', textAlign: 'center' }}>
          <option value="">Best time to visit</option>
          {TIMES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      {photo && <AttachPicker picked={picked} disabled={busy} />}
      {problem === 'damaged' ? (
        <div className="banner critical" role="alert">
          <strong>Damaged or tampered?</strong>
          We treat it as urgent and tell your local station. If someone is there now, report an emergency instead.
        </div>
      ) : (
        <div className="banner critical">
          <strong>Damaged or tampered?</strong>
          If someone broke it or moved it, tell us now. We treat it as urgent and may alert your station.
        </div>
      )}
      {errs.form && (
        <div className="banner critical" role="alert">
          {errs.form}
        </div>
      )}
      <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', maxWidth: 520, margin: '0 auto' }}>
        <button className={`btn block ${ready ? 'primary' : ''}`} type="button" onClick={send} disabled={busy || !devices?.length} style={{ minHeight: 56 }}>
          {busy ? 'Sending…' : 'Send report'}
        </button>
      </div>
    </main>
  );
}
