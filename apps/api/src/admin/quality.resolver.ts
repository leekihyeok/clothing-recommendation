import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Args, Context, Field, Float, ID, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { DbService } from '../infra/db.service';
import { MeService, type Request } from '../me/me.service';
import { cleanName } from '../shops/names';
import { DISPLAY_NAME_SQL } from '../shops/shops.resolver';
import { AdminService } from './admin.service';

const VERDICTS = ['good', 'wrong_style', 'wrong_info', 'closed'] as const;
// A shop found wrong is recommended less until the pipeline scores it again.
const WRONG_CONFIDENCE_CAP = 0.3;

@ObjectType()
export class SampleStyle {
  @Field()
  style: string;

  @Field(() => Int)
  score: number;
}

@ObjectType({ description: '표본 확인용 가게 하나: AI가 쓴 소개·점수와 그 근거' })
export class SampleShop {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  category: string;

  @Field({ nullable: true })
  summary?: string;

  @Field({ nullable: true })
  reason?: string;

  @Field(() => [SampleStyle])
  styles: SampleStyle[];

  @Field(() => Float, { nullable: true })
  confidence?: number;

  @Field(() => [String], { description: '근거 글 제목 (최근 3개)' })
  evidence: string[];

  @Field({ nullable: true })
  placeUrl?: string;

  @Field({ nullable: true, description: '이미 매긴 판정' })
  verdict?: string;
}

@ObjectType({ description: '지역별 표본 확인 결과' })
export class QualityStat {
  @Field()
  region: string;

  @Field(() => Int)
  labeled: number;

  @Field(() => Int)
  good: number;

  @Field(() => Int)
  wrongStyle: number;

  @Field(() => Int)
  wrongInfo: number;

  @Field(() => Int)
  closed: number;
}

/**
 * "표본 확인" on /admin: a random sample of scored shops per region with what the AI wrote and the posts it rested
 * on, a verdict per shop, and the accuracy so far. Verdicts act at once (wrong → recommended less, closed → re-check).
 */
@Resolver()
export class QualityResolver {
  constructor(
    private readonly db: DbService,
    private readonly me: MeService,
    private readonly admin: AdminService,
  ) {}

  private async requireAdmin(req: Request): Promise<string> {
    const userId = await this.me.sessionUser(req);
    if (!userId || !(await this.admin.isAdmin(userId))) throw new ForbiddenException('관리자만 할 수 있어요');
    return userId;
  }

  @Query(() => [SampleShop], { description: '관리자: 지역의 채점된 가게 무작위 표본 (아직 판정 안 한 곳 먼저)' })
  async qualitySample(
    @Args('region') region: string,
    @Args('size', { type: () => Int, defaultValue: 10 }) size: number,
    @Context('req') req: Request,
  ): Promise<SampleShop[]> {
    await this.requireAdmin(req);
    const r = await this.db.pool.query(
      `SELECT s.id::text, ${DISPLAY_NAME_SQL} AS name, s.category, s.summary, s.reason_material, s.confidence,
              (SELECT r.payload->>'place_url' FROM raw_sources r WHERE r.shop_id = s.id AND r.source = 'kakao' LIMIT 1) AS place_url,
              (SELECT coalesce(jsonb_agg(jsonb_build_object('style', style_id, 'score', score) ORDER BY score DESC), '[]')
                 FROM shop_style_scores x WHERE x.shop_id = s.id AND x.score >= 5) AS styles,
              (SELECT coalesce(array_agg(t ORDER BY o), '{}') FROM (
                 SELECT f.title AS t, row_number() OVER (ORDER BY f.posted_on DESC NULLS LAST) AS o
                 FROM shop_facts f WHERE f.shop_id = s.id LIMIT 3) e) AS evidence,
              (SELECT q.verdict FROM quality_labels q WHERE q.shop_id = s.id ORDER BY q.created_at DESC LIMIT 1) AS verdict
       FROM shops s
       WHERE s.status = 'candidate' AND s.kind = 'store' AND s.scored_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM regions g WHERE g.name = $1 AND ST_Intersects(g.polygon, s.geom))
       ORDER BY (SELECT count(*) FROM quality_labels q WHERE q.shop_id = s.id) > 0, random()
       LIMIT $2`,
      [region, Math.min(Math.max(size, 1), 30)],
    );
    return r.rows.map((x) => ({
      id: x.id, name: cleanName(x.name), category: x.category, summary: x.summary ?? undefined, reason: x.reason_material ?? undefined,
      styles: x.styles, confidence: x.confidence ?? undefined, evidence: x.evidence, placeUrl: x.place_url ?? undefined, verdict: x.verdict ?? undefined,
    }));
  }

  @Mutation(() => Boolean, { description: '관리자: 표본 판정 good | wrong_style | wrong_info | closed' })
  async labelShop(
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('verdict') verdict: string,
    @Args('note', { type: () => String, nullable: true }) note: string | undefined,
    @Context('req') req: Request,
  ): Promise<boolean> {
    const userId = await this.requireAdmin(req);
    if (!(VERDICTS as readonly string[]).includes(verdict)) throw new BadRequestException('판정은 good, wrong_style, wrong_info, closed 중 하나예요');
    await this.db.pool.query('INSERT INTO quality_labels (shop_id, user_id, verdict, note) VALUES ($1, $2, $3, $4)', [
      shopId, userId, verdict, note?.trim() || null,
    ]);
    if (verdict === 'wrong_style' || verdict === 'wrong_info') {
      await this.db.pool.query('UPDATE shops SET confidence = least(coalesce(confidence, 1), $2) WHERE id = $1', [shopId, WRONG_CONFIDENCE_CAP]);
    }
    if (verdict === 'closed') {
      await this.db.pool.query(`UPDATE shops SET status = 'suspended' WHERE id = $1 AND status = 'candidate'`, [shopId]);
      await this.db.pool.query(`INSERT INTO shop_checks (shop_id, trigger, result, detail) VALUES ($1, 'reports', 'suspended', '{"by":"admin"}')`, [shopId]);
    }
    return true;
  }

  @Query(() => [QualityStat], { description: '관리자: 지역별 표본 확인 결과 (가게마다 마지막 판정)' })
  async qualityStats(@Context('req') req: Request): Promise<QualityStat[]> {
    await this.requireAdmin(req);
    const r = await this.db.pool.query(
      `WITH last AS (
         SELECT DISTINCT ON (shop_id) shop_id, verdict FROM quality_labels ORDER BY shop_id, created_at DESC
       )
       SELECT coalesce(g.name, '(지역 밖)') AS region, count(*)::int AS labeled,
              count(*) FILTER (WHERE verdict = 'good')::int AS good,
              count(*) FILTER (WHERE verdict = 'wrong_style')::int AS wrong_style,
              count(*) FILTER (WHERE verdict = 'wrong_info')::int AS wrong_info,
              count(*) FILTER (WHERE verdict = 'closed')::int AS closed
       FROM last JOIN shops s ON s.id = last.shop_id
       LEFT JOIN LATERAL (SELECT name FROM regions r WHERE ST_Intersects(r.polygon, s.geom) LIMIT 1) g ON true
       GROUP BY 1 ORDER BY labeled DESC`,
    );
    return r.rows.map((x) => ({ region: x.region, labeled: x.labeled, good: x.good, wrongStyle: x.wrong_style, wrongInfo: x.wrong_info, closed: x.closed }));
  }
}
