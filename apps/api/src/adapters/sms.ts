// SMS adapter. Sign-in codes, security codes and alerts go out by text message.
// - Mock (development and tests): keeps an outbox for tests and the dev panel.
// - Termii (production; Nigerian provider): needs an approved sender ID. Urgent messages (codes,
//   emergencies) go on the DND route so they reach numbers on the Do-Not-Disturb list; others go
//   on the generic route, which respects DND (Public Issues doc §4).
// Every message is logged (codes blanked) by LoggedSmsAdapter.
import type { Queryable } from '../core/db';

export interface SmsMessage {
  to: string;
  body: string;
  /** Emergency and security messages ignore quiet hours and DND. */
  urgent: boolean;
}

export interface SmsAdapter {
  readonly name: string;
  send(msg: SmsMessage): Promise<{ id: string }>;
}

export const SMS = Symbol('SMS');

/** Thrown when a message could not be handed to the provider. The text is safe to show. */
export class SmsSendError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const NIGERIAN = /^\+234\d{10}$/;
/** SMS bodies stay short: one segment where possible. */
const oneSegment = (b: string) => (b.length > 160 ? `${b.slice(0, 157)}...` : b);

export class MockSmsAdapter implements SmsAdapter {
  readonly name = 'mock';
  readonly outbox: Array<SmsMessage & { id: string; at: string }> = [];
  /** Tests: make the provider look down. */
  down = false;

  async send(msg: SmsMessage) {
    if (this.down) throw new SmsSendError('SMS provider unavailable (mock)', true);
    if (!NIGERIAN.test(msg.to)) throw new SmsSendError('Enter a Nigerian phone number.', false);
    const id = `sms_${this.outbox.length + 1}`;
    this.outbox.push({ ...msg, body: oneSegment(msg.body), id, at: new Date().toISOString() });
    return { id };
  }
}

export interface TermiiConfig {
  apiKey: string;
  senderId: string;
  /** Termii gives each account its base URL (for example https://v3.api.termii.com). */
  baseUrl: string;
  timeoutMs?: number;
}

/** Termii "Send message" (POST /api/sms/send). One retry on a network error or a 5xx answer. */
export class TermiiSmsAdapter implements SmsAdapter {
  readonly name = 'termii';
  constructor(
    private readonly cfg: TermiiConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(msg: SmsMessage) {
    if (!NIGERIAN.test(msg.to)) throw new SmsSendError('Enter a Nigerian phone number.', false);
    const payload = {
      api_key: this.cfg.apiKey,
      to: msg.to.slice(1), // 234XXXXXXXXXX, no plus
      from: this.cfg.senderId,
      sms: oneSegment(msg.body),
      type: 'plain',
      channel: msg.urgent ? 'dnd' : 'generic',
    };
    let last: SmsSendError | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, '')}/api/sms/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 8000),
        });
        const body = (await res.json().catch(() => ({}))) as { message_id?: string; messageId?: string; message?: string; code?: string };
        const id = body.message_id ?? body.messageId;
        if (res.ok && id) return { id: String(id) };
        last = new SmsSendError(`Termii ${res.status}: ${body.message ?? 'no message id'}`, res.status >= 500);
      } catch (e) {
        if (e instanceof SmsSendError) last = e;
        else last = new SmsSendError(`Termii unreachable: ${(e as Error).message}`, true);
      }
      if (!last.retryable) break;
      if (attempt === 1) await new Promise((r) => setTimeout(r, 400));
    }
    throw last!;
  }
}

/** Blanks out codes (4 to 8 digits on their own) so the log never holds a usable code. */
export const redactCodes = (s: string) => s.replace(/\b\d{4,8}\b/g, (m) => '•'.repeat(m.length));

/** Logs every send, sent or failed, then passes the result on. */
export class LoggedSmsAdapter implements SmsAdapter {
  constructor(
    readonly inner: SmsAdapter,
    private readonly db: Queryable,
  ) {}

  get name() {
    return this.inner.name;
  }

  async send(msg: SmsMessage) {
    const log = (state: 'sent' | 'failed', providerId: string | null, error: string | null) =>
      this.db
        .query(`insert into sms_log (provider, provider_id, phone, body, urgent, state, error) values ($1, $2, $3, $4, $5, $6, $7)`, [
          this.inner.name,
          providerId,
          msg.to,
          redactCodes(oneSegment(msg.body)),
          msg.urgent,
          state,
          error,
        ])
        .catch(() => undefined); // the log never stops a message
    try {
      const r = await this.inner.send(msg);
      await log('sent', r.id, null);
      return r;
    } catch (e) {
      await log('failed', null, (e as Error).message.slice(0, 300));
      throw e;
    }
  }
}

/**
 * SMS_PROVIDER=termii uses Termii (TERMII_API_KEY, TERMII_SENDER_ID, TERMII_BASE_URL). Development
 * and tests use the mock unless told otherwise. Production refuses to start without a real one.
 */
export function smsFromEnv(env: string, e: NodeJS.ProcessEnv): SmsAdapter {
  const provider = e.SMS_PROVIDER ?? (env === 'production' ? '' : 'mock');
  if (provider === 'termii') {
    const apiKey = e.TERMII_API_KEY ?? '';
    const senderId = e.TERMII_SENDER_ID ?? '';
    if (!apiKey || !senderId) throw new Error('SMS_PROVIDER=termii needs TERMII_API_KEY and TERMII_SENDER_ID');
    return new TermiiSmsAdapter({ apiKey, senderId, baseUrl: e.TERMII_BASE_URL ?? 'https://api.ng.termii.com' });
  }
  if (provider === 'mock' && env !== 'production') return new MockSmsAdapter();
  throw new Error('Set SMS_PROVIDER=termii (with TERMII_API_KEY and TERMII_SENDER_ID) in production: sign-in codes need a real SMS provider');
}
