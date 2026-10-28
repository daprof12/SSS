// The real Paystack adapter against a stand-in for api.paystack.co: request shapes, where people come
// back to, how failures are told apart, webhook signatures, and which adapter runs where.
import { describe, expect, it } from 'vitest';
import { MockPaystackAdapter, newReference, PaystackAdapter, paymentsFromEnv, signPaystack } from '../src/adapters/payments';

type Call = { method: string; url: string; auth: string | null; body: Record<string, unknown> | null };
function fakePaystack(replies: Array<{ status: number; body: unknown } | 'network'>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    calls.push({ method: String(init.method), url, auth: h.get('authorization'), body: init.body ? JSON.parse(String(init.body)) : null });
    const r = replies.shift() ?? { status: 500, body: {} };
    if (r === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const cfg = { secretKey: 'sk_test_abc123', appUrl: 'https://app.erp.ng', dashboardUrl: 'https://dashboard.erp.ng' };

describe('Paystack adapter', () => {
  it('opens Paystack checkout for the chosen method and sends people back to the right app', async () => {
    const p = fakePaystack([
      { status: 200, body: { status: true, message: 'Authorization URL created', data: { authorization_url: 'https://checkout.paystack.com/0peioxfhpn', access_code: '0peioxfhpn', reference: 'wal_1' } } },
      { status: 200, body: { status: true, data: { authorization_url: 'https://checkout.paystack.com/x2' } } },
    ]);
    const a = new PaystackAdapter(cfg, p.impl);
    const r = await a.initialize({ reference: 'wal_1', amountKobo: 500_000, email: 'ada@example.com', method: 'bank_transfer', metadata: { purpose: 'wallet_fund' } });
    expect(r).toEqual({ reference: 'wal_1', checkoutUrl: 'https://checkout.paystack.com/0peioxfhpn' });
    expect(p.calls[0]).toEqual({
      method: 'POST',
      url: 'https://api.paystack.co/transaction/initialize',
      auth: 'Bearer sk_test_abc123',
      body: { email: 'ada@example.com', amount: 500_000, currency: 'NGN', reference: 'wal_1', channels: ['bank_transfer'], callback_url: 'https://app.erp.ng/pay/return', metadata: { purpose: 'wallet_fund' } },
    });
    await a.initialize({ reference: 'agi_1', amountKobo: 1, email: 'x@agency.ng', method: 'card', metadata: { purpose: 'agency_invoice' } });
    expect(p.calls[1]!.body!.callback_url).toBe('https://dashboard.erp.ng/agency/billing?paid=1');
  });

  it('checks a bank account: a name, no such account (null), or a Paystack problem (error)', async () => {
    const p = fakePaystack([
      { status: 200, body: { status: true, data: { account_number: '0123456789', account_name: 'ADA OBI', bank_id: 9 } } },
      { status: 422, body: { status: false, message: 'Could not resolve account name. Check parameters or try again.' } },
      { status: 500, body: { status: false, message: 'Internal error' } },
    ]);
    const a = new PaystackAdapter(cfg, p.impl);
    expect(await a.resolveAccount('058', '0123456789')).toEqual({ accountName: 'ADA OBI' });
    expect(p.calls[0]!.url).toBe('https://api.paystack.co/bank/resolve?account_number=0123456789&bank_code=058');
    expect(await a.resolveAccount('058', '0000000000')).toBeNull();
    await expect(a.resolveAccount('058', '0123456789')).rejects.toThrow('resolve: Internal error');
  });

  it('creates a recipient and sends a transfer from the balance', async () => {
    const p = fakePaystack([
      { status: 201, body: { status: true, data: { recipient_code: 'RCP_t0ya41mp35flk40' } } },
      { status: 200, body: { status: true, message: 'Transfer has been queued', data: { transfer_code: 'TRF_1ptvuv321ahaa7q', status: 'pending' } } },
      { status: 400, body: { status: false, message: 'Your balance is not enough to fulfil this request' } },
    ]);
    const a = new PaystackAdapter(cfg, p.impl);
    expect(await a.createRecipient({ name: 'Ada Obi', accountNumber: '0123456789', bankCode: '058' })).toEqual({ recipientCode: 'RCP_t0ya41mp35flk40' });
    expect(p.calls[0]!.body).toEqual({ type: 'nuban', name: 'Ada Obi', account_number: '0123456789', bank_code: '058', currency: 'NGN' });
    const ref = newReference('wal');
    expect(await a.transfer({ reference: ref, amountKobo: 250_000, recipientCode: 'RCP_t0ya41mp35flk40', reason: 'ERP wallet withdrawal' })).toEqual({ transferCode: 'TRF_1ptvuv321ahaa7q' });
    expect(p.calls[1]!.body).toEqual({ source: 'balance', amount: 250_000, recipient: 'RCP_t0ya41mp35flk40', reason: 'ERP wallet withdrawal', reference: ref, currency: 'NGN' });
    await expect(a.transfer({ reference: ref, amountKobo: 1, recipientCode: 'RCP_x', reason: 'x' })).rejects.toThrow(/balance is not enough/);
  });

  it('makes references Paystack accepts for transfers: lowercase, digits and _, 16 to 50 long', () => {
    const r = newReference('WAL');
    expect(r).toMatch(/^[a-z0-9_]{16,50}$/);
  });

  it('accepts only webhooks signed with the secret key', () => {
    const a = new PaystackAdapter(cfg);
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'wal_1' } }));
    expect(a.verifySignature(body, signPaystack('sk_test_abc123', body))).toBe(true);
    expect(a.verifySignature(body, signPaystack('sk_test_other', body))).toBe(false);
    expect(a.verifySignature(body, undefined)).toBe(false);
  });

  it('runs Paystack with a real key, the mock otherwise; production needs a live key', () => {
    expect(paymentsFromEnv('development', 'sk_test_mock', {}, 'http://localhost:4000')).toBeInstanceOf(MockPaystackAdapter);
    expect(paymentsFromEnv('development', 'sk_test_real1', {}, 'x')).toBeInstanceOf(PaystackAdapter);
    expect(paymentsFromEnv('test', 'sk_test_real1', {}, 'x')).toBeInstanceOf(MockPaystackAdapter);
    expect(paymentsFromEnv('production', 'sk_live_abc', {}, 'x')).toBeInstanceOf(PaystackAdapter);
    expect(() => paymentsFromEnv('production', '', {}, 'x')).toThrow(/PAYSTACK_SECRET/);
    expect(() => paymentsFromEnv('production', 'sk_test_abc', {}, 'x')).toThrow(/test key/);
    expect(paymentsFromEnv('production', 'sk_test_abc', { PAYSTACK_ALLOW_TEST: '1' }, 'x')).toBeInstanceOf(PaystackAdapter);
  });
});
