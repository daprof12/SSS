import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { CONFIG, type AppConfig } from './config';

export interface IncidentChanged {
  incidentId: string;
  kind: string;
  at: string;
}

const CHANNEL = 'erp_incident';

/**
 * Event bus for live updates. Listeners on this instance hear an event at once; other API
 * instances hear it through PostgreSQL LISTEN/NOTIFY, so a live stream works whichever instance
 * the load balancer sent it to. Tests stay in-process.
 */
@Injectable()
export class Bus implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Bus');
  private readonly emitter = new EventEmitter().setMaxListeners(10_000);
  private readonly origin = randomUUID();
  private listener?: pg.Client;
  private sender?: pg.Pool;
  private retry?: NodeJS.Timeout;
  private stopped = false;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  onModuleInit() {
    if (this.config.env === 'test') return;
    this.sender = new pg.Pool({ connectionString: this.config.databaseUrl, max: 2 });
    this.sender.on('error', (e) => this.log.warn(`notify pool: ${e.message}`));
    void this.listen();
  }

  private async listen() {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.config.databaseUrl, keepAlive: true });
    const again = () => {
      if (this.listener !== client) return;
      this.listener = undefined;
      client.end().catch(() => {});
      if (!this.stopped) this.retry = setTimeout(() => void this.listen(), 2000);
    };
    this.listener = client;
    client.on('error', again);
    client.on('end', again);
    client.on('notification', (m) => {
      if (m.channel !== CHANNEL || !m.payload) return;
      try {
        const { o, e } = JSON.parse(m.payload) as { o: string; e: IncidentChanged };
        if (o !== this.origin) this.emitter.emit(`incident:${e.incidentId}`, e);
      } catch {
        // Not ours.
      }
    });
    try {
      await client.connect();
      await client.query(`listen ${CHANNEL}`);
    } catch (e) {
      this.log.warn(`listen: ${(e as Error).message}`);
      again();
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.retry);
    await this.listener?.end().catch(() => {});
    await this.sender?.end().catch(() => {});
  }

  publishIncident(e: IncidentChanged) {
    this.emitter.emit(`incident:${e.incidentId}`, e);
    this.sender?.query('select pg_notify($1, $2)', [CHANNEL, JSON.stringify({ o: this.origin, e })]).catch((x) => this.log.warn(`notify: ${x.message}`));
  }

  onIncident(incidentId: string, fn: (e: IncidentChanged) => void): () => void {
    const key = `incident:${incidentId}`;
    this.emitter.on(key, fn);
    return () => this.emitter.off(key, fn);
  }
}
