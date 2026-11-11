'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@erp/web-ui/api';

export interface MyAgency {
  id: string;
  name: string;
  status: string;
  statusLabel: string;
  /** API path of the agency's logo, or null. */
  logoUrl: string | null;
  /** Which queues this agency has, from its kind (a fire service gets neither tips nor public issues). */
  handles: { tips: boolean; bounties: boolean; issues: boolean; stolen: boolean };
}

interface Ctx {
  agencies: MyAgency[] | null;
  error: string | null;
  agency: MyAgency | null;
  choose: (id: string) => void;
}

const AgencyCtx = createContext<Ctx>({ agencies: null, error: null, agency: null, choose: () => {} });
const KEY = 'erp-agency';

/**
 * The agencies the signed-in admin works for (GET /me/agencies, i.e. their
 * agency-scoped roles). The choice is kept per tab, like the session.
 */
export function AgencyProvider({ children }: { children: React.ReactNode }) {
  const [agencies, setAgencies] = useState<MyAgency[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    api<MyAgency[]>('/me/agencies')
      .then((list) => {
        setAgencies(list);
        let saved: string | null = null;
        try {
          saved = sessionStorage.getItem(KEY);
        } catch {}
        setId(list.some((a) => a.id === saved) ? saved : (list[0]?.id ?? null));
      })
      .catch((e: ApiError) => setError(e.message));
  }, []);

  const choose = useCallback((next: string) => {
    setId(next);
    try {
      sessionStorage.setItem(KEY, next);
    } catch {}
  }, []);

  const agency = agencies?.find((a) => a.id === id) ?? null;
  return <AgencyCtx.Provider value={{ agencies, error, agency, choose }}>{children}</AgencyCtx.Provider>;
}

export const useAgency = () => useContext(AgencyCtx);

/** Loading, error and "no agency" states every agency page shares. Renders children with the chosen agency. */
const NOT_HANDLED = {
  tips: ['Your agency does not receive tips.', 'Tips go to the agency for each category, such as NAPTIP for trafficking.'],
  bounties: ['Your agency does not pay bounties.', 'Bounties are for agencies that receive tips in categories that pay one.'],
  issues: ['Your agency does not handle public issues.', 'Public issues go to agencies that fix roads, lights, buildings and similar problems.'],
  stolen: ['Your agency does not handle stolen items.', 'Stolen-item reports and buyer-check matches go to the police.'],
};

export function WithAgency({ children, needs }: { children: (agency: MyAgency) => React.ReactNode; needs?: keyof MyAgency['handles'] }) {
  const { agencies, agency, error } = useAgency();
  if (error)
    return (
      <div className="banner critical" role="alert">
        <strong>Could not load your agencies</strong>
        {error}
      </div>
    );
  if (!agencies) return <div className="skeleton" style={{ height: 200 }} />;
  if (!agency)
    return (
      <div className="card empty">
        <strong>You are not an admin of any agency.</strong>
        Ask your agency to invite you.
      </div>
    );
  // Reached by a link to a queue this agency does not have.
  if (needs && !agency.handles[needs])
    return (
      <div className="card empty">
        <strong>{NOT_HANDLED[needs][0]}</strong>
        {NOT_HANDLED[needs][1]}
      </div>
    );
  return <>{children(agency)}</>;
}

export function useToast() {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);
  const node = toast ? (
    <div className="toast" role="status" aria-live="polite">
      {toast}
    </div>
  ) : null;
  return [node, setToast] as const;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dateOnly = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const shortDate = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
export const dateTime = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const daysSince = (iso: string, now = Date.now()) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Loads one record under the chosen agency; for a link from a notification
 * (which carries no agency) it tries the admin's other agencies and switches
 * to the one that owns it.
 */
export function useAgencyRecord<T>(path: (agencyId: string) => string) {
  const { agencies, agency, choose } = useAgency();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const owner = useRef<string | null>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    if (!agencies || !agency) return;
    let stop = false;
    const order = owner.current ? [owner.current] : [agency.id, ...agencies.filter((a) => a.id !== agency.id).map((a) => a.id)];
    (async () => {
      for (const id of order) {
        try {
          const d = await api<T>(path(id));
          if (stop) return;
          setData(d);
          setError(null);
          owner.current = id;
          if (id !== agency.id) choose(id);
          return;
        } catch (e) {
          if (stop) return;
          if (!(e instanceof ApiError) || e.status !== 404) {
            setError(e as ApiError);
            return;
          }
        }
      }
      setError(new ApiError(404, 'not_found', 'This report is not with your agency.'));
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agencies, n]);

  return { data, error, agencyId: owner.current, reload: () => setN((x) => x + 1) };
}
