// WhatsApp adapter for staff who opted in (board "Station messages": WhatsApp, staff who opted in).
// Production uses the WhatsApp Business API with an approved template; the mock keeps an outbox.

export interface WhatsAppMessage {
  to: string;
  body: string;
}

export interface WhatsAppAdapter {
  send(msg: WhatsAppMessage): Promise<{ id: string }>;
}

export const WHATSAPP = Symbol('WHATSAPP');

export class MockWhatsAppAdapter implements WhatsAppAdapter {
  readonly outbox: Array<WhatsAppMessage & { id: string; at: string }> = [];

  async send(msg: WhatsAppMessage) {
    if (!/^\+234\d{10}$/.test(msg.to)) throw new Error('Not a Nigerian WhatsApp number.');
    const id = `wa_${this.outbox.length + 1}`;
    this.outbox.push({ ...msg, id, at: new Date().toISOString() });
    return { id };
  }
}
