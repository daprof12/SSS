import { Inject, Injectable } from '@nestjs/common';
import { Db, type Queryable } from './db';

export interface AuditEntry {
  actorId: string | null;
  actorRole?: string;
  action: string;
  entity: string;
  entityId?: string;
  reason?: string;
  ip?: string;
  payload?: Record<string, unknown>;
}

/** Writes to the hash-chained audit_log. Pass the transaction client to log atomically. */
@Injectable()
export class Audit {
  constructor(@Inject(Db) private readonly db: Db) {}

  async write(e: AuditEntry, client: Queryable = this.db.pool): Promise<void> {
    await client.query(
      `insert into audit_log (actor_id, actor_role, action, entity, entity_id, reason, ip, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [e.actorId, e.actorRole ?? null, e.action, e.entity, e.entityId ?? null, e.reason ?? null, e.ip ?? null, e.payload ?? {}],
    );
  }
}
