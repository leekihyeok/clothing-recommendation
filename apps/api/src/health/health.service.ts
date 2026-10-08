import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CATALOG_VERSION } from '@cr/shared';
import { DbService } from '../infra/db.service';
import { ModelClient } from '../infra/model.client';
import { RedisService } from '../infra/redis.service';
import { WalkService } from '../infra/walk.service';
import { Health, ServiceStatus } from './health.model';

interface ModelHealth {
  status: string;
  catalogVersion: number;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly model: ModelClient,
    private readonly config: ConfigService,
    private readonly walk: WalkService,
  ) {}

  async check(): Promise<Health> {
    const [db, postgis, redis, model, ai] = await Promise.all([
      this.probe(async () => {
        const { rows } = await this.db.pool.query<{ version: string }>("SELECT current_setting('server_version') AS version");
        return `PostgreSQL ${rows[0].version}`;
      }),
      this.probe(async () => {
        const { rows } = await this.db.pool.query<{ version: string | null }>(
          "SELECT extversion AS version FROM pg_extension WHERE extname = 'postgis'",
        );
        if (!rows[0]) throw new Error('postgis 확장이 설치되지 않음');
        return `PostGIS ${rows[0].version}`;
      }),
      this.probe(async () => {
        if (this.redis.client.status === 'wait') await this.redis.client.connect();
        return `PING ${await this.redis.client.ping()}`;
      }),
      this.probe(async () => {
        const body = await this.model.get<ModelHealth>('/health');
        // Both sides read packages/shared/catalog.json; a mismatch means one of them is running stale code.
        if (body.catalogVersion !== CATALOG_VERSION) {
          throw new Error(`catalog 버전 불일치: api=${CATALOG_VERSION}, model=${body.catalogVersion}`);
        }
        return `catalog v${body.catalogVersion}`;
      }),
      this.probe(async () => {
        const provider = this.config.get<string>('AI_PROVIDER') || 'gemini';
        const keyVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
        if (!this.config.get<string>(keyVar)) throw new Error(`${keyVar}가 비어 있음`);
        // The model service makes the calls and logs each one; count today's (KST) rows.
        const { rows } = await this.db.pool.query<{ calls: number; failed: number }>(
          `SELECT count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed FROM llm_calls
           WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'`,
        );
        return `${provider} · 오늘 ${rows[0].calls}회 호출${rows[0].failed ? ` (실패 ${rows[0].failed})` : ''}`;
      }),
    ]);

    const walk = this.walk.enabled
      ? { ok: true, detail: 'T맵 보행자 경로' }
      : { ok: false, detail: 'TMAP_APP_KEY 없음: 직선 × 1.3으로 대신 계산' };
    return { api: { ok: true, detail: `catalog v${CATALOG_VERSION}` }, db, postgis, redis, model, ai, walk };
  }

  private async probe(fn: () => Promise<string>): Promise<ServiceStatus> {
    try {
      return { ok: true, detail: await fn() };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
