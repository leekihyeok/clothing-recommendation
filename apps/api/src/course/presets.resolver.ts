import { Args, Context, Field, ID, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { DbService } from '../infra/db.service';
import { MeService, type Request } from '../me/me.service';
import { tasteSummary } from '../me/taste';

const REPEAT_REGION = 0.5;

@ObjectType({ description: '첫 화면의 "이런 코스 어때요" 카드 (pipeline.presets)' })
export class Preset {
  @Field(() => ID)
  id: string;

  @Field()
  title: string;

  @Field({ nullable: true })
  intro?: string;

  @Field(() => ID)
  regionId: string;

  @Field()
  regionName: string;

  @Field(() => [String])
  styles: string[];

  @Field(() => Int)
  stopCount: number;

  @Field(() => Int, { description: '그 지역에서 이 스타일에 맞는 가게 수' })
  fitCount: number;
}

@Resolver(() => Preset)
export class PresetsResolver {
  constructor(
    private readonly db: DbService,
    private readonly me: MeService,
  ) {}

  @Query(() => [Preset], { description: '추천 코스 카드. 내가 좋아한 가게들의 스타일과 맞는 것부터' })
  async presets(@Args('limit', { type: () => Int, defaultValue: 8 }) limit: number, @Context('req') req: Request): Promise<Preset[]> {
    const r = await this.db.pool.query<Preset & { rank: number }>(
      `SELECT p.id::text AS id, p.title, p.intro, p.region_id::text AS "regionId", g.name AS "regionName",
              p.styles, p.stop_count AS "stopCount", p.fit_count AS "fitCount", p.rank
       FROM presets p JOIN regions g ON g.id = p.region_id
       ORDER BY p.rank DESC`,
    );
    const userId = await this.me.userId(req, false);
    const liked = new Set(userId ? tasteSummary((await this.me.personal(userId)).taste).likes.map(([style]) => style) : []);
    // A liked style doubles a preset's rank; a region's second preset counts half, so the first cards show different
    // places without burying a strong second idea under weak ones.
    const seen = new Set<string>();
    const list = r.rows
      .map((p) => {
        const repeat = seen.has(p.regionId);
        seen.add(p.regionId);
        return { p, score: p.rank * (p.styles.some((s) => liked.has(s)) ? 2 : 1) * (repeat ? REPEAT_REGION : 1) };
      })
      .sort((a, b) => b.score - a.score)
      .map(({ p }) => ({ ...p, intro: p.intro ?? undefined }));
    return list.slice(0, Math.min(Math.max(limit, 1), 30));
  }
}
