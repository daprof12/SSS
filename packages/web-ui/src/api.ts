// Thin client for the ERP API, shared by the dashboard and the PWA. The PWA
// keeps the session across launches (localStorage); the dashboard per tab
// (sessionStorage). Access tokens last 15 minutes and are refreshed silently;
// the refresh token rotates on every use. Production staff sign-in moves to the
// OIDC provider (TRD) without changing callers.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface Session {
  token: string;
  /** Present for phone sign-in; demo sign-in has none and simply expires. */
  refreshToken?: string;
  name: string;
  roleLabel: string;
  /** PWA only: which app surface this account uses. */
  surface?: 'citizen' | 'officer';
}

let storeKind: 'session' | 'local' = 'session';
export function configureSessionStore(kind: 'session' | 'local') {
  storeKind = kind;
}
const store = () => (storeKind === 'local' ? localStorage : sessionStorage);

export function getSession(): Session | null {
  try {
    const raw = store().getItem('erp-session');
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function setSession(s: Session | null) {
  try {
    if (s) store().setItem('erp-session', JSON.stringify(s));
    else store().removeItem('erp-session');
  } catch {}
}

/** Fired when the session can no longer be refreshed; apps send people to sign-in. */
export const SIGNED_OUT_EVENT = 'erp:signed-out';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Array<{ field: string; message: string }>,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function tokenExpiresAt(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return (payload.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

let refreshing: Promise<boolean> | null = null;

/** One refresh at a time, shared by every caller that hit a 401 together. */
export function refreshSession(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const s = getSession();
    if (!s?.refreshToken) return false;
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: s.refreshToken }),
      });
      if (!res.ok) {
        // Only a definite rejection signs out; a network blip keeps the session.
        if (res.status === 401) endSession();
        return false;
      }
      const r = await res.json();
      setSession({ ...s, token: r.accessToken, refreshToken: r.refreshToken });
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

function endSession() {
  setSession(null);
  try {
    window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  } catch {}
}

/** Refreshes ahead of time if the access token expires within a minute (used before opening streams). */
export async function ensureFreshToken(): Promise<void> {
  const s = getSession();
  if (s?.refreshToken && tokenExpiresAt(s.token) - Date.now() < 60_000) await refreshSession();
}

export async function api<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const s = getSession();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(s ? { Authorization: `Bearer ${s.token}` } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError(0, 'offline', 'You are offline.');
  }
  if (res.status === 401 && s && !retried && !path.startsWith('/auth/')) {
    if (await refreshSession()) return api<T>(path, init, true);
    if (!s.refreshToken) endSession();
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { code, message, fields, ...extra } = body;
    throw new ApiError(res.status, code ?? 'error', message ?? 'Something went wrong. Try again.', fields, extra);
  }
  return body as T;
}

export function streamUrl(path: string): string {
  const s = getSession();
  return `${API_URL}${path}?access_token=${encodeURIComponent(s?.token ?? '')}`;
}
