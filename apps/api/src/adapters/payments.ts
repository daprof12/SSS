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
  initialize(input: InitInput): Promise<InitResult>;
  /** Queues a transfer. The outcome arrives later as a signed transfer.* webhook. */
  transfer(input: TransferInput): Promise<{ transferCode: string }>;
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean;
}

export const PAYMENTS = Symbol('PAYMENTS');

export function signPaystack(secret: string, rawBody: string | Buffer): string {
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

export class MockPaystackAdapter implements PaymentsAdapter {
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

export const newReference = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
