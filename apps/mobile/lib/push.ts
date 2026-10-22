// Turning alerts on for this device: the browser's permission, a push subscription with the
// server's key, and the subscription saved on the account. iPhones need the app on the Home Screen.
import { api } from '@/lib/client';

export type PushState = 'unsupported' | 'needs_install' | 'off_on_server' | 'blocked' | 'off' | 'on';

const toKey = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent);
const installed = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

async function registration() {
  return (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js'));
}

export async function pushState(): Promise<PushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIos() && !installed() ? 'needs_install' : 'unsupported';
  const { enabled } = await api<{ enabled: boolean }>('/push/key');
  if (!enabled) return 'off_on_server';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

export async function turnOnPush(): Promise<PushState> {
  const { publicKey } = await api<{ publicKey: string | null }>('/push/key');
  if (!publicKey) return 'off_on_server';
  if ((await Notification.requestPermission()) !== 'granted') return 'blocked';
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) }));
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api('/me/push', { method: 'POST', body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys, label: isIos() ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Browser' }) });
  return 'on';
}

export async function turnOffPush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api('/me/push', { method: 'DELETE', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
    await sub.unsubscribe();
  }
  return 'off';
}
