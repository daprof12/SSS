'use client';
// Plays the person's chosen sound when a notification arrives: incoming reports and offers, safety
// alerts, report updates, everything else. Checks every few seconds; silent in discreet mode.
import { DEFAULT_SOUNDS, soundKindFor, type SoundKind, type SoundPrefs } from '@erp/domain';
import { useEffect, useRef } from 'react';
import { api } from './api';
import { NEW_NOTIFICATIONS, playSound, SOUNDS_CHANGED, unlockAudioOnGesture, vibrate } from './sounds';

const ORDER: SoundKind[] = ['dispatch', 'safety', 'reports', 'general'];

export function NotificationSounds({ everyMs = 6000 }: { everyMs?: number }) {
  const prefs = useRef<SoundPrefs>(DEFAULT_SOUNDS);
  const discreet = useRef(false);
  const cursor = useRef<string | null>(null);

  useEffect(() => {
    unlockAudioOnGesture();
    const loadPrefs = () =>
      api<{ preferences: { sounds?: SoundPrefs; discreetMode?: boolean } }>('/me')
        .then((m) => {
          prefs.current = { ...DEFAULT_SOUNDS, ...m.preferences.sounds };
          discreet.current = !!m.preferences.discreetMode;
        })
        .catch(() => {});
    void loadPrefs();
    window.addEventListener(SOUNDS_CHANGED, loadPrefs);

    let stopped = false;
    const tick = async () => {
      try {
        const r = await api<{ now: string; items: { group: string; title: string }[] }>(`/me/notifications/new${cursor.current ? `?after=${encodeURIComponent(cursor.current)}` : ''}`);
        cursor.current = r.now;
        if (!r.items.length) return;
        window.dispatchEvent(new CustomEvent(NEW_NOTIFICATIONS, { detail: r.items }));
        if (discreet.current) return;
        // One sound per check: the most urgent kind among what arrived.
        const kinds = new Set(r.items.map((n) => soundKindFor(n.group)));
        const kind = ORDER.find((k) => kinds.has(k))!;
        playSound(prefs.current[kind], prefs.current.volume);
        if (prefs.current.vibrate) vibrate(kind);
      } catch {
        /* offline or signed out: try again next time */
      }
    };
    void tick();
    // Keeps checking in a background tab too: a dispatcher must hear a new report while on another tab.
    const t = setInterval(() => !stopped && void tick(), everyMs);
    return () => {
      stopped = true;
      clearInterval(t);
      window.removeEventListener(SOUNDS_CHANGED, loadPrefs);
    };
  }, [everyMs]);

  return null;
}
