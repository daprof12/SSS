// Paystack adapter. Money is credited only from a signed webhook, never from
// the client callback (TRD). The mock signs webhooks exactly like Paystack:
// HMAC-SHA512 of the raw body with the secret key, in x-paystack-signature.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type PayMethod = 'card' | 'bank_transfer' | 'ussd';

export interface InitInput {
  reference: string;
  amountKobo: number;
  email: string;
  method: PayMethod;
  metadata: Record<string, unknown>;
}

export interface InitResult {
  reference: string;
  /** Card and USSD: hosted checkout. */
  checkoutUrl?: string;
  /** Bank transfer: the user's dedicated virtual account. */
  transferAccount?: { bankName: string; accountNumber: string; accountName: string };
}

export interface ChargeEvent {
  event: 'charge.success' | 'charge.failed';
  data: { id: number; reference: string; amount: number; status: string; channel: string; gateway_response: string; metadata: Record<string, unknown> };
}

/** Money out (payouts, withdrawals): Paystack pays a saved transfer recipient. */
export interface TransferInput {
  reference: string;
  amountKobo: number;
  /** Paystack transfer recipient for the verified bank account. */
  recipientCode: string;
  reason: string;
}

export interface TransferEvent {
  event: 'transfer.success' | 'transfer.failed' | 'transfer.reversed';
  data: { id: number; reference: string; amount: number; transfer_code: string; status: string; reason: string };
}

export interface PaymentsAdapter {
  readonly name: string;
  initialize(input: InitInput): Promise<InitResult>;
  /** Queues a transfer. The outcome arrives later as a signed transfer.* webhook. */
  transfer(input: TransferInput): Promise<{ transferCode: string }>;
  /** Paystack "Resolve account number": the name the bank holds for this account, or null if none. */
  resolveAccount(bankCode: string, accountNumber: string, devHint?: string): Promise<{ accountName: string } | null>;
  /** Paystack "Create transfer recipient", used for every later transfer to this account. */
  createRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<{ recipientCode: string }>;
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean;
}

export const PAYMENTS = Symbol('PAYMENTS');

export function signPaystack(secret: string, rawBody: string | Buffer): string {
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

export class MockPaystackAdapter implements PaymentsAdapter {
  readonly name = 'mock';
  private readonly pending = new Map<string, InitInput>();
  // Unique across restarts, like Paystack's own event ids (a restart must never replay an id).
  private eventSeq = 0;
  private nextEventId() {
    return Date.now() * 1000 + (++this.eventSeq % 1000);
  }

  constructor(private readonly secret: string, private readonly baseUrl: string) {}

  async initialize(input: InitInput): Promise<InitResult> {
    this.pending.set(input.reference, input);
    if (input.method === 'bank_transfer') {
      return { reference: input.reference, transferAccount: { bankName: 'Wema Bank (mock)', accountNumber: `99${String(Date.now()).slice(-8)}`, accountName: 'ERP / Test User' } };
    }
    return { reference: input.reference, checkoutUrl: `${this.baseUrl}/dev/paystack/checkout/${encodeURIComponent(input.reference)}` };
  }

  private readonly transfers = new Map<string, TransferInput & { transferCode: string }>();

  /**
   * Development only: any 10-digit number resolves to the name the caller expects, except numbers
   * ending in 0000 (someone else's account) and 9999 (no such account), so both failures can be tried.
   */
  async resolveAccount(_bankCode: string, accountNumber: string, devHint?: string) {
    if (accountNumber.endsWith('9999')) return null;
    if (accountNumber.endsWith('0000')) return { accountName: 'CHINEDU OKAFOR TRADING' };
    return { accountName: (devHint ?? 'ACCOUNT HOLDER').toUpperCase() };
  }

  async createRecipient(input: { name: string; accountNumber: string; bankCode: string }) {
    return { recipientCode: `RCP_${input.bankCode}_${input.accountNumber.slice(-4)}_${randomBytes(3).toString('hex')}` };
  }

  async transfer(input: TransferInput): Promise<{ transferCode: string }> {
    const transferCode = `TRF_${randomBytes(6).toString('hex')}`;
    this.transfers.set(input.reference, { ...input, transferCode });
    return { transferCode };
  }

  /** Dev only: re-register a transfer queued before an API restart. */
  restoreTransfer(input: TransferInput & { transferCode: string }) {
    if (!this.transfers.has(input.reference)) this.transfers.set(input.reference, input);
  }

  /** Dev only: what Paystack would POST when a transfer settles or fails. */
  buildTransferWebhook(reference: string, outcome: 'success' | 'failed'): { body: string; signature: string } {
    const t = this.transfers.get(reference);
    if (!t) throw new Error(`unknown transfer ${reference}`);
    const event: TransferEvent = {
      event: outcome === 'success' ? 'transfer.success' : 'transfer.failed',
      data: { id: this.nextEventId(), reference, amount: t.amountKobo, transfer_code: t.transferCode, status: outcome, reason: outcome === 'success' ? t.reason : 'Account could not be credited' },
    };
    const body = JSON.stringify(event);
    return { body, signature: signPaystack(this.secret, body) };
  }

  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = Buffer.from(signPaystack(this.secret, rawBody), 'hex');
    const got = Buffer.from(signature, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  /** Dev only: re-register a payment started before an API restart (the map is in memory). */
  restore(input: InitInput) {
    if (!this.pending.has(input.reference)) this.pending.set(input.reference, input);
  }

  /** Dev only: what Paystack would POST to our webhook after the customer pays. */
  buildWebhook(reference: string, outcome: 'success' | 'failed', amountOverride?: number): { body: string; signature: string } {
    const init = this.pending.get(reference);
    if (!init) throw new Error(`unknown reference ${reference}`);
    const event: ChargeEvent = {
      event: outcome === 'success' ? 'charge.success' : 'charge.failed',
      data: {
        id: this.nextEventId(),
        reference,
        amount: amountOverride ?? init.amountKobo,
        status: outcome,
        channel: init.method === 'bank_transfer' ? 'dedicated_nuban' : init.method,
        gateway_response: outcome === 'success' ? 'Approved' : 'Declined by bank',
        metadata: init.metadata,
      },
    };
    const body = JSON.stringify(event);
    return { body, signature: signPaystack(this.secret, body) };
  }
}

/** Our payment and transfer reference: lowercase letters, digits and "_" (Paystack's transfer rule). */
export const newReference = (prefix: string) => `${prefix.toLowerCase()}_${randomBytes(9).toString('hex')}`;

export interface PaystackConfig {
  secretKey: string;
  baseUrl?: string;
  /** Where Paystack sends people back after checkout: the phone app, and the dashboard for agency payments. */
  appUrl: string;
  dashboardUrl: string;
  timeoutMs?: number;
}

/** A Paystack call that failed; the message is safe to log, not to show. */
export class PaystackError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Paystack (https://api.paystack.co). Checkout is Paystack's hosted page for every method (card, USSD,
 * bank transfer); the person comes back to the app, and money is credited only from the signed
 * webhook. Money out uses "Resolve account", "Create transfer recipient" and "Initiate transfer"
 * (turn off transfer OTP for API transfers in the Paystack dashboard).
 */
export class PaystackAdapter implements PaymentsAdapter {
  readonly name = 'paystack';
  constructor(
    private readonly cfg: PaystackConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: T | null; message: string }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${(this.cfg.baseUrl ?? 'https://api.paystack.co').replace(/\/$/, '')}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.cfg.secretKey}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15000),
      });
    } catch (e) {
      throw new PaystackError(`Paystack unreachable: ${(e as Error).message}`, 0);
    }
    const j = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
    return { status: res.status, data: res.ok && j.status !== false ? (j.data ?? null) : null, message: j.message ?? `HTTP ${res.status}` };
  }

  private callbackFor(metadata: Record<string, unknown>) {
    const p = String(metadata.purpose ?? '');
    if (p === 'agency_invoice') return `${this.cfg.dashboardUrl}/agency/billing?paid=1`;
    if (p === 'bounty_pool') return `${this.cfg.dashboardUrl}/agency/bounties?funded=1`;
    return `${this.cfg.appUrl}/pay/return`;
  }

  async initialize(input: InitInput): Promise<InitResult> {
    const r = await this.call<{ authorization_url: string; reference: string }>('POST', '/transaction/initialize', {
      email: input.email,
      amount: input.amountKobo,
      currency: 'NGN',
      reference: input.reference,
      channels: [input.method],
      callback_url: this.callbackFor(input.metadata),
      metadata: input.metadata,
    });
    if (!r.data?.authorization_url) throw new PaystackError(`initialize: ${r.message}`, r.status);
    return { reference: input.reference, checkoutUrl: r.data.authorization_url };
  }

  async resolveAccount(bankCode: string, accountNumber: string) {
    const r = await this.call<{ account_name: string }>('GET', `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
    if (r.data?.account_name) return { accountName: r.data.account_name };
    // 422/400: no such account at that bank. Anything else is Paystack's problem, not the person's.
    if (r.status === 400 || r.status === 422) return null;
    throw new PaystackError(`resolve: ${r.message}`, r.status);
  }

  async createRecipient(input: { name: string; accountNumber: string; bankCode: string }) {
    const r = await this.call<{ recipient_code: string }>('POST', '/transferrecipient', { type: 'nuban', name: input.name, account_number: input.accountNumber, bank_code: input.bankCode, currency: 'NGN' });
    if (!r.data?.recipient_code) throw new PaystackError(`recipient: ${r.message}`, r.status);
    return { recipientCode: r.data.recipient_code };
  }

  async transfer(input: TransferInput) {
    const r = await this.call<{ transfer_code: string }>('POST', '/transfer', { source: 'balance', amount: input.amountKobo, recipient: input.recipientCode, reason: input.reason.slice(0, 100), reference: input.reference, currency: 'NGN' });
    if (!r.data?.transfer_code) throw new PaystackError(`transfer: ${r.message}`, r.status);
    return { transferCode: r.data.transfer_code };
  }

  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = Buffer.from(signPaystack(this.cfg.secretKey, rawBody), 'hex');
    const got = Buffer.from(signature, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  }
}

/**
 * PAYSTACK_SECRET with a real key (sk_test_… or sk_live_…) uses Paystack; development and tests use
 * the mock. Production refuses to start without a key, or with a test key unless PAYSTACK_ALLOW_TEST=1.
 */
export function paymentsFromEnv(env: string, secret: string, e: NodeJS.ProcessEnv, publicBaseUrl: string): PaymentsAdapter {
  const real = /^sk_(test|live)_/.test(secret) && secret !== 'sk_test_mock';
  if (env === 'production') {
    if (!real) throw new Error('Set PAYSTACK_SECRET to your Paystack secret key in production');
    if (secret.startsWith('sk_test_') && e.PAYSTACK_ALLOW_TEST !== '1') throw new Error('PAYSTACK_SECRET is a test key; set PAYSTACK_ALLOW_TEST=1 for a staging server');
  }
  if (real && env !== 'test') {
    const appUrl = e.APP_URL ?? 'http://localhost:3001';
    const dashboardUrl = e.DASHBOARD_URL ?? 'http://localhost:3000';
    return new PaystackAdapter({ secretKey: secret, appUrl, dashboardUrl });
  }
  return new MockPaystackAdapter(secret, publicBaseUrl);
}
