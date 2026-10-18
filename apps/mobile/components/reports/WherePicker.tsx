'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { api, locate } from '@/lib/client';
import { BuildingPicker, formatPostcode } from './BuildingPicker';

export type Where = { kind: 'none' } | { kind: 'home'; postcode: string; label: string } | { kind: 'here'; lat: number; lng: number; label: string } | { kind: 'postcode'; postcode: string; label: string };

export const whereBody = (w: Where) => (w.kind === 'here' ? { lat: w.lat, lng: w.lng } : w.kind === 'none' ? {} : { postcode: w.postcode });

/**
 * Location for non-emergency reports: GPS first (board "auto from GPS"), then the user picks
 * their building's NIPOST digital postcode on the map. Nobody types a postcode.
 */
export function WherePicker({ value, onChange, optional, error, autoLocate }: { value: Where | null; onChange: (w: Where) => void; optional?: boolean; error?: string; autoLocate?: boolean }) {
  const [home, setHome] = useState<{ postcode: string; address: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [spot, setSpot] = useState<{ lat: number; lng: number; accuracy?: number } | null>(null);

  useEffect(() => {
    api<Array<{ isHome: boolean; postcode: string; address: string }>>('/me/places')
      .then((p) => setHome(p.find((x) => x.isHome) ?? null))
      .catch(() => {});
  }, []);

  /** Quiet first guess: the building nearest the GPS fix. The user confirms or changes it on the map. */
  const guess = async () => {
    setBusy(true);
    setErr(null);
    const p = await locate();
    if (!p) {
      setBusy(false);
      return setErr('Turn on location, then pick your building on the map.');
    }
    setSpot(p);
    const b = await api<{ postcode: string; address: string }>(`/places/nearest?lat=${p.lat}&lng=${p.lng}`).catch(() => null);
    setBusy(false);
    onChange(b ? { kind: 'postcode', postcode: b.postcode, label: `${b.address}, ${formatPostcode(b.postcode)} (nearest to you)` } : { kind: 'here', lat: p.lat, lng: p.lng, label: 'Where you are now (GPS)' });
  };

  useEffect(() => {
    if (autoLocate && !value) void guess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLocate]);

  const shown = err ?? error;
  return (
    <div className="field" data-invalid={!!shown}>
      <span>Where{optional ? ' (optional)' : ''}</span>
      <button type="button" className="location-line" style={{ padding: '10px 14px', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer', border: 0 }} onClick={() => setPicking(true)}>
        <span className="pin" style={{ width: 40, height: 40 }}>
          <Icon name="pin" size={20} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ fontSize: 'var(--text-sm)', display: 'block' }}>{busy ? 'Finding the place…' : value && value.kind !== 'none' ? value.label : optional ? 'Not tied to a place' : 'Not set yet'}</strong>
          <span className="muted" style={{ fontSize: 'var(--text-xs, 12px)' }}>
            {value && value.kind !== 'none' ? 'Tap to change on the map' : 'Tap to pick your building on the map'}
          </span>
        </span>
        <Icon name="chevron" size={18} />
      </button>
      <div className="chips" style={{ marginTop: 4 }}>
        <button type="button" onClick={() => setPicking(true)} aria-pressed={value?.kind === 'postcode' || value?.kind === 'here'}>
          Pick on map
        </button>
        {home && (
          <button type="button" aria-pressed={value?.kind === 'home'} onClick={() => onChange({ kind: 'home', postcode: home.postcode, label: `Home, ${home.address}` })}>
            Home
          </button>
        )}
        {optional && (
          <button type="button" aria-pressed={!value || value.kind === 'none'} onClick={() => onChange({ kind: 'none' })}>
            No place
          </button>
        )}
      </div>
      {shown && <span className="field-error">{shown}</span>}
      {picking && (
        <BuildingPicker
          start={spot}
          onClose={() => setPicking(false)}
          onPick={(b) => {
            setErr(null);
            onChange({ kind: 'postcode', postcode: b.postcode, label: `${b.address}, ${formatPostcode(b.postcode)}` });
            setPicking(false);
          }}
          onSpot={(p) => {
            setErr(null);
            onChange({ kind: 'here', lat: p.lat, lng: p.lng, label: 'The spot you picked on the map' });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}
