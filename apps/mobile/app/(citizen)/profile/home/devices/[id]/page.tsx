'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { LivePlayer } from '@/components/LivePlayer';
import { api, ApiError } from '@/lib/client';

interface Base {
  id: string;
  type: 'camera' | 'street_light';
  name: string;
  status: string;
  line: string;
  lastSeenText: string;
  openRepair: { id: string; number: string } | null;
  canReport: boolean;
  isOwner: boolean;
}
interface Camera extends Base {
  type: 'camera';
  canViewLive: boolean;
  livePaused: string | null;
  whoViewed: { name: string; role: string; reason: string; via: string; at: string }[];
  settings: { recordingDays: number; shareWithResponders: 'emergency_only' | 'never' };
  recordingDaysOptions: number[];
  viewers: number;
  lastMotion: string;
  clips: { id: number; kind: string; label: string; seconds: number; at: string }[];
  offlineSteps: string[];
}
interface Light extends Base {
  type: 'street_light';
  place: string;
  now: string;
  power: string;
  lowBattery: boolean;
  litHours: number | null;
  lastCheck: string;
  boost: { minutes: number; usedTonight: number; limit: number; until: string | null };
}
const STATUS: Record<string, [string, string]> = {
  online: ['Online', 'success'],
  offline: ['Offline', 'neutral'],
  low_power: ['Low power', 'warning'],
  needs_repair: ['Repair booked', 'warning'],
  tamper: ['Check needed', 'critical'],
};

/** Boards "Camera view", "Camera offline" and "Street light view". */
export default function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [d, setD] = useState<Camera | Light | null | undefined>(undefined);
  const [toast, setToast] = useToast();
  const load = () => api<Camera | Light>(`/me/devices/${id}`).then(setD).catch(() => setD(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (d === null) {
    return (
      <main className="app">
        <Header title="Device" back="/profile/home/devices" />
        <div className="empty">
          <strong>Device not found.</strong>
          <Link href="/profile/home/devices">Back to devices</Link>
        </div>
      </main>
    );
  }
  if (!d) return <main className="app">{<div className="skeleton" style={{ height: 260 }} />}</main>;
  const [label, tone] = STATUS[d.status] ?? [d.status, 'neutral'];
  return (
    <main className="app" style={{ paddingBottom: 110 }}>
      <Header title={d.name} back="/profile/home/devices">
        <span className={`chip ${tone}`}>{label}</span>
      </Header>
      {d.type === 'camera' ? <CameraView d={d} onToast={setToast} onChanged={load} /> : <LightView d={d} onToast={setToast} onChanged={load} />}
      <Toast msg={toast} />
    </main>
  );
}

function ReportLink({ d, primary, label }: { d: Base; primary?: boolean; label?: string }) {
  if (d.openRepair) {
    return (
      <Link className={`btn block ${primary ? 'primary' : ''}`} href={`/profile/home/repairs/${d.openRepair.id}`} style={{ minHeight: 56 }}>
        See repair {d.openRepair.number}
      </Link>
    );
  }
  if (!d.canReport) return null;
  return (
    <Link className={`btn block ${primary ? 'primary' : ''}`} href={`/profile/home/report?device=${d.id}`} style={{ minHeight: 56 }}>
      {label ?? 'Report a problem'}
    </Link>
  );
}

const Footer = ({ children }: { children: React.ReactNode }) => (
  <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, padding: '12px 16px calc(12px + env(safe-area-inset-bottom))', background: 'var(--color-bg)', maxWidth: 520, margin: '0 auto', display: 'grid', gap: 8 }}>{children}</div>
);

function CameraView({ d, onToast, onChanged }: { d: Camera; onToast: (m: string) => void; onChanged: () => void }) {
  const [tab, setTab] = useState<'live' | 'clips' | 'settings'>('live');
  const [busy, setBusy] = useState(false);
  const offline = d.status === 'offline';

  if (offline) {
    return (
      <>
        <div className="camera-frame">
          <Icon name="camera" size={40} />
          <strong>Camera is offline</strong>
          <span className="muted">{d.lastSeenText}</span>
        </div>
        <div className="banner warning">
          <strong>Try these first</strong>
          Takes about two minutes.
        </div>
        <ol className="try-steps">
          {d.offlineSteps.map((s, i) => (
            <li key={s}>
              <b>{i + 1}</b>
              {s}
            </li>
          ))}
        </ol>
        <Footer>
          <ReportLink d={d} primary label="It is still offline: report it" />
          <p className="muted center" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
            Repairs for faults covered by your plan are free.
          </p>
        </Footer>
      </>
    );
  }

  const saveClip = async () => {
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/me/devices/${d.id}/clips`, { method: 'POST' });
      onToast(r.message);
      onChanged();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const set = async (patch: Partial<Camera['settings']>) => {
    try {
      await api(`/me/devices/${d.id}/settings`, { method: 'PATCH', body: JSON.stringify(patch) });
      onToast('Saved.');
      onChanged();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : 'Could not save. Try again.');
    }
  };

  return (
    <>
      {d.canViewLive ? (
        <LivePlayer deviceId={d.id} name={d.name} onError={onToast} />
      ) : (
        <div className="camera-frame" aria-label="Live view">
          <Icon name="lock" size={36} />
          <strong>{d.livePaused ? 'Live view is paused' : 'Live view is off for you'}</strong>
          <span className="muted">{d.livePaused ?? 'Ask the home owner to let you see live cameras.'}</span>
          {d.livePaused && (
            <Link className="btn small" href="/profile/home/billing" style={{ marginTop: 8 }}>
              See what is due
            </Link>
          )}
        </div>
      )}
      <div className="segmented" role="tablist" style={{ display: 'flex', marginBottom: 12 }}>
        {(['live', 'clips', 'settings'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-pressed={tab === k} aria-selected={tab === k} onClick={() => setTab(k)} style={{ flex: 1, justifyContent: 'center' }}>
            {k === 'live' ? 'Live' : k === 'clips' ? 'Clips' : 'Settings'}
          </button>
        ))}
      </div>

      {tab === 'live' && (
        <>
          <div className="facts-list">
            <div>
              <span className="muted">Recording</span>
              <strong>On, {d.settings.recordingDays} days kept</strong>
            </div>
            <div>
              <span className="muted">Share with responders</span>
              <strong>{d.settings.shareWithResponders === 'emergency_only' ? 'During an emergency only' : 'Never'}</strong>
            </div>
            <div>
              <span className="muted">Who can view</span>
              <strong>
                {d.viewers} household {d.viewers === 1 ? 'member' : 'members'}
              </strong>
            </div>
            <div>
              <span className="muted">Last motion alert</span>
              <strong>{d.lastMotion}</strong>
            </div>
          </div>
          <div className="banner info">Responders see your camera only when you report an emergency at this address. Platform staff need a logged reason.</div>
        </>
      )}

      {tab === 'clips' &&
        (d.clips.length ? (
          <div className="list">
            {d.clips.map((c) => (
              <div key={c.id} className="row" style={{ cursor: 'default' }}>
                <span className="icon">
                  <Icon name="play" />
                </span>
                <span className="grow">
                  <strong>{c.label}</strong>
                  <span className="sub">
                    {new Date(c.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {c.seconds} s
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">
            <strong>No clips yet.</strong>
            Save a clip from Live, or motion alerts appear here.
          </div>
        ))}

      {tab === 'settings' && (
        <>
          <p className="section-label">Keep recordings for</p>
          <div className="chips" role="group" aria-label="Keep recordings for" style={{ marginBottom: 16 }}>
            {d.recordingDaysOptions.map((n) => (
              <button key={n} type="button" aria-pressed={d.settings.recordingDays === n} disabled={!d.isOwner} onClick={() => set({ recordingDays: n })}>
                {n} days
              </button>
            ))}
          </div>
          <div className="list">
            <div className="row" style={{ cursor: 'default' }}>
              <span className="grow">
                <strong>Share with responders in an emergency</strong>
                <span className="sub">Only when you report from this address</span>
              </span>
              <button
                className="toggle"
                type="button"
                role="switch"
                aria-checked={d.settings.shareWithResponders === 'emergency_only'}
                aria-label="Share with responders in an emergency"
                disabled={!d.isOwner}
                onClick={() => set({ shareWithResponders: d.settings.shareWithResponders === 'emergency_only' ? 'never' : 'emergency_only' })}
              />
            </div>
          </div>
          {!d.isOwner && <p className="muted">Only the home owner can change these.</p>}
          <p className="section-label">Who viewed this camera</p>
          {d.whoViewed.length ? (
            <div className="list">
              {d.whoViewed.map((w, i) => (
                <div key={i} className="row" style={{ cursor: 'default', minHeight: 52 }}>
                  <span className="grow">
                    <strong>{w.name}</strong>
                    <span className="sub">
                      {w.role === 'owner' ? 'You' : w.role === 'member' ? 'Household member' : w.role}, {w.reason}
                    </span>
                  </span>
                  <span className="sub">{new Date(w.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No one has watched it yet. Responders see it only during an emergency you report here; staff need a logged reason.</p>
          )}
        </>
      )}

      <Footer>
        <div className="btn-row">
          <button className="btn" type="button" onClick={saveClip} disabled={busy || !d.canViewLive} style={{ minHeight: 56 }}>
            {busy ? 'Saving…' : 'Save clip'}
          </button>
          {d.openRepair ? (
            <Link className="btn signal" href={`/profile/home/repairs/${d.openRepair.id}`} style={{ minHeight: 56 }}>
              See repair
            </Link>
          ) : d.canReport ? (
            <Link className="btn primary" href={`/profile/home/report?device=${d.id}`} style={{ minHeight: 56 }}>
              Report a problem
            </Link>
          ) : null}
        </div>
      </Footer>
    </>
  );
}

function LightView({ d, onToast, onChanged }: { d: Light; onToast: (m: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const off = d.status === 'offline';
  const boost = async () => {
    setBusy(true);
    try {
      const r = await api<{ message: string }>(`/me/devices/${d.id}/boost`, { method: 'POST' });
      onToast(r.message);
      onChanged();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : 'Could not turn it on. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const left = d.boost.limit - d.boost.usedTonight;
  return (
    <>
      <div className="light-map" data-off={off} role="img" aria-label={`${d.name}: ${d.now}`}>
        <span className="glow" />
        <span className="lamp" />
        <span className="place">{d.place}</span>
      </div>
      <div className="facts-list">
        <div>
          <span className="muted">Now</span>
          <strong>{d.now}</strong>
        </div>
        <div>
          <span className="muted">Power</span>
          <strong className={d.lowBattery ? 'warn' : undefined}>{d.power}</strong>
        </div>
        {d.litHours != null && (
          <div>
            <span className="muted">Lit up tonight</span>
            <strong>{d.litHours} hours</strong>
          </div>
        )}
        <div>
          <span className="muted">Last check</span>
          <strong>{d.lastCheck}</strong>
        </div>
      </div>
      {d.lowBattery && (
        <div className="banner warning">
          <strong>Battery is low</strong>
          It may go dark early. Report it so the team can check it.
        </div>
      )}
      {off && (
        <div className="banner warning">
          <strong>The light is not responding</strong>
          {d.lastSeenText}. Report it and we will check it.
        </div>
      )}
      {!off && (
        <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ flex: 1, display: 'grid' }}>
            <strong>Light up the street for 1 hour</strong>
            <span className="muted">
              {d.boost.until
                ? `On until ${new Date(d.boost.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}.`
                : `Use if you feel unsafe. Limited to ${d.boost.limit} times a night${left < d.boost.limit ? `, ${left} left` : ''}.`}
            </span>
          </span>
          <button className="link-btn" type="button" onClick={boost} disabled={busy || left <= 0} style={{ color: 'var(--color-warning-text)', fontWeight: 800 }}>
            {busy ? 'Turning on…' : d.boost.until ? 'Add an hour' : 'Turn on'}
          </button>
        </div>
      )}
      <Footer>
        <ReportLink d={d} primary />
      </Footer>
    </>
  );
}
