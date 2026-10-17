// Offline report queue (SRS REP-8; States doc "Never blocked"). A report is
// saved with its client reference and retried; the server de-duplicates on it.
import { api, ApiError } from './client';

export interface QueuedReport {
  clientRef: string;
  type: string;
  postcode?: string;
  lat?: number;
  lng?: number;
  discreet?: boolean;
  savedAt: string;
}

const KEY = 'erp-outbox';
/** Placeholder until the SMS short code is registered (Public Issues doc §4). */
export const SMS_NUMBER = process.env.NEXT_PUBLIC_SMS_NUMBER ?? '32123';

export function readOutbox(): QueuedReport[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}

function write(items: QueuedReport[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {}
}

export function enqueue(r: QueuedReport) {
  write([...readOutbox().filter((x) => x.clientRef !== r.clientRef), r]);
}

export function dequeue(clientRef: string) {
  write(readOutbox().filter((x) => x.clientRef !== clientRef));
}

/** Sends one report; on a network failure it stays queued. Returns the incident id when sent. */
export async function sendReport(r: QueuedReport): Promise<{ id: string; addressWarning?: string } | null> {
  try {
    const out = await api<{ id: string; addressWarning?: string }>('/incidents', {
      method: 'POST',
      body: JSON.stringify({ type: r.type, postcode: r.postcode, lat: r.lat, lng: r.lng, discreet: r.discreet, clientRef: r.clientRef }),
    });
    dequeue(r.clientRef);
    return out;
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) {
      enqueue(r);
      return null;
    }
    throw e;
  }
}

let flushing = false;
export async function flushOutbox(): Promise<string[]> {
  if (flushing) return [];
  flushing = true;
  const sent: string[] = [];
  try {
    for (const r of readOutbox()) {
      const out = await sendReport(r).catch(() => null);
      if (out) sent.push(out.id);
    }
  } finally {
    flushing = false;
  }
  return sent;
}

/** SMS body the gateway parses: type, postcode or coordinates, client ref. */
export function smsHref(r: QueuedReport): string {
  const where = r.postcode ?? (r.lat != null ? `${r.lat.toFixed(5)},${r.lng!.toFixed(5)}` : 'unknown');
  const body = `ERP ${r.type.toUpperCase()} ${where} ${r.clientRef.slice(0, 8)}`;
  return `sms:${SMS_NUMBER}?body=${encodeURIComponent(body)}`;
}
