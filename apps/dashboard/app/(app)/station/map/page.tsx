'use client';
// Board "Station map": your zone, units, open reports and the devices watching it.
import { api, ApiError } from '@erp/web-ui/api';
import { useEffect, useState } from 'react';
import { ZoneMap, type MapDevice, type MapIncident, type MapUnit } from '@/components/Dash';

interface MapData {
  center: { lat: number; lng: number };
  zoneRadiusM: number;
  stationPlaced: boolean;
  incidents: MapIncident[];
  units: (MapUnit & { line: string; badgeNo: string })[];
  devices: (MapDevice & { name: string | null; postcode: string | null; lastSeen: string | null })[];
}
const UNIT: Record<string, [string, string]> = {
  en_route: ['En route', 'var(--color-signal-text)'],
  accepted: ['Accepted', 'var(--color-signal-text)'],
  on_scene: ['On scene', 'var(--color-success-text)'],
  available: ['Available', 'var(--color-success-text)'],
  off: ['Off duty', 'var(--color-text-secondary)'],
};
type Layer = 'reports' | 'units' | 'cameras' | 'lights' | 'zone';

export default function StationMap() {
  const [m, setM] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [on, setOn] = useState<Record<Layer, boolean>>({ reports: true, units: true, cameras: true, lights: true, zone: true });
  useEffect(() => {
    const load = () =>
      api<MapData>('/me/station/map')
        .then(setM)
        .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the map.'));
    void load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  const alerts = m?.devices.filter((d) => d.status !== 'online') ?? [];
  const layers: [Layer, string, string][] = [
    ['reports', 'Reports', 'var(--color-emergency)'],
    ['units', 'Units', 'var(--color-signal)'],
    ['cameras', 'Cameras', 'var(--color-success)'],
    ['lights', 'Street lights', 'var(--color-warning)'],
    ['zone', 'My zone', 'var(--color-signal)'],
  ];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Map</h1>
          <p className="lede">Your zone, your units, open reports and the devices watching it.</p>
        </div>
      </div>
      {error && (
        <div className="banner critical" role="alert">
          {error}
        </div>
      )}
      <div className="chips" role="group" aria-label="Layers" style={{ marginBottom: 12 }}>
        {layers.map(([k, l, c]) => (
          <button key={k} type="button" aria-pressed={on[k]} onClick={() => setOn((x) => ({ ...x, [k]: !x[k] }))}>
            <span style={{ color: c }}>●</span> {l}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(300px, 1fr)', gap: 16, alignItems: 'start' }}>
        <section className="card" style={{ padding: 12 }}>
          {m ? (
            <ZoneMap
              center={m.center}
              radiusM={on.zone && m.stationPlaced ? m.zoneRadiusM : 1e9}
              showStation={m.stationPlaced}
              incidents={on.reports ? m.incidents : []}
              units={on.units ? m.units : []}
              devices={m.devices.filter((d) => (d.type === 'camera' ? on.cameras : on.lights))}
              height={560}
              link={(id) => `/incidents/${id}`}
            />
          ) : (
            <div className="skeleton" style={{ height: 560 }} />
          )}
          <div className="map-legend">
            <span>Square: this station</span>
            <span>Diamond: unit</span>
            <span>Large dot: open report</span>
            <span>Small dot: device (red = tamper)</span>
            <span>Dashed circle: your zone</span>
          </div>
        </section>
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Units</h2>
          {m?.units.length === 0 && <p className="muted">Nobody is on duty.</p>}
          {m?.units.map((u) => (
            <div className="row" key={u.id}>
              <div className="label">
                <strong>
                  {u.badgeNo}, {u.name}
                </strong>
                <span>{u.line}</span>
              </div>
              <strong style={{ color: UNIT[u.status]?.[1] }}>{UNIT[u.status]?.[0] ?? u.status}</strong>
            </div>
          ))}
          <h2>Device alerts in your zone</h2>
          {m && !alerts.length && <p className="muted">All cameras and street lights are working.</p>}
          {alerts.map((d) => (
            <div className="row" key={d.id}>
              <div className="label">
                <strong>
                  {d.type === 'camera' ? 'Camera' : 'Street light'}, {d.postcode ?? ''}
                </strong>
                <span>{d.status === 'tamper' ? 'Possibly damaged or moved' : d.status === 'offline' ? `No signal${d.lastSeen ? ` since ${new Date(d.lastSeen).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}` : d.status.replace('_', ' ')}</span>
              </div>
              <strong style={{ color: d.status === 'tamper' ? 'var(--color-emergency-text)' : 'var(--color-text-secondary)' }}>{d.status === 'tamper' ? 'Tamper' : d.status === 'offline' ? 'Offline' : d.status === 'low_power' ? 'Low power' : 'Repair'}</strong>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
