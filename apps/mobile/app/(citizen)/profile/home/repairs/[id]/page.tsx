'use client';

import { Sheet } from '@erp/web-ui/Sheet';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, use, useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { MessageSheet } from '@/components/MessageSheet';
import { Attachments } from '@/components/reports/Attach';
import { api, ApiError } from '@/lib/client';

interface Repair {
  id: string;
  number: string;
  step: 'received' | 'confirmed' | 'booked' | 'fixed' | 'closed';
  chip: string;
  steps: { key: string; title: string; line: string; at: string | null; state: 'done' | 'current' | 'next' }[];
  device: string;
  problem: string;
  description: string;
  bestTime: string | null;
  visit: string | null;
  technician: string | null;
  cost: string;
  covered: boolean;
  urgent: boolean;
  canChangeTime: boolean;
  canConfirm: boolean;
}
const TIMES = ['Weekday mornings', 'Weekday afternoons', 'Evenings', 'Weekends', 'Any time'];
const day = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** Board "Repair status": Report received → Fault confirmed → Visit booked → Fixed (you confirm). */
export default function RepairPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense>
      <RepairView params={params} />
    </Suspense>
  );
}

function RepairView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const fresh = useSearchParams().get('new') === '1';
  const [r, setR] = useState<Repair | null | undefined>(undefined);
  const [sheet, setSheet] = useState<'time' | 'message' | null>(null);
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useToast();
  const load = () => api<Repair>(`/me/repairs/${id}`).then(setR).catch(() => setR(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const act = async (path: string, body: object) => {
    setBusy(true);
    try {
      const x = await api<{ message: string }>(`/me/repairs/${id}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      setToast(x.message);
      setSheet(null);
      void load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (r === null) {
    return (
      <main className="app">
        <Header title="Repair" back="/profile/home" />
        <div className="empty">
          <strong>Repair not found.</strong>
          <Link href="/profile/home">Back to home</Link>
        </div>
      </main>
    );
  }
  if (!r) return <main className="app">{<div className="skeleton" style={{ height: 260 }} />}</main>;

  return (
    <main className="app" style={{ paddingBottom: 150 }}>
      <Header title={`Repair ${r.number}`} back="/profile/home">
        <span className={`chip ${r.step === 'closed' ? 'success' : r.step === 'fixed' ? 'warning' : 'info'}`}>{r.chip}</span>
      </Header>
      {fresh && r.step === 'received' && (
        <div className={`banner ${r.urgent ? 'critical' : 'success'}`} role="status">
          <strong>{r.urgent ? 'Reported as urgent' : 'Reported'}</strong>
          {r.urgent ? 'We have told your local station and will check the device first.' : 'We will check the device remotely and book a visit if needed.'}
        </div>
      )}
      <ol className="progress-steps">
        {r.steps.map((s) => (
          <li key={s.key} data-state={s.state}>
            <i aria-hidden />
            <span>
              <strong>{s.title}</strong>
              <small>{s.line}</small>
            </span>
            <time>{s.at && s.state !== 'next' ? day(s.at) : ''}</time>
          </li>
        ))}
      </ol>
      <div className="facts-list">
        <div>
          <span className="muted">Device</span>
          <strong>{r.device}</strong>
        </div>
        <div>
          <span className="muted">Problem</span>
          <strong>{r.problem}</strong>
        </div>
        <div>
          <span className="muted">Visit</span>
          <strong className={r.visit ? 'sig' : undefined}>{r.visit ?? (r.bestTime ? `You asked: ${r.bestTime}` : 'Not booked yet')}</strong>
        </div>
        <div>
          <span className="muted">Technician</span>
          <strong>{r.technician ?? 'Not assigned yet'}</strong>
        </div>
        <div>
          <span className="muted">Cost</span>
          <strong className={r.covered ? 'ok' : 'warn'}>{r.cost}</strong>
        </div>
      </div>
      <Attachments ownerType="repair" ownerId={r.id} title="Your photos" />

      {r.canConfirm && (
        <div className="card">
          <strong>Is it working now?</strong>
          <p className="muted" style={{ margin: '4px 0 12px' }}>
            The technician marked it fixed. Tell us if it works.
          </p>
          <div className="btn-row">
            <button className="btn" type="button" disabled={busy} onClick={() => act('confirm', { fixed: false })}>
              Still not working
            </button>
            <button className="btn signal" type="button" disabled={busy} onClick={() => act('confirm', { fixed: true })}>
              Yes, it works
            </button>
          </div>
        </div>
      )}

      {r.step !== 'closed' && (
        <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', maxWidth: 520, margin: '0 auto', display: 'grid', gap: 8 }}>
          <div className="btn-row">
            <button className="btn" type="button" disabled={!r.canChangeTime} onClick={() => (setTime(r.bestTime ?? ''), setSheet('time'))} style={{ minHeight: 56 }}>
              Change time
            </button>
            <button className="btn" type="button" onClick={() => setSheet('message')} style={{ minHeight: 56 }}>
              Message team
            </button>
          </div>
          <p className="muted center" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            The technician shows a badge and a code. Never let anyone in without both.
          </p>
        </div>
      )}

      <Sheet
        open={sheet === 'time'}
        title="When is best for a visit?"
        description={r.visit ? 'Your booked visit is cancelled and the team books the new time.' : undefined}
        onClose={() => setSheet(null)}
        busy={busy}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setSheet(null)} disabled={busy}>
              Cancel
            </button>
            <button className="btn primary" type="button" disabled={busy || !time} onClick={() => act('time', { bestTime: time })}>
              {busy ? 'Saving…' : 'Ask for this time'}
            </button>
          </>
        }
      >
        <div className="chips" role="radiogroup" aria-label="Best time">
          {TIMES.map((t) => (
            <button key={t} type="button" role="radio" aria-checked={time === t} aria-pressed={time === t} onClick={() => setTime(t)}>
              {t}
            </button>
          ))}
        </div>
      </Sheet>
      {sheet === 'message' && (
        <MessageSheet
          topic="device"
          relatedId={r.id}
          title={`Message about ${r.number}`}
          onClose={() => setSheet(null)}
          onSent={(m) => {
            setSheet(null);
            setToast(m);
          }}
        />
      )}
      <Toast msg={toast} />
    </main>
  );
}
