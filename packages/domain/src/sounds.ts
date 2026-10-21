// Notification sounds (all surfaces). Each person picks a sound per kind of notification; the
// apps play it when one arrives. Discreet mode always silences sounds and vibration.

export const SOUNDS = [
  { code: 'siren', label: 'Siren' },
  { code: 'alarm', label: 'Alarm' },
  { code: 'bell', label: 'Bell' },
  { code: 'chime', label: 'Chime' },
  { code: 'pulse', label: 'Pulse' },
  { code: 'drum', label: 'Drum' },
  { code: 'soft', label: 'Soft pop' },
  { code: 'none', label: 'Silent' },
] as const;
export type SoundCode = (typeof SOUNDS)[number]['code'];

/** What a sound is chosen for. Notification groups map onto these. */
export const SOUND_KINDS = [
  { code: 'dispatch', label: 'Incoming reports and offers', hint: 'New reports for your station, offers for officers, officers asking for help' },
  { code: 'safety', label: 'Safety alerts', hint: 'Danger near you or your home, device tamper alerts' },
  { code: 'reports', label: 'Updates on reports', hint: 'Help accepted, on the way, arrived, statements' },
  { code: 'general', label: 'Everything else', hint: 'Money, account, team messages, Learn' },
] as const;
export type SoundKind = (typeof SOUND_KINDS)[number]['code'];

export interface SoundPrefs {
  dispatch: SoundCode;
  safety: SoundCode;
  reports: SoundCode;
  general: SoundCode;
  /** 0 to 100. */
  volume: number;
  vibrate: boolean;
}

export const DEFAULT_SOUNDS: SoundPrefs = { dispatch: 'siren', safety: 'alarm', reports: 'chime', general: 'soft', volume: 80, vibrate: true };

/** Which sound a notification group plays. */
export function soundKindFor(group: string): SoundKind {
  if (group === 'dispatch') return 'dispatch';
  if (group === 'safety') return 'safety';
  if (group === 'reports' || group === 'tips') return 'reports';
  return 'general';
}
