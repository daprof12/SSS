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

export interface PaymentsAdapter {
  initialize(input: InitInput): Promise<InitResult>;
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean;
}

export const PAYMENTS = Symbol('PAYMENTS');

export function signPaystack(secret: string, rawBody: string | Buffer): string {
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

export class MockPaystackAdapter implements PaymentsAdapter {
  private readonly pending = new Map<string, InitInput>();
  private eventId = 1_000_000;

  constructor(private readonly secret: string, private readonly baseUrl: string) {}

  async initialize(input: InitInput): Promise<InitResult> {
    this.pending.set(input.reference, input);
    if (input.method === 'bank_transfer') {
      return { reference: input.reference, transferAccount: { bankName: 'Wema Bank (mock)', accountNumber: `99${String(Date.now()).slice(-8)}`, accountName: 'ERP / Test User' } };
    }
    return { reference: input.reference, checkoutUrl: `${this.baseUrl}/dev/paystack/checkout/${encodeURIComponent(input.reference)}` };
  }

  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = Buffer.from(signPaystack(this.secret, rawBody), 'hex');
    const got = Buffer.from(signature, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  /** Dev only: what Paystack would POST to our webhook after the customer pays. */
  buildWebhook(reference: string, outcome: 'success' | 'failed', amountOverride?: number): { body: string; signature: string } {
    const init = this.pending.get(reference);
    if (!init) throw new Error(`unknown reference ${reference}`);
    const event: ChargeEvent = {
      event: outcome === 'success' ? 'charge.success' : 'charge.failed',
      data: {
        id: ++this.eventId,
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
