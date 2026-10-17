// SMS adapter. Real provider needs a registered sender ID and the DND list
// (Public Issues doc §4). The mock keeps an outbox for tests and the dev panel.

export interface SmsMessage {
  to: string;
  body: string;
  /** Emergency and security messages ignore quiet hours and DND. */
  urgent: boolean;
}

export interface SmsAdapter {
  send(msg: SmsMessage): Promise<{ id: string }>;
}

export const SMS = Symbol('SMS');

export class MockSmsAdapter implements SmsAdapter {
  readonly outbox: Array<SmsMessage & { id: string; at: string }> = [];

  async send(msg: SmsMessage) {
    if (!/^\+234\d{10}$/.test(msg.to)) throw new Error('Enter a Nigerian phone number.');
    // SMS bodies stay short: one segment where possible.
    const body = msg.body.length > 160 ? `${msg.body.slice(0, 157)}...` : msg.body;
    const id = `sms_${this.outbox.length + 1}`;
    this.outbox.push({ ...msg, body, id, at: new Date().toISOString() });
    return { id };
  }
}
