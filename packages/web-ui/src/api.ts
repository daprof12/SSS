// Thin client for the ERP API, shared by the dashboard and the PWA. The token
// lives in browser storage for the dev sign-in only; production uses the OIDC
// provider's session (TRD). The dashboard keeps it per tab (sessionStorage); the
// installed PWA keeps it across launches (localStorage).
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface Session {
  token: string;
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

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Array<{ field: string; message: string }>) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.code ?? 'error', body.message ?? 'Something went wrong. Try again.', body.fields);
  return body as T;
}

export function streamUrl(path: string): string {
  const s = getSession();
  return `${API_URL}${path}?access_token=${encodeURIComponent(s?.token ?? '')}`;
}
