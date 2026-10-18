'use client';

import { useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { Icon } from '@/components/Icon';
import { BuildingPicker, formatPostcode, type PickedBuilding } from '@/components/reports/BuildingPicker';
import { api, ApiError } from '@/lib/client';

interface Place {
  isHome: boolean;
  postcode: string;
  address: string;
  area: string;
  verified: boolean;
}

/** Home building (REP-3): the postcode that reports use by default. */
export default function HomePlace() {
  const [home, setHome] = useState<Place | null | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useToast();

  const load = () =>
    api<Place[]>('/me/places')
      .then((p) => setHome(p.find((x) => x.isHome) ?? null))
      .catch(() => setHome(null));
  useEffect(() => {
    void load();
  }, []);

  const save = async (b: PickedBuilding) => {
    setErr(null);
    setPicking(false);
    setBusy(true);
    try {
      const r = await api<{ address: string }>('/me/places/home', { method: 'PUT', body: JSON.stringify({ postcode: b.postcode }) });
      setToast(`Home set to ${r.address}.`);
      void load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="app">
      <Header title="Home and places" back="/profile" />
      {home === undefined && <div className="skeleton" />}
      {home && (
        <div className="location-line" style={{ marginBottom: 16 }}>
          <span className="pin">
            <Icon name="home" />
          </span>
          <span style={{ flex: 1 }}>
            <strong>{home.address}</strong>
            <span>
              {formatPostcode(home.postcode)}, {home.area}
            </span>
          </span>
          <span className={`chip ${home.verified ? 'success' : 'warning'}`}>{home.verified ? 'Confirmed' : 'Not confirmed'}</span>
        </div>
      )}
      <button className="btn block signal" type="button" onClick={() => setPicking(true)} disabled={busy}>
        <Icon name="pin" /> {busy ? 'Saving…' : 'Where I am now'}
      </button>
      <p className="muted" style={{ marginBottom: 0 }}>
        {home ? 'To change your home, stand' : 'Stand'} at home, then tap your building on the map. Its NIPOST postcode is saved for you.
      </p>
      {err && <span className="field-error">{err}</span>}
      {picking && <BuildingPicker title="Pick your home" cta="Save" onClose={() => setPicking(false)} onPick={save} />}
      <p className="muted">A new home is confirmed by the address check before it counts as verified. Work and other places come next.</p>
      <Toast msg={toast} />
    </main>
  );
}
