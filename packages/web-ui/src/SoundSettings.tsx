'use client';
// "Notification sounds": a sound for each kind of notification, with a play button to hear it,
// volume and vibration. Saved to the account, so it follows the person to every device.
import { DEFAULT_SOUNDS, SOUND_KINDS, SOUNDS, type SoundCode, type SoundKind, type SoundPrefs } from '@erp/domain';
import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { playSound, SOUNDS_CHANGED, unlockAudioOnGesture } from './sounds';

export function SoundSettings({ kinds = SOUND_KINDS.map((k) => k.code) }: { kinds?: SoundKind[] }) {
  const [p, setP] = useState<SoundPrefs | null>(null);
  const [discreet, setDiscreet] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    unlockAudioOnGesture();
    api<{ preferences: { sounds?: SoundPrefs; discreetMode?: boolean } }>('/me')
      .then((m) => {
        setP({ ...DEFAULT_SOUNDS, ...m.preferences.sounds });
        setDiscreet(!!m.preferences.discreetMode);
      })
      .catch(() => setP(DEFAULT_SOUNDS));
  }, []);
  const save = async (change: Partial<SoundPrefs>) => {
    if (!p) return;
    const before = p;
    setP({ ...p, ...change });
    try {
      await api('/me/preferences', { method: 'PATCH', body: JSON.stringify({ sounds: change }) });
      window.dispatchEvent(new Event(SOUNDS_CHANGED));
      setMsg('Saved.');
    } catch (e) {
      setP(before);
      setMsg(e instanceof ApiError ? e.message : 'Could not save. Try again.');
    }
    setTimeout(() => setMsg(null), 2000);
  };
  const hear = (code: SoundCode) => {
    if (!playSound(code, p?.volume ?? 80)) setMsg('Tap the page once, then play again: your browser blocks sound until you do.');
  };
  if (!p) return <div className="ss-wait" aria-busy="true" style={{ height: 120 }} />;
  return (
    <div className="ss">
      <style>{CSS}</style>
      {discreet && <p className="ss-note">Discreet mode is on, so the app plays no sounds and does not vibrate. Turn it off in Profile to use these.</p>}
      {SOUND_KINDS.filter((k) => kinds.includes(k.code)).map((k) => (
        <div className="ss-row" key={k.code}>
          <div className="ss-label">
            <strong>{k.label}</strong>
            <span>{k.hint}</span>
          </div>
          <div className="ss-ctl">
            <select value={p[k.code]} onChange={(e) => (void save({ [k.code]: e.target.value as SoundCode }), hear(e.target.value as SoundCode))} aria-label={`Sound for ${k.label}`}>
              {SOUNDS.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => hear(p[k.code])} disabled={p[k.code] === 'none'} aria-label={`Play ${k.label} sound`}>
              ▶ Play
            </button>
          </div>
        </div>
      ))}
      <div className="ss-row">
        <div className="ss-label">
          <strong>Volume</strong>
          <span>{p.volume}%</span>
        </div>
        <input type="range" min={0} max={100} step={5} value={p.volume} aria-label="Volume" onChange={(e) => setP({ ...p, volume: Number(e.target.value) })} onPointerUp={() => (void save({ volume: p.volume }), hear(p.dispatch))} onKeyUp={() => void save({ volume: p.volume })} />
      </div>
      <div className="ss-row">
        <div className="ss-label">
          <strong>Vibrate</strong>
          <span>On phones, a longer pattern for incoming reports and safety alerts</span>
        </div>
        <input type="checkbox" checked={p.vibrate} onChange={(e) => void save({ vibrate: e.target.checked })} aria-label="Vibrate" style={{ width: 22, height: 22 }} />
      </div>
      {msg && (
        <p className="ss-msg" role="status">
          {msg}
        </p>
      )}
    </div>
  );
}

const CSS = `
.ss{display:grid;gap:4px}
.ss-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--color-divider,#333)}
.ss-row:last-of-type{border-bottom:0}
.ss-label{display:grid;min-width:0}
.ss-label span{color:var(--color-text-secondary,#aaa);font-size:13px}
.ss-ctl{display:flex;gap:8px;align-items:center;flex:none}
.ss-ctl select{min-height:38px;border-radius:10px;border:1px solid var(--color-divider,#333);background:var(--color-surface-sunken,#0a0a0a);color:inherit;font:inherit;font-size:14px;padding:0 10px}
.ss-ctl button{min-height:38px;border-radius:10px;border:1px solid var(--color-divider,#333);background:transparent;color:inherit;font:inherit;font-size:13px;font-weight:600;padding:0 12px;cursor:pointer}
.ss-ctl button:disabled{opacity:.4;cursor:not-allowed}
.ss input[type=range]{width:min(220px,45vw);accent-color:var(--color-signal,#22d3ee)}
.ss-note{margin:0 0 6px;font-size:13px;color:var(--color-warning-text,#fcd34d)}
.ss-msg{margin:6px 0 0;font-size:13px;color:var(--color-text-secondary,#aaa)}
@media (max-width:520px){.ss-row{flex-direction:column;align-items:stretch}.ss-ctl{justify-content:space-between}.ss-ctl select{flex:1}}
`;
