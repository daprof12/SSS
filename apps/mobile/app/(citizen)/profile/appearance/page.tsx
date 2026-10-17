'use client';

import { applyMotion, applyTheme, onThemeChange, type ThemeChoice } from '@erp/web-ui/theme';
import { ThemeSwitch } from '@erp/web-ui/ThemeSwitch';
import { useEffect, useState } from 'react';
import { Header, Toast, useToast } from '@/components/AppFrame';
import { api } from '@/lib/client';

/** Appearance (board "Appearance system, light, dark"): theme with icons, reduce motion. Shared by both surfaces. */
export default function Appearance() {
  const [theme, setTheme] = useState<ThemeChoice>('system');
  const [reduced, setReduced] = useState(false);
  const [toast, setToast] = useToast();

  useEffect(() => {
    api<{ preferences: { theme: ThemeChoice; reduceMotion: boolean } }>('/me')
      .then((m) => {
        setTheme(m.preferences.theme);
        setReduced(m.preferences.reduceMotion);
      })
      .catch(() => {});
    return onThemeChange(setTheme);
  }, []);

  const save = async (patch: { theme?: ThemeChoice; reduceMotion?: boolean }, msg: string) => {
    if (patch.theme) applyTheme(patch.theme);
    if (patch.reduceMotion !== undefined) {
      setReduced(patch.reduceMotion);
      applyMotion(patch.reduceMotion);
    }
    try {
      await api('/me/preferences', { method: 'PATCH', body: JSON.stringify(patch) });
      setToast(msg);
    } catch {
      setToast('Could not save. Try again.');
    }
  };

  return (
    <main className="app">
      <Header title="Appearance" />
      <div className="card">
        <h2>Theme</h2>
        <ThemeSwitch value={theme} onChange={(t) => save({ theme: t }, 'Theme saved.')} />
        <p className="muted" style={{ marginBottom: 0 }}>
          System follows your phone, including its evening switch. Emergency colours stay the same in every mode.
        </p>
      </div>
      <div className="list">
        <div className="row" style={{ cursor: 'default' }}>
          <span className="grow">
            <strong>Reduce motion</strong>
            <span className="sub">Removes pulses and slides; keeps fades short</span>
          </span>
          <button className="toggle" type="button" role="switch" aria-checked={reduced} aria-label="Reduce motion" onClick={() => save({ reduceMotion: !reduced }, reduced ? 'Motion back on.' : 'Motion reduced.')} />
        </div>
      </div>
      <Toast msg={toast} />
    </main>
  );
}
