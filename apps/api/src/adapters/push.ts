// Web push (VAPID). Officers get offers when the app is closed; everyone gets their alerts.
// - Web: the `web-push` library with VAPID keys (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT).
// - Mock (development without keys, tests): keeps an outbox.
import webpush from 'web-push';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}
export interface PushPayload {
  title: string;
  body: string;
  /** The API's deep link; the app turns it into its own page. */
  link: string | null;
  /** Same tag replaces the earlier alert (e.g. one per offer). */
  tag: string;
  /** Offers and safety alerts: delivered at once and kept on screen until acted on. */
  urgent: boolean;
}
/** `gone`: the device unsubscribed or the browser dropped it; forget the subscription. */
export class PushSendError extends Error {
  constructor(
    message: string,
    readonly gone: boolean,
  ) {
    super(message);
  }
}

export interface PushAdapter {
  readonly name: string;
  /** The public VAPID key the app subscribes with (null when push is off). */
  readonly publicKey: string | null;
  send(to: PushTarget, payload: PushPayload): Promise<void>;
}
export const PUSH = Symbol('PUSH');

export class MockPushAdapter implements PushAdapter {
  readonly name = 'mock';
  readonly publicKey: string | null;
  readonly outbox: Array<{ to: string } & PushPayload> = [];
  /** Tests: endpoints the "browser" has dropped. */
  readonly gone = new Set<string>();
  constructor(publicKey: string | null = null) {
    this.publicKey = publicKey;
  }
  async send(to: PushTarget, payload: PushPayload) {
    if (this.gone.has(to.endpoint)) throw new PushSendError('Subscription has unsubscribed or expired.', true);
    this.outbox.push({ to: to.endpoint, ...payload });
  }
}

export class WebPushAdapter implements PushAdapter {
  readonly name = 'web';
  constructor(
    readonly publicKey: string,
    private readonly privateKey: string,
    private readonly subject: string,
  ) {}

  async send(to: PushTarget, payload: PushPayload) {
    try {
      await webpush.sendNotification({ endpoint: to.endpoint, keys: { p256dh: to.p256dh, auth: to.auth } }, JSON.stringify(payload), {
        vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey },
        // An offer is useless after its accept window; other alerts can wait up to a day.
        TTL: payload.urgent ? 120 : 86_400,
        urgency: payload.urgent ? 'high' : 'normal',
        topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
        timeout: 8000,
      });
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      throw new PushSendError(`push ${status ?? 'failed'}: ${(e as Error).message}`.slice(0, 300), status === 404 || status === 410);
    }
  }
}

/**
 * Production needs VAPID keys (make them once with `npx web-push generate-vapid-keys`): officers must
 * get offers with the app closed. Development without keys uses the mock.
 */
export function pushFromEnv(env: string, e: NodeJS.ProcessEnv): PushAdapter {
  const pub = e.VAPID_PUBLIC_KEY;
  const priv = e.VAPID_PRIVATE_KEY;
  if (pub && priv && env !== 'test') return new WebPushAdapter(pub, priv, e.VAPID_SUBJECT ?? 'mailto:support@erp.ng');
  if (env === 'production') throw new Error('Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in production: officers get offers by push');
  return new MockPushAdapter(env === 'test' ? 'BTestPublicKey' : null);
}
