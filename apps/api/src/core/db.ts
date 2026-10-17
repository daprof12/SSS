import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { CONFIG, type AppConfig } from './config';

// Return bigint columns (kobo sums) as numbers; amounts stay well inside 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool: pg.Pool;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  }

  query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
    return this.pool.query<T>(sql, params);
  }

  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

export type Queryable = Pick<pg.PoolClient, 'query'>;
