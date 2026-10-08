import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

@Injectable()
export class DbService implements OnModuleDestroy {
  // Connects lazily, so the API still boots (and reports the DB as down) when Postgres is unreachable.
  readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.get<string>('DATABASE_URL'),
      max: 10,
      connectionTimeoutMillis: 3000,
    });
    // Without this an idle-client error would crash the process.
    this.pool.on('error', () => undefined);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
