// Web push delivery. Every notification the platform writes (offers, direct assignments, "officer
// needs help", report updates…) is picked up from the database within a couple of seconds and pushed
// to the person's devices. Durable like the incident sweep: a restart loses nothing, and several
// servers share the work (rows are claimed with "for update skip locked").
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PUSH, PushSendError, type PushAdapter } from '../adapters/push';
import { CONFIG, type AppConfig } from '../core/config';
import { Db } from '../core/db';
import { AppError } from '../core/http';

/** Groups that are pushed unless the person turned push off for them; dispatch and safety always are. */
const ALWAYS = ['dispatch', 'safety', 'account', 'money'];
const QUIET_BY_DEFAULT = ['marketing', 'learn'];
/** Older than this, a notification is not worth an alert any more (an offer is long gone). */
const STALE_MIN = 10;

@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Push');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PUSH) private readonly push: PushAdapter,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    if (this.config.env === 'test') return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.deliverPending()
        .catch((e) => this.log.error(`deliver: ${e.message}`))
        .finally(() => (this.running = false));
    }, Number(process.env.PUSH_POLL_MS ?? 1500));
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  publicKey() {
    return { publicKey: this.push.publicKey, enabled: !!this.push.publicKey };
  }

  async subscribe(userId: string, b: { endpoint: string; keys: { p256dh: string; auth: string }; label?: string }) {
    if (!this.push.publicKey) throw new AppError(409, 'push_off', 'Alerts are not set up on this server yet.');
    // One device belongs to one person: signing in as someone else on it moves it to them.
    await this.db.query(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth, label) values ($1, $2, $3, $4, $5)
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, failures = 0`,
      [userId, b.endpoint, b.keys.p256dh, b.keys.auth, b.label ?? null],
    );
    return this.status(userId);
  }

  async unsubscribe(userId: string, endpoint: string) {
    await this.db.query(`delete from push_subscriptions where user_id = $1 and endpoint = $2`, [userId, endpoint]);
    return this.status(userId);
  }

  async status(userId: string) {
    const r = (await this.db.query(`select count(*)::int as n, max(last_ok_at) as last from push_subscriptions where user_id = $1`, [userId])).rows[0];
    return { enabled: !!this.push.publicKey, devices: r.n as number, lastDeliveredAt: r.last };
  }

  /** "Send a test alert" from the settings screen. */
  async test(userId: string) {
    await this.db.query(`insert into notifications (user_id, type, grp, channel, title, body, deep_link) values ($1, 'push_test', 'account', 'in_app', 'Alerts are on', 'This is how offers and alerts will reach you when the app is closed.', null)`, [userId]);
    return { message: 'Test alert sent. It should appear in a few seconds.' };
  }

  /** Claims unsent notifications and pushes each to the person's devices. Returns how many were pushed. */
  async deliverPending(limit = 100): Promise<number> {
    const due = await this.db.tx(async (c) => {
      const rows = (
        await c.query(
          `select n.id, n.user_id, n.type, n.grp, n.title, n.body, n.deep_link, n.sent_at
             from notifications n where n.pushed_at is null order by n.sent_at limit $1 for update skip locked`,
          [limit],
        )
      ).rows;
      if (rows.length) await c.query(`update notifications set pushed_at = now() where id = any($1::uuid[])`, [rows.map((r) => r.id)]);
      return rows;
    });
    if (!due.length || !this.push.publicKey) return 0;
    const users = [...new Set(due.map((n) => n.user_id))];
    const subs = (await this.db.query(`select id, user_id, endpoint, p256dh, auth from push_subscriptions where user_id = any($1::uuid[])`, [users])).rows;
    const prefs = (await this.db.query(`select user_id, grp, enabled from notification_prefs where user_id = any($1::uuid[]) and channel = 'push'`, [users])).rows;
    const pref = (u: string, g: string) => prefs.find((p) => p.user_id === u && p.grp === g)?.enabled;
    let sent = 0;
    for (const n of due) {
      if (Date.now() - +new Date(n.sent_at) > STALE_MIN * 60_000) continue;
      const on = ALWAYS.includes(n.grp) || (pref(n.user_id, n.grp) ?? !QUIET_BY_DEFAULT.includes(n.grp));
      if (!on) continue;
      const payload = {
        title: n.title,
        body: n.body,
        link: n.deep_link,
        tag: `${n.type}:${n.deep_link ?? n.id}`,
        urgent: n.grp === 'dispatch' || n.grp === 'safety',
      };
      for (const s of subs.filter((x) => x.user_id === n.user_id)) {
        try {
          await this.push.send(s, payload);
          await this.db.query(`update push_subscriptions set last_ok_at = now(), failures = 0 where id = $1`, [s.id]);
          sent++;
        } catch (e) {
          // The browser dropped it: forget it. Anything else: count, and give up after many failures.
          if (e instanceof PushSendError && e.gone) await this.db.query(`delete from push_subscriptions where id = $1`, [s.id]);
          else {
            const f = (await this.db.query(`update push_subscriptions set failures = failures + 1 where id = $1 returning failures`, [s.id])).rows[0]?.failures ?? 0;
            if (f >= 20) await this.db.query(`delete from push_subscriptions where id = $1`, [s.id]);
          }
          this.log.warn(`push to ${s.id}: ${(e as Error).message}`);
        }
      }
    }
    return sent;
  }
}
