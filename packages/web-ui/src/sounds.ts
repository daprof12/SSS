// Notification sounds, synthesised with Web Audio (no audio files to download or cache). Browsers
// only allow sound after the person has touched the page, so the first tap or key press unlocks it.
import type { SoundCode, SoundPrefs } from '@erp/domain';

let ctx: AudioContext | null = null;
let unlockedOnce = false;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/** Call once on app start: the first tap or key press lets later sounds play. */
export function unlockAudioOnGesture() {
  if (typeof window === 'undefined' || unlockedOnce) return;
  unlockedOnce = true;
  const go = () => {
    void audio()?.resume();
    window.removeEventListener('pointerdown', go);
    window.removeEventListener('keydown', go);
  };
  window.addEventListener('pointerdown', go);
  window.addEventListener('keydown', go);
}

type Wave = OscillatorType;
/** One tone: frequency glide from `f0` to `f1` over `dur` seconds, starting `at` seconds from now. */
function tone(a: AudioContext, out: GainNode, { f0, f1 = f0, at = 0, dur, wave = 'sine', level = 1, decay = true }: { f0: number; f1?: number; at?: number; dur: number; wave?: Wave; level?: number; decay?: boolean }) {
  const t = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = wave;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.linearRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(level, t + 0.01);
  if (decay) g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  else {
    g.gain.setValueAtTime(level, t + dur - 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.05);
}

const PATTERNS: Record<Exclude<SoundCode, 'none'>, (a: AudioContext, out: GainNode) => number> = {
  siren: (a, out) => {
    for (let i = 0; i < 2; i++) {
      tone(a, out, { f0: 620, f1: 1240, at: i * 0.9, dur: 0.45, wave: 'sawtooth', level: 0.35, decay: false });
      tone(a, out, { f0: 1240, f1: 620, at: i * 0.9 + 0.45, dur: 0.45, wave: 'sawtooth', level: 0.35, decay: false });
    }
    return 1.8;
  },
  alarm: (a, out) => {
    for (let i = 0; i < 4; i++) tone(a, out, { f0: 880, at: i * 0.22, dur: 0.14, wave: 'square', level: 0.3, decay: false });
    return 0.9;
  },
  bell: (a, out) => {
    tone(a, out, { f0: 880, dur: 1.6, level: 0.6 });
    tone(a, out, { f0: 1760, dur: 1.1, level: 0.25 });
    tone(a, out, { f0: 2640, dur: 0.7, level: 0.12 });
    return 1.6;
  },
  chime: (a, out) => {
    tone(a, out, { f0: 1047, dur: 0.5, wave: 'triangle', level: 0.6 });
    tone(a, out, { f0: 1568, at: 0.18, dur: 0.8, wave: 'triangle', level: 0.6 });
    return 1;
  },
  pulse: (a, out) => {
    for (let i = 0; i < 3; i++) tone(a, out, { f0: 660, at: i * 0.18, dur: 0.12, level: 0.6 });
    return 0.6;
  },
  drum: (a, out) => {
    tone(a, out, { f0: 160, f1: 50, dur: 0.35, level: 0.9 });
    tone(a, out, { f0: 160, f1: 50, at: 0.3, dur: 0.35, level: 0.9 });
    return 0.7;
  },
  soft: (a, out) => {
    tone(a, out, { f0: 520, f1: 600, dur: 0.18, level: 0.5 });
    return 0.2;
  },
};

/** Plays a sound at a volume from 0 to 100. Returns false when the browser has not allowed sound yet. */
export function playSound(code: SoundCode, volume = 80): boolean {
  if (code === 'none' || volume <= 0) return true;
  const a = audio();
  if (!a) return false;
  if (a.state === 'suspended') void a.resume();
  if (a.state !== 'running') return false;
  const out = a.createGain();
  out.gain.value = Math.min(1, volume / 100);
  out.connect(a.destination);
  const secs = PATTERNS[code](a, out);
  setTimeout(() => out.disconnect(), (secs + 0.5) * 1000);
  return true;
}

/** Vibration (phones), a stronger pattern for urgent kinds. */
export function vibrate(kind: keyof Pick<SoundPrefs, 'dispatch' | 'safety' | 'reports' | 'general'>) {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  navigator.vibrate(kind === 'dispatch' || kind === 'safety' ? [300, 120, 300, 120, 300] : [120]);
}

/** Sent after the person saves their sound settings, so the watcher uses them at once. */
export const SOUNDS_CHANGED = 'erp:sounds-changed';
/** Sent when new notifications arrive, so bells and lists can refresh. */
export const NEW_NOTIFICATIONS = 'erp:new-notifications';
