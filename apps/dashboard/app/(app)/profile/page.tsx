'use client';

import { useEffect, useState } from 'react';
import { ThemeSwitch } from '@erp/web-ui/ThemeSwitch';
import { api, ApiError } from '@erp/web-ui/api';
import { applyMotion, applyTheme, onThemeChange, type ThemeChoice } from '@erp/web-ui/theme';

interface Me {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  roles: Array<{ role: string; scopeType: string; scopeId: string | null }>;
  preferences: { theme: ThemeChoice; locale: string; reduceMotion: boolean; discreetMode: boolean };
  security: { mfaEnabled: boolean; mfaRequired: boolean; hasPin: boolean };
}

const ROLE_LABEL: Record<string, string> = {
  head: 'Station head',
  dispatcher: 'Dispatcher',
  agency_admin: 'Agency admin',
  agency_finance: 'Agency finance',
  platform_admin: 'Platform admin',
  officer: 'Officer',
  technician: 'Technician',
  citizen: 'Citizen',
};
const LANGS = { en: 'English', ha: 'Hausa', yo: 'Yoruba', ig: 'Igbo', pcm: 'Pidgin' } as const;

/** My profile — shared by station, agency and platform staff (UX Gap Analysis §2.3). */
export default function Profile() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = () =>
    api<Me>('/me')
      .then((m) => {
        setMe(m);
        setError(null);
      })
      .catch((e: ApiError) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  // The top bar can change the theme too; mirror it here.
  useEffect(() => onThemeChange((t) => setMe((m) => (m && m.preferences.theme !== t ? { ...m, preferences: { ...m.preferences, theme: t } } : m))), []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const save = async (patch: Partial<Me['preferences']>, message: string) => {
    if (!me) return;
    const before = me;
    setMe({ ...me, preferences: { ...me.preferences, ...patch } }); // optimistic
    if (patch.theme) applyTheme(patch.theme);
    if (patch.reduceMotion !== undefined) applyMotion(patch.reduceMotion);
    try {
      await api('/me/preferences', { method: 'PATCH', body: JSON.stringify(patch) });
      setToast(message);
    } catch (e) {
      setMe(before);
      if (patch.theme) applyTheme(before.preferences.theme);
      if (patch.reduceMotion !== undefined) applyMotion(before.preferences.reduceMotion);
      setToast(e instanceof ApiError ? e.message : 'Could not save. Try again.');
    }
  };

  if (error)
    return (
      <div className="banner critical" role="alert">
        <strong>Could not load your profile</strong>
        {error}{' '}
        <button className="btn" type="button" onClick={load}>
          Retry
        </button>
      </div>
    );
  if (!me)
    return (
      <>
        <h1>My profile</h1>
        <p className="lede">Loading…</p>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton" />
        ))}
      </>
    );

  const p = me.preferences;
  return (
    <>
      <h1>My profile</h1>
      <p className="lede">Your account, sign-in security and how the dashboard looks for you.</p>

      {me.security.mfaRequired && !me.security.mfaEnabled && (
        <div className="banner warning" role="status">
          <strong>Turn on two-step login</strong>
          Required for station, agency and platform staff.
        </div>
      )}

      <div className="grid two">
        <section className="card" aria-labelledby="personal">
          <h2 id="personal">Personal</h2>
          <div className="row">
            <div className="label">
              <strong>Name</strong>
              <span>{me.name}</span>
            </div>
            <button className="btn" type="button" disabled title="Changing your name needs identity re-check">
              Edit
            </button>
          </div>
          <div className="row">
            <div className="label">
              <strong>Phone</strong>
              <span>{me.phone ?? 'Not added'}</span>
            </div>
            <button className="btn" type="button" disabled title="Needs your PIN and a code to the new number">
              Change
            </button>
          </div>
          <div className="row">
            <div className="label">
              <strong>Roles</strong>
              <span>{me.roles.map((r) => ROLE_LABEL[r.role] ?? r.role).join(', ')}</span>
            </div>
          </div>
        </section>

        <section className="card" id="security" aria-labelledby="sec">
          <h2 id="sec">Security</h2>
          <div className="row">
            <div className="label">
              <strong>Two-step login</strong>
              <span>{me.security.mfaRequired ? 'Required for your role. Cannot be turned off.' : 'Authenticator app or SMS code'}</span>
            </div>
            <span className={`chip ${me.security.mfaEnabled ? 'success' : 'warning'}`}>{me.security.mfaEnabled ? 'On' : 'Off'}</span>
          </div>
          <div className="row">
            <div className="label">
              <strong>PIN</strong>
              <span>6 digits, asked for payouts and signing</span>
            </div>
            <span className={`chip ${me.security.hasPin ? 'success' : 'neutral'}`}>{me.security.hasPin ? 'Set' : 'Not set'}</span>
          </div>
          <div className="row">
            <div className="label">
              <strong>Active sessions</strong>
              <span>This browser, signed in now</span>
            </div>
            <button className="btn" type="button" disabled>
              Manage
            </button>
          </div>
        </section>

        <section className="card" id="appearance" aria-labelledby="look">
          <h2 id="look">Appearance</h2>
          <div className="row">
            <div className="label">
              <strong>Theme</strong>
              <span>System follows your device. Emergency colours stay the same in every mode.</span>
            </div>
            <ThemeSwitch value={p.theme} onChange={(t) => save({ theme: t }, 'Theme saved.')} />
          </div>
          <div className="row">
            <div className="label">
              <strong>Reduce motion</strong>
              <span>Removes pulses and slides; keeps fades short.</span>
            </div>
            <button
              className="toggle"
              type="button"
              role="switch"
              aria-checked={p.reduceMotion}
              aria-label="Reduce motion"
              onClick={() => save({ reduceMotion: !p.reduceMotion }, p.reduceMotion ? 'Motion back on.' : 'Motion reduced.')}
            />
          </div>
          <div className="row">
            <div className="label">
              <strong>Language</strong>
              <span>Dashboard text and message drafts</span>
            </div>
            <select aria-label="Language" value={p.locale} onChange={(e) => save({ locale: e.target.value }, 'Language saved.')}>
              {Object.entries(LANGS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="card" aria-labelledby="notif">
          <h2 id="notif">Notifications</h2>
          {[
            { k: 'Safety and dispatch', d: 'New reports, escalations, officer needs help', locked: true },
            { k: 'Money', d: 'Payouts and invoices', locked: true },
            { k: 'Weekly summary', d: 'Email every Monday', locked: false },
          ].map((n) => (
            <div className="row" key={n.k}>
              <div className="label">
                <strong>{n.k}</strong>
                <span>{n.locked ? `${n.d}. Cannot be turned off.` : n.d}</span>
              </div>
              <button className="toggle" type="button" role="switch" aria-checked={n.locked} aria-label={n.k} disabled={n.locked} />
            </div>
          ))}
        </section>
      </div>

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </>
  );
}
