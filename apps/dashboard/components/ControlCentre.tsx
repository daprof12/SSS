'use client';
// Control centre for an agency or station with smart devices switched on by a platform admin: see the
// devices at a report, launch and steer a drone, switch a siren or light, and watch feeds, including the
// body cams of the officers on the scene. Development devices are simulated.
import { api, ApiError } from '@erp/web-ui/api';
import { StreetMap } from '@erp/web-ui/StreetMap';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/components/Agency';

type Command = 'deploy' | 'recall' | 'goto_scene' | 'siren_on' | 'siren_off' | 'light_on' | 'light_off' | 'stream_start' | 'stream_stop';
interface Dev {
  id: string;
  type: string;
  label: string;
  name: string;
  status: string;
  state: string;
  battery: number | null;
  lat: number | null;
  lng: number | null;
  station: string | null;
  officer: string | null;
  docked: string | null;
  streaming: boolean;
  lit: boolean;
  streamUrl: string | null;
  distanceM?: number;
  can: Command[];
}
interface Overview {
  devices: Dev[];
  stats: { total: number; online: number; drones: number; deployed: number };
  incidents: { id: string; type: string; state: string; at: string; lat: number; lng: number; postcode: string | null; address: string | null }[];
  commands: { id: string; command: string; at: string; device: string; by: string }[];
}
interface Scene {
  incident: { id: string; type: string; lat: number; lng: number; postcode: string | null; address: string | null };
  nearby: Dev[];
  drones: Dev[];
  bodyCams: Dev[];
  radiusM: number;
  commands: { command: string; at: string; device: string; by: string }[];
}
const CMD_LABEL: Record<Command, string> = {
  deploy: 'Launch',
  recall: 'Recall',
  goto_scene: 'Send to report',
  siren_on: 'Siren on',
  siren_off: 'Siren off',
  light_on: 'Full light',
  light_off: 'Light normal',
  stream_start: 'Watch feed',
  stream_stop: 'Stop feed',
};
const STATE: Record<string, string> = { standby: 'Standing by', deployed: 'Deployed', returning: 'Returning', siren: 'Siren on' };
const when = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** A feed tile. A real stream URL plays; a simulated device shows a labelled placeholder. */
function Feed({ d }: { d: Dev }) {
  return (
    <div className="feed" role="img" aria-label={`Feed from ${d.name}`}>
      {d.streamUrl ? <video src={d.streamUrl} autoPlay muted playsInline controls /> : <span className="feed-note">{d.streaming ? 'Simulated live feed (development)' : 'Feed off'}</span>}
      {d.streaming && <span className="feed-live">LIVE</span>}
      <span className="feed-name">
        {d.officer ? `${d.officer}, ` : ''}
        {d.name}
      </span>
    </div>
  );
}

export function ControlCentre() {
  const [o, setO] = useState<Overview | null>(null);
  const [scene, setScene] = useState<Scene | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, say] = useToast();

  const load = useCallback(async () => {
    try {
      setO(await api<Overview>('/control'));
      if (pick) setScene(await api<Scene>(`/control/incidents/${pick}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the control centre.');
    }
  }, [pick]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!pick) return setScene(null);
    api<Scene>(`/control/incidents/${pick}`).then(setScene).catch(() => setScene(null));
  }, [pick]);

  const send = async (d: Dev, command: Command) => {
    setBusy(`${d.id}:${command}`);
    try {
      const r = await api<{ message: string }>(`/control/devices/${d.id}/commands`, { method: 'POST', body: JSON.stringify({ command, incidentId: command === 'goto_scene' ? pick : (pick ?? undefined) }) });
      say(r.message);
      await load();
    } catch (e) {
      say(e instanceof ApiError ? e.message : 'Could not send that.');
    } finally {
      setBusy(null);
    }
  };

  if (error && !o)
    return (
      <div className="banner warning" role="alert">
        <strong>Smart devices</strong> {error}
      </div>
    );
  if (!o) return <div className="skeleton" style={{ height: 240 }} />;

  const incident = scene?.incident ?? (o.incidents.find((i) => i.id === pick) as { lat: number; lng: number } | undefined);
  const first = o.devices.find((d) => d.lat != null && d.lng != null);
  const centre = incident ?? (first ? { lat: first.lat!, lng: first.lng! } : { lat: 6.5244, lng: 3.3792 });
  const actions = (d: Dev, only?: Command[]) =>
    d.can
      .filter((c) => (only ? only.includes(c) : !(['stream_stop', 'light_off', 'siren_off', 'goto_scene'] as Command[]).includes(c) || (c === 'goto_scene' && !!pick)))
      .map((c) => {
        const swapped: Command = c === 'siren_on' && d.state === 'siren' ? 'siren_off' : c === 'stream_start' && d.streaming ? 'stream_stop' : c === 'light_on' && d.lit ? 'light_off' : c;
        return (
          <button key={c} type="button" className={`btn ${swapped === 'goto_scene' ? 'primary' : ''}`} disabled={!!busy || d.status === 'offline'} onClick={() => void send(d, swapped)}>
            {busy === `${d.id}:${swapped}` ? 'Sending…' : CMD_LABEL[swapped]}
          </button>
        );
      });
  const Device = ({ d, only }: { d: Dev; only?: Command[] }) => (
    <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
      <div className="label" style={{ minWidth: 200 }}>
        <strong>{d.name}</strong>
        <span>
          {d.label} · {d.status === 'online' ? (STATE[d.state] ?? d.state) : d.status.replace('_', ' ')}
          {d.battery != null && ` · ${d.battery}%`}
          {d.distanceM != null && ` · ${d.distanceM} m away`}
          {d.docked && ` · ${d.docked} docked`}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{actions(d, only)}</div>
    </div>
  );

  return (
    <div className="grid">
      {toast}
      <div className="grid" style={{ marginBottom: 0, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        {[
          ['Devices', o.stats.total, 'Registered to you'],
          ['Online', o.stats.online, 'Reporting in'],
          ['Drones', o.stats.drones, `${o.stats.deployed} deployed`],
          ['Open reports', o.incidents.length, 'Pick one to see its scene'],
        ].map(([l, v, s]) => (
          <div className="stat" key={String(l)}>
            <span>{l}</span>
            <strong>{v}</strong>
            <small>{s}</small>
          </div>
        ))}
      </div>

      <div className="grid two">
        <section className="card" aria-labelledby="map-h">
          <h2 id="map-h" style={{ marginTop: 0 }}>
            Map
          </h2>
          <StreetMap
            incident={{ lat: centre.lat, lng: centre.lng, label: scene?.incident.address ?? 'Control centre', type: scene?.incident.type }}
            units={o.devices.filter((d) => d.lat != null).map((d) => ({ id: d.id, name: `${d.name} (${d.label})`, lat: d.lat, lng: d.lng }))}
            height={340}
            label="Smart devices and the selected report"
          />
          <p className="muted" style={{ marginBottom: 0 }}>
            Markers are your devices. Pick a report to centre on it.
          </p>
        </section>
        <section className="card" aria-labelledby="rep-h">
          <h2 id="rep-h" style={{ marginTop: 0 }}>
            Open reports
          </h2>
          {!o.incidents.length ? (
            <div className="empty">No open reports. Devices are standing by.</div>
          ) : (
            o.incidents.map((i) => (
              <button key={i.id} type="button" className="row" aria-pressed={pick === i.id} onClick={() => setPick(pick === i.id ? null : i.id)} style={{ width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', background: 'none', border: 0, cursor: 'pointer', outline: pick === i.id ? '2px solid var(--color-signal)' : undefined }}>
                <div className="label">
                  <strong>
                    {i.type[0]!.toUpperCase() + i.type.slice(1).replace('_', ' ')} · {i.postcode ?? 'no postcode'}
                  </strong>
                  <span>{i.address ?? 'Location on the map'}</span>
                </div>
                <span className="muted">{when(i.at)}</span>
              </button>
            ))
          )}
          {pick && (
            <Link href={`/incidents/${pick}`} className="link">
              Open the report
            </Link>
          )}
        </section>
      </div>

      {scene && (
        <section className="card" aria-labelledby="scene-h">
          <h2 id="scene-h" style={{ marginTop: 0 }}>
            At the scene · {scene.incident.postcode ?? 'report'}
          </h2>
          <div className="grid two">
            <div>
              <h3 style={{ marginTop: 0 }}>Devices within {scene.radiusM} m</h3>
              {!scene.nearby.length ? <div className="empty">No smart device covers this spot. Send a drone.</div> : scene.nearby.map((d) => <Device key={d.id} d={d} />)}
              <h3>Drones</h3>
              {scene.drones.map((d) => (
                <Device key={d.id} d={d} only={['goto_scene', 'recall', 'siren_on']} />
              ))}
            </div>
            <div>
              <h3 style={{ marginTop: 0 }}>Feeds</h3>
              <div className="feeds">
                {[...scene.bodyCams, ...scene.nearby.filter((d) => d.type === 'camera' || d.type === 'smart_pole'), ...scene.drones.filter((d) => d.state === 'deployed')].map((d) => (
                  <div key={d.id}>
                    <Feed d={d} />
                    {!d.streaming && d.can.includes('stream_start') && (
                      <button type="button" className="btn block" style={{ marginTop: 6 }} disabled={!!busy} onClick={() => void send(d, 'stream_start')}>
                        Watch feed
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {!scene.bodyCams.length && <p className="muted">No officer with a body cam has accepted this report yet.</p>}
            </div>
          </div>
        </section>
      )}

      <section className="card" aria-labelledby="all-h">
        <h2 id="all-h" style={{ marginTop: 0 }}>
          All devices
        </h2>
        {o.devices.map((d) => (
          <Device key={d.id} d={d} />
        ))}
      </section>
      {!!o.commands.length && (
        <section className="card" aria-labelledby="log-h">
          <h2 id="log-h" style={{ marginTop: 0 }}>
            Latest commands
          </h2>
          {o.commands.map((c) => (
            <div className="row" key={c.id}>
              <div className="label">
                <strong>
                  {CMD_LABEL[c.command as Command] ?? c.command}: {c.device}
                </strong>
                <span>{c.by}</span>
              </div>
              <span className="muted">{when(c.at)}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
