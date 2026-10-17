// The installed app keeps the sign-in across launches.
import { configureSessionStore } from '@erp/web-ui/api';

configureSessionStore('local');

export { api, ApiError, getSession, setSession, streamUrl, type Session } from '@erp/web-ui/api';

export const TYPES = [
  { code: 'fire', label: 'Fire', agency: 'Fire service' },
  { code: 'robbery', label: 'Robbery', agency: 'Police' },
  { code: 'medical', label: 'Medical', agency: 'Ambulance' },
  { code: 'kidnapping', label: 'Kidnapping', agency: 'Police' },
  { code: 'riot', label: 'Riot', agency: 'Police' },
  { code: 'violence', label: 'Violence', agency: 'Police and ambulance' },
  { code: 'accident', label: 'Accident', agency: 'Road safety and ambulance' },
  { code: 'other', label: 'Other danger', agency: 'Nearest agency' },
] as const;
export type TypeCode = (typeof TYPES)[number]['code'];
export const typeInfo = (code: string) => TYPES.find((t) => t.code === code) ?? TYPES[7];

/** A one-off idempotency key / client reference. */
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Gentle haptics (Design Brief): tap on confirm, success buzz on accepted. */
export function haptic(pattern: number | number[]) {
  try {
    if (document.documentElement.dataset.motion === 'reduced') return;
    navigator.vibrate?.(pattern);
  } catch {}
}

/** Current position, or null if refused or unavailable within the timeout. */
export function locate(timeoutMs = 6000): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
  });
}
