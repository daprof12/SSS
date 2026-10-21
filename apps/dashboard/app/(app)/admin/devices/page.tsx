'use client';
// Board "Admin device wall" (+ "camera and street light modal"): every camera and light as a tile,
// households below. A live view needs a reason, logged with the staff member's name; the owner sees it.
import { api, ApiError } from '@erp/web-ui/api';
import { Sheet } from '@erp/web-ui/Sheet';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dateOnly, shortDate, useToast } from '@/components/Agency';
import { ago } from '@/components/Dash';
import { LocationFilter, locQuery, type LocFilter } from '@/components/LocationFilter';

interface Tile {
  id: string;
  type: 'camera' | 'street_light';
  status: string;
  statusLabel: string;
  name: string;
  serial: string;
  postcode: string | null;
  owner: string | null;
  householdId: string | null;
  batteryPct: number | null;
  lastSeen: string | null;
  litHours: number | null;
  boosted: boolean;
}
interface Household {
  id: string;
  owner: string;
  postcode: string;
  address: string;
  devices: number;
  problems: number;
  plan: string;
  state: string | null;
  stateLabel: string;
  nextVisit: string | null;
}
interface Wall {
  counts: Record<string, number>;
  tiles: Tile[];
  households: Household[];
}
interface HouseDevice {
  id: string;
  type: 'camera' | 'street_light' | 'gateway' | 'drone';
  name: string;
  serial: string;
  status: string;
  statusLabel: string;
  lastSeen: string | null;
  batteryPct: number | null;
  litHours: number | null;
  boosted: boolean;
  lastMotionAt: string | null;
  views30d: number;
  recordingDays: number;
}
interface House {
  id: string;
  owner: string;
  postcode: string;
  address: string;
  area: string;
  lga: string;
  subscription: string;
  devices: HouseDevice[];
}
type Live = { mode: 'stream'; url: string; expiresInSeconds: number } | { mode: 'test'; note: string; expiresInSeconds: number };

const TABS: [string, string][] = [
  ['all', 'All'],
  ['cameras', 'Cameras'],
  ['lights', 'Street lights'],
  ['offline', 'Offline'],
  ['low_power', 'Low power'],
  ['tamper', 'Tamper'],
];
const DOT: Record<string, string> = { online: 'var(--color-success)', low_power: 'var(--color-warning)', tamper: 'var(--color-emergency)', needs_repair: 'var(--color-warning)', offline: '#8a8f98' };
const TEXT: Record<string, string> = { online: 'var(--color-success-text)', low_power: 'var(--color-warning-text)', tamper: 'var(--color-emergency-text)', needs_repair: 'var(--color-warning-text)', offline: 'var(--color-text-secondary)' };
const SUB_TONE: Record<string, string> = { active: 'var(--color-success-text)', grace: 'var(--color-warning-text)', extras_paused: 'var(--color-warning-text)', sharing_paused: 'var(--color-warning-text)', install_booked: 'var(--color-info-text, var(--color-signal))' };
const REASONS = ['Repair visit check', 'Tamper check', 'Owner asked for help', 'Incident follow-up', 'Quality check'];

export default function DeviceWall() {
  const [loc, setLoc] = useState<LocFilter>({});
  const [tab, setTab] = useState('all');
  const [wall, setWall] = useState<Wall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [visit, setVisit] = useState<Household | null>(null);
  const [toast, setToast] = useToast();
  const lq = locQuery(loc);
  const load = useCallback(() => {
    api<Wall>(`/admin/device-wall?tab=${tab}${lq ? `&${lq}` : ''}`)
      .then((w) => {
        setWall(w);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load devices.'));
  }, [tab, lq]);
  useEffect(load, [load]);
  return (
    <>
      {toast}
      <div className="page-head">
        <div>
          <h1>Device wall</h1>
          <p className="lede">Cameras and street lights at a glance. Opening a live view needs a reason and is logged.</p>
        </div>
      </div>
      <div className="segmented tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} aria-pressed={tab === k} onClick={() => setTab(k)}>
            {l}
            {wall ? ` ${wall.counts[k] ?? ''}` : ''}
          </button>
        ))}
      </div>
      <LocationFilter value={loc} onChange={setLoc} />
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <section aria-label="Devices" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
        {!wall && [0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 180 }} />)}
        {wall?.tiles.length === 0 && <div className="empty">No devices match.</div>}
        {wall?.tiles.map((d) => (
          <button key={d.id} type="button" className="card" onClick={() => d.householdId && setOpen(d.householdId)} disabled={!d.householdId} style={{ margin: 0, textAlign: 'left', cursor: 'pointer', color: 'inherit' }}>
            <div style={{ height: 96, borderRadius: 10, background: d.type === 'camera' ? '#0b0d10' : 'radial-gradient(circle at 50% 55%, rgba(250,204,21,0.35), #0b0d10 60%)', display: 'grid', placeItems: 'center', marginBottom: 10 }}>
              <span aria-hidden style={{ fontSize: 28, opacity: 0.6 }}>
                {d.type === 'camera' ? '▣' : '◆'}
              </span>
            </div>
            <strong style={{ display: 'block' }}>
              {d.name} {d.serial.slice(-4)}
            </strong>
            <span className="muted" style={{ fontSize: 13 }}>
              {d.postcode ?? '—'} · {d.lastSeen ? `Seen ${ago(d.lastSeen)}` : 'Never seen'}
            </span>
            <div style={{ marginTop: 6, fontWeight: 600, color: TEXT[d.status] }}>
              <span style={{ color: DOT[d.status] }}>●</span> {d.statusLabel}
              {d.batteryPct != null && d.status === 'low_power' ? `, ${d.batteryPct}%` : ''}
            </div>
          </button>
        ))}
      </section>
      <section className="card" style={{ padding: 0, overflowX: 'auto' }} aria-labelledby="hh">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 16px 0' }}>
          <h2 id="hh" style={{ margin: 0 }}>
            Households
          </h2>
        </div>
        {!wall ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" />
          </div>
        ) : !wall.households.length ? (
          <div className="empty">No households here.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Household</th>
                <th>Postcode</th>
                <th>Devices</th>
                <th>Plan</th>
                <th>Next visit</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {wall.households.map((h) => (
                <tr key={h.id}>
                  <td>
                    <button type="button" className="link" onClick={() => setOpen(h.id)}>
                      <strong>{h.owner}</strong>
                    </button>
                    <div className="muted">{h.address}</div>
                  </td>
                  <td>{h.postcode}</td>
                  <td>
                    {h.devices}
                    {h.problems ? <span style={{ color: 'var(--color-warning-text)' }}> ({h.problems} need a look)</span> : ''}
                  </td>
                  <td>{h.plan}</td>
                  <td>{h.nextVisit ? shortDate(h.nextVisit) : '—'}</td>
                  <td>
                    <strong style={{ color: (h.state && SUB_TONE[h.state]) ?? 'var(--color-text-secondary)' }}>{h.stateLabel}</strong>
                  </td>
                  <td>
                    <button className="btn small" type="button" onClick={() => setVisit(h)}>
                      Schedule visit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {open && <HouseholdModal id={open} onClose={() => setOpen(null)} onDone={(m) => (setToast(m), load())} />}
      {visit && <VisitSheet h={visit} onClose={() => setVisit(null)} onDone={(m) => (setVisit(null), setToast(m), load())} />}
    </>
  );
}

function HouseholdModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (m: string) => void }) {
  const router = useRouter();
  const [h, setH] = useState<House | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    api<House>(`/admin/households/${id}`)
      .then(setH)
      .catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not load the household.'));
  }, [id]);
  useEffect(load, [load]);
  const camera = h?.devices.find((d) => d.type === 'camera');
  const light = h?.devices.find((d) => d.type === 'street_light');
  const repair = async (d: HouseDevice) => {
    try {
      onDone((await api<{ message: string }>(`/admin/devices/${d.id}/technician`, { method: 'POST', body: JSON.stringify({}) })).message);
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not open a ticket.');
    }
  };
  return (
    <Sheet
      open
      wide
      title={h ? `${h.owner}, ${h.postcode}` : 'Household'}
      description={h ? `${h.address}, ${h.area}, subscription ${h.subscription.toLowerCase()}` : undefined}
      onClose={onClose}
      footer={
        <>
          <span className="muted" style={{ marginRight: 'auto', fontSize: 13 }}>
            Every view and control action is saved in the audit log.
          </span>
          <button className="btn" type="button" onClick={() => router.push(`/admin/coverage?postcode=${h?.postcode ?? ''}`)}>
            Show on coverage map
          </button>
          {(camera ?? light) && (
            <button className="btn danger" type="button" onClick={() => repair((camera && camera.status !== 'online' ? camera : light && light.status !== 'online' ? light : camera ?? light)!)}>
              Open repair ticket
            </button>
          )}
        </>
      }
    >
      {err && (
        <div className="banner critical" role="alert" style={{ margin: 0 }}>
          {err}
        </div>
      )}
      {!h && !err && <div className="skeleton" style={{ height: 300 }} />}
      {h && (
        <div className="grid two" style={{ margin: 0 }}>
          {camera ? <CameraPanel d={camera} onDone={onDone} /> : <p className="muted">No camera at this home.</p>}
          {light ? <LightPanel d={light} onDone={(m) => (onDone(m), load())} /> : <p className="muted">No street light at this home.</p>}
        </div>
      )}
    </Sheet>
  );
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="facts" style={{ marginTop: 12 }}>
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Head({ d }: { d: HouseDevice }) {
  return (
    <h3 style={{ margin: '0 0 8px', display: 'flex', gap: 8, alignItems: 'center' }}>
      <span style={{ color: DOT[d.status] }}>●</span> {d.name} {d.serial.slice(-4)}
      <small style={{ color: TEXT[d.status], fontWeight: 600 }}>{d.statusLabel}</small>
    </h3>
  );
}

function CameraPanel({ d, onDone }: { d: HouseDevice; onDone: (m: string) => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (!reason) return setErr('A reason is required. It is logged with your name.');
    setBusy(true);
    setErr(null);
    try {
      setLive(await api<Live>(`/admin/devices/${d.id}/live`, { method: 'POST', body: JSON.stringify({ reason }) }));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not start the live view.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <Head d={d} />
      <div className="camera-frame" style={{ position: 'relative', aspectRatio: '16 / 10', borderRadius: 12, background: '#0b0d10', overflow: 'hidden', display: 'grid', placeItems: 'center', textAlign: 'center' }}>
        {live ? (
          live.mode === 'stream' ? (
            <video src={live.url} autoPlay muted playsInline controls style={{ width: '100%', height: '100%', objectFit: 'cover' }} aria-label={`Live view, ${d.name}`} />
          ) : (
            <TestFeed name={`${d.name} ${d.serial.slice(-4)}`} note={live.note} />
          )
        ) : (
          <div>
            <strong style={{ display: 'block' }}>Live view locked</strong>
            <span className="muted">Choose a reason to start</span>
          </div>
        )}
      </div>
      <label className="field" data-invalid={!!err} style={{ marginTop: 12 }}>
        <span>Reason for live view</span>
        <select value={reason} onChange={(e) => (setReason(e.target.value), setErr(null))}>
          <option value="">Choose a reason</option>
          {REASONS.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
      {err && (
        <span className="field-error" role="alert">
          {err}
        </span>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn primary" type="button" disabled={busy || d.status === 'offline'} onClick={live ? () => (setLive(null), onDone('Live view ended.')) : start}>
          {live ? 'Stop live view' : busy ? 'Connecting…' : 'Start live view'}
        </button>
      </div>
      <Facts
        rows={[
          ['Last seen', d.lastSeen ? ago(d.lastSeen) : 'Never'],
          ['Recording kept', `${d.recordingDays} days`],
          ['Last motion', d.lastMotionAt ? ago(d.lastMotionAt) : 'None yet'],
          ['Power', d.batteryPct != null ? `Battery ${d.batteryPct}%` : 'Mains'],
          ['Views in 30 days', d.views30d],
        ]}
      />
    </section>
  );
}

function LightPanel({ d, onDone }: { d: HouseDevice; onDone: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (action: 'on' | 'flash') => {
    setBusy(true);
    setErr(null);
    try {
      onDone((await api<{ message: string }>(`/admin/devices/${d.id}/light`, { method: 'POST', body: JSON.stringify({ action }) })).message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not reach the light.');
    } finally {
      setBusy(false);
    }
  };
  const pct = d.batteryPct ?? 100;
  return (
    <section>
      <Head d={d} />
      <div style={{ aspectRatio: '16 / 10', borderRadius: 12, background: 'repeating-linear-gradient(0deg, #12161b 0 39px, #1b2128 39px 40px), repeating-linear-gradient(90deg, #12161b 0 39px, #1b2128 39px 40px)', backgroundBlendMode: 'screen', position: 'relative', display: 'grid', placeItems: 'center' }}>
        <div style={{ width: 140, height: 140, borderRadius: '50%', background: `rgba(250, 204, 21, ${d.boosted ? 0.35 : 0.18})`, display: 'grid', placeItems: 'center' }}>
          <span style={{ width: 28, height: 28, background: 'var(--color-warning)', transform: 'rotate(45deg)', borderRadius: 4 }} />
        </div>
        <span className="chip neutral" style={{ position: 'absolute', left: 10, bottom: 10 }}>
          Lights about 30 m around
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
        <span>Brightness</span>
        <strong>{d.boosted ? 100 : 70}%</strong>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: 'var(--color-divider)', overflow: 'hidden' }}>
        <i style={{ display: 'block', height: '100%', width: `${d.boosted ? 100 : 70}%`, background: 'var(--color-warning)' }} />
      </div>
      {err && (
        <div className="banner critical" role="alert" style={{ margin: '8px 0 0' }}>
          {err}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn warning" type="button" disabled={busy || d.status === 'offline'} onClick={() => act('on')}>
          {d.boosted ? 'On for the hour' : 'Turn on now'}
        </button>
        <button className="btn" type="button" disabled={busy || d.status === 'offline'} onClick={() => act('flash')}>
          Flash test
        </button>
      </div>
      <Facts
        rows={[
          ['State', d.boosted ? 'On, turned on by staff' : 'On, dusk to dawn'],
          ['Power', <span key="p" style={{ color: pct < 25 ? 'var(--color-warning-text)' : undefined }}>Solar, battery {pct}%</span>],
          ['Last seen', d.lastSeen ? ago(d.lastSeen) : 'Never'],
          ['Lit last night', d.litHours != null ? `${d.litHours} hours` : '—'],
          ['Brightness change', 'Allowed during an incident'],
        ]}
      />
    </section>
  );
}

function VisitSheet({ h, onClose, onDone }: { h: Household; onClose: () => void; onDone: (m: string) => void }) {
  const tomorrow = dateOnly(new Date(Date.now() + 86_400_000));
  const [date, setDate] = useState(tomorrow);
  const [win, setWin] = useState<'morning' | 'afternoon'>('morning');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      onDone((await api<{ message: string }>(`/admin/households/${h.id}/visit`, { method: 'POST', body: JSON.stringify({ date, window: win, note: note.trim() || undefined }) })).message);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not book the visit.');
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      title="Schedule visit"
      description={`${h.owner}, ${h.postcode}. The owner is told the day and time window.`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={submit} disabled={busy}>
            Book visit
          </button>
        </>
      }
    >
      {err && (
        <div className="banner critical" role="alert" style={{ margin: 0 }}>
          {err}
        </div>
      )}
      <label className="field">
        <span>Day</span>
        <input type="date" min={tomorrow} value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <div className="segmented" role="group" aria-label="Time window">
        {(
          [
            ['morning', '9am to 12pm'],
            ['afternoon', '1pm to 5pm'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" aria-pressed={win === k} onClick={() => setWin(k)}>
            {l}
          </button>
        ))}
      </div>
      <label className="field">
        <span>Note for the technician (optional)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="For example, check the camera angle on the gate." />
      </label>
    </Sheet>
  );
}

/** A moving test pattern, so it is obvious this is not a real camera. */
function TestFeed({ name, note }: { name: string; note: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    let raf = 0;
    const bars = ['#c9c9c9', '#c9c900', '#00c9c9', '#00c900', '#c900c9', '#c90000', '#0000c9'];
    const draw = (t: number) => {
      const w = (c.width = c.clientWidth * devicePixelRatio);
      const hh = (c.height = c.clientHeight * devicePixelRatio);
      bars.forEach((col, i) => {
        ctx.fillStyle = col;
        ctx.fillRect((i * w) / bars.length, 0, w / bars.length + 1, hh * 0.7);
      });
      ctx.fillStyle = '#111';
      ctx.fillRect(0, hh * 0.7, w, hh * 0.3);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect((t / 20) % w, 0, 3 * devicePixelRatio, hh * 0.7);
      ctx.fillStyle = '#fff';
      ctx.font = `${13 * devicePixelRatio}px ui-monospace, monospace`;
      ctx.fillText(`TEST FEED · ${name}`, 10 * devicePixelRatio, hh * 0.82);
      ctx.fillText(new Date().toLocaleTimeString('en-GB'), 10 * devicePixelRatio, hh * 0.94);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [name]);
  return (
    <>
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} role="img" aria-label={`Test feed for ${name}`} />
      <span style={{ position: 'absolute', left: 8, right: 8, bottom: 6, fontSize: 11, color: '#fff', background: 'rgba(0,0,0,0.6)', padding: '3px 6px', borderRadius: 6 }}>{note}</span>
    </>
  );
}
