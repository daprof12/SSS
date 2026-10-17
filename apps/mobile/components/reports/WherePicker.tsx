'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { api, ApiError, locate } from '@/lib/client';

export type Where = { kind: 'none' } | { kind: 'home'; postcode: string; label: string } | { kind: 'here'; lat: number; lng: number; label: string } | { kind: 'postcode'; postcode: string; label: string };

export const whereBody = (w: Where) => (w.kind === 'here' ? { lat: w.lat, lng: w.lng } : w.kind === 'none' ? {} : { postcode: w.postcode });

/** Location for non-emergency reports: GPS first (board "auto from GPS"), home, or a typed postcode. */
export function WherePicker({ value, onChange, optional, error, autoLocate }: { value: Where | null; onChange: (w: Where) => void; optional?: boolean; error?: string; autoLocate?: boolean }) {
  const [home, setHome] = useState<{ postcode: string; address: string } | null>(null);
  const [postcode, setPostcode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Array<{ isHome: boolean; postcode: string; address: string }>>('/me/places')
      .then((p) => setHome(p.find((x) => x.isHome) ?? null))
      .catch(() => {});
  }, []);

  const here = async () => {
    setBusy(true);
    setErr(null);
    const p = await locate();
    if (!p) {
      setBusy(false);
      return setErr('Turn on location, or type a postcode.');
    }
    const b = await api<{ postcode: string; address: string }>(`/places/nearest?lat=${p.lat}&lng=${p.lng}`).catch(() => null);
    setBusy(false);
    onChange({ kind: 'here', ...p, label: b ? `${b.address}, ${b.postcode} (where you are)` : 'Where you are now (GPS)' });
  };

  useEffect(() => {
    if (autoLocate && !value) void here();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLocate]);

  const typed = async () => {
    setErr(null);
    setBusy(true);
    try {
      const b = await api<{ postcode: string; address: string }>(`/places/lookup?postcode=${encodeURIComponent(postcode)}`);
      onChange({ kind: 'postcode', postcode: b.postcode, label: `${b.address}, ${b.postcode}` });
      setPostcode('');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Check the postcode.');
    } finally {
      setBusy(false);
    }
  };

  const shown = err ?? error;
  return (
    <div className="field" data-invalid={!!shown}>
      <span>Where{optional ? ' (optional)' : ''}</span>
      <div className="location-line" style={{ padding: '10px 14px' }}>
        <span className="pin" style={{ width: 40, height: 40 }}>
          <Icon name="pin" size={20} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ fontSize: 'var(--text-sm)' }}>{busy ? 'Finding the place…' : value && value.kind !== 'none' ? value.label : optional ? 'Not tied to a place' : 'Not set yet'}</strong>
        </span>
      </div>
      <div className="chips" style={{ marginTop: 4 }}>
        <button type="button" onClick={here} disabled={busy} aria-pressed={value?.kind === 'here'}>
          Where I am
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
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <input className="input" value={postcode} onChange={(e) => setPostcode(e.target.value)} placeholder="Or type a postcode" aria-label="Postcode" autoCapitalize="characters" style={{ minHeight: 48 }} />
        <button className="btn small" type="button" onClick={typed} disabled={busy || postcode.trim().length < 3}>
          Use
        </button>
      </div>
      {shown && <span className="field-error">{shown}</span>}
    </div>
  );
}
