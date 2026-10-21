'use client';

import Link from 'next/link';
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
interface Overview {
  home: {
    role: 'owner' | 'member';
    address: string;
    plan: { name: string; label: string; tone: string; paidUntil: string | null; late: boolean } | null;
    permissions: { viewLive: boolean; alerts: boolean; report: boolean };
  } | null;
  devices?: { id: string; status: string }[];
  alert?: { deviceId: string; title: string; line: string } | null;
  repairs?: { id: string; number: string; device: string; problem: string; step: string }[];
  incoming: { id: string; from: string; address: string; can: { viewLive: boolean; alerts: boolean; report: boolean } }[];
}
const STEP: Record<string, string> = { received: 'Reported', confirmed: 'Fault confirmed', booked: 'Visit booked', fixed: 'Fixed, confirm' };

/** Home, devices and household: the home building (REP-3), then the protected home (B4–B6). */
export default function HomePlace() {
  const [home, setHome] = useState<Place | null | undefined>(undefined);
  const [o, setO] = useState<Overview | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useToast();

  const load = () => {
    api<Place[]>('/me/places')
      .then((p) => setHome(p.find((x) => x.isHome) ?? null))
      .catch(() => setHome(null));
    api<Overview>('/me/home').then(setO).catch(() => setO({ home: null, incoming: [] }));
  };
  useEffect(() => {
    load();
  }, []);

  const save = async (b: PickedBuilding) => {
    setErr(null);
    setPicking(false);
    setBusy(true);
    try {
      const r = await api<{ address: string }>('/me/places/home', { method: 'PUT', body: JSON.stringify({ postcode: b.postcode }) });
      setToast(`Home set to ${r.address}.`);
      load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const answer = async (id: string, accept: boolean) => {
    try {
      const r = await api<{ message: string }>(`/me/home/invites/${id}/answer`, { method: 'POST', body: JSON.stringify({ accept }) });
      setToast(r.message);
      load();
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : 'Could not answer. Try again.');
    }
  };

  const offline = o?.devices?.filter((d) => d.status !== 'online').length ?? 0;
  return (
    <main className="app">
      <Header title="Home and places" back="/profile" />

      {o?.incoming.map((i) => (
        <div key={i.id} className="banner info" role="status">
          <strong>{i.from} invited you to their home</strong>
          {i.address}. You could {[i.can.viewLive && 'see live cameras', i.can.alerts && 'get alerts', i.can.report && 'report for the home'].filter(Boolean).join(', ') || 'be a member'}.
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn small" type="button" onClick={() => answer(i.id, false)}>
              Decline
            </button>
            <button className="btn small signal" type="button" onClick={() => answer(i.id, true)}>
              Join home
            </button>
          </div>
        </div>
      ))}

      <p className="section-label">Home building</p>
      {home === undefined && <div className="skeleton" />}
      {home && (
        <div className="location-line" style={{ marginBottom: 12 }}>
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
      <button className="btn block" type="button" onClick={() => setPicking(true)} disabled={busy}>
        <Icon name="pin" /> {busy ? 'Saving…' : home ? 'Change: where I am now' : 'Where I am now'}
      </button>
      <p className="muted" style={{ marginBottom: 0, fontSize: 'var(--text-sm)' }}>
        {home ? 'To change your home, stand' : 'Stand'} at home, then tap your building on the map. Its NIPOST postcode is saved for you.
      </p>
      {err && <span className="field-error">{err}</span>}

      <p className="section-label" style={{ marginTop: 20 }}>
        Home protection
      </p>
      {!o && <div className="skeleton" />}
      {o && !o.home && (
        <Link className="card" href="/profile/home/plan" style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none', color: 'inherit' }}>
          <span className="icon">
            <Icon name="shield" />
          </span>
          <span style={{ flex: 1, display: 'grid' }}>
            <strong>Protect your home</strong>
            <span className="muted">An outdoor camera and a street light, installed and maintained by our team.</span>
          </span>
          <Icon name="chevron" size={18} />
        </Link>
      )}
      {o?.home?.plan?.late && (
        <Link className="banner warning" href="/profile/home/billing" style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none' }}>
          <span style={{ flex: 1 }}>
            <strong>Payment problem</strong>
            We could not take your monthly payment. {o.home.plan.label}.
          </span>
          <strong>Pay</strong>
        </Link>
      )}
      {o?.home && (
        <>
          {o.alert && (
            <Link className="banner warning" href={`/profile/home/devices/${o.alert.deviceId}`} style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none' }}>
              <span style={{ flex: 1 }}>
                <strong>{o.alert.title}</strong>
                {o.alert.line}
              </span>
              <strong>Fix</strong>
            </Link>
          )}
          <div className="list">
            <Link className="row" href="/profile/home/devices">
              <span className="icon">
                <Icon name="camera" />
              </span>
              <span className="grow">
                <strong>My home devices</strong>
                <span className="sub">
                  {o.devices?.length ?? 0} devices{offline ? `, ${offline} need attention` : ', all working'}
                </span>
              </span>
              {o.home.plan && <span className={`chip ${o.home.plan.tone}`}>{o.home.plan.label}</span>}
              <Icon name="chevron" size={18} />
            </Link>
            <Link className="row" href="/profile/home/billing">
              <span className="icon">
                <Icon name="money" />
              </span>
              <span className="grow">
                <strong>Home plan and billing</strong>
                <span className="sub">{o.home.plan ? `${o.home.plan.name}${o.home.plan.paidUntil ? `, paid until ${new Date(o.home.plan.paidUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}` : 'Member of this home'}</span>
              </span>
              <Icon name="chevron" size={18} />
            </Link>
            <Link className="row" href="/profile/home/household">
              <span className="icon">
                <Icon name="contacts" />
              </span>
              <span className="grow">
                <strong>Household</strong>
                <span className="sub">{o.home.role === 'owner' ? 'Invite family and choose what they can do' : 'You are a member of this home'}</span>
              </span>
              <Icon name="chevron" size={18} />
            </Link>
          </div>
          {!!o.repairs?.length && (
            <>
              <p className="section-label">Repairs</p>
              <div className="list">
                {o.repairs.map((r) => (
                  <Link key={r.id} className="row" href={`/profile/home/repairs/${r.id}`}>
                    <span className="grow">
                      <strong>
                        {r.device}: {r.problem}
                      </strong>
                      <span className="sub">{r.number}</span>
                    </span>
                    <span className="chip info">{STEP[r.step] ?? r.step}</span>
                    <Icon name="chevron" size={18} />
                  </Link>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {picking && <BuildingPicker title="Pick your home" cta="Save" onClose={() => setPicking(false)} onPick={save} />}
      <Toast msg={toast} />
    </main>
  );
}
