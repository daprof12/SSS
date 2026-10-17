// Thin client for the ERP API. The token lives in sessionStorage for the dev
// sign-in only; production uses the OIDC provider's session (TRD).
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface Session {
  token: string;
  name: string;
  roleLabel: string;
}

export function getSession(): Session | null {
  try {
    const raw = sessionStorage.getItem('erp-session');
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function setSession(s: Session | null) {
  try {
    if (s) sessionStorage.setItem('erp-session', JSON.stringify(s));
    else sessionStorage.removeItem('erp-session');
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
