import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Args, Context, Field, ID, InputType, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { STYLE_IDS } from '@cr/shared';
import { DbService } from '../infra/db.service';
import { EventsService } from '../infra/events.service';
import { RateLimitService } from '../infra/rate-limit.service';
import { MeService, type Request } from '../me/me.service';
import { Course } from './course.model';
import { LatLng } from '../regions/regions.resolver';
import { CourseService } from './course.service';

const MAX_MEMBERS = 6;
const BUDGET_ORDER = ['low', 'mid', 'high'];

@ObjectType({ description: '같이 가는 사람 한 명의 취향' })
export class GroupMember {
  @Field()
  name: string;

  @Field(() => [String])
  styles: string[];

  @Field({ description: 'any | men | women' })
  gender: string;

  @Field({ description: 'any | low | mid | high' })
  budget: string;
}

@ObjectType({ description: '같이 가기: 친구들이 취향을 넣으면 모두에게 맞게 다시 짠다' })
export class CourseGroup {
  @Field(() => ID)
  id: string;

  @Field(() => ID, { description: '처음 코스' })
  baseCourseId: string;

  @Field({ nullable: true, description: '코스 지역 이름' })
  regionName?: string;

  @Field(() => ID, { nullable: true, description: '코스 지역 (지도를 거기로)' })
  regionId?: string;

  @Field(() => LatLng, { nullable: true, description: '처음 코스의 출발점 (지역이 없을 때 지도를 거기로)' })
  origin?: LatLng;

  @Field(() => [GroupMember], { description: '첫 번째가 만든 사람' })
  members: GroupMember[];

  @Field(() => ID, { nullable: true, description: '모두의 취향으로 가장 최근에 짠 코스' })
  resultCourseId?: string;

  @Field()
  updatedAt: Date;
}

@InputType()
export class GroupMemberInput {
  @Field({ nullable: true, description: '이름 (비우면 "친구 2" …)' })
  name?: string;

  @Field(() => [String], { nullable: true })
  styles?: string[];

  @Field({ nullable: true })
  gender?: string;

  @Field({ nullable: true })
  budget?: string;
}

interface Member extends GroupMember {
  joinedAt: string;
}

interface Row {
  id: string;
  base_course_id: string;
  region_id: string | null;
  origin: { lat: number; lng: number } | null;
  members: Member[];
  result_course_id: string | null;
  updated_at: Date;
  region_name: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(m: GroupMemberInput, fallbackName: string): Member {
  return {
    name: m.name?.trim().slice(0, 12) || fallbackName,
    styles: [...new Set((m.styles ?? []).filter((s) => STYLE_IDS.includes(s)))].slice(0, 5),
    gender: m.gender === 'men' || m.gender === 'women' ? m.gender : 'any',
    budget: BUDGET_ORDER.includes(m.budget ?? '') ? m.budget! : 'any',
    joinedAt: new Date().toISOString(),
  };
}

/**
 * Everyone's taste in one request: each person's styles weigh the same in total (one style = 1, two = 0.5 each …),
 * the strongest style ends up at 1. One gender if everyone wants the same, else either. The cheapest budget anyone
 * asked for (everyone can afford it).
 */
export function mergeTastes(members: Member[]): { styles: { id: string; weight: number }[]; gender?: string; budget?: string } {
  const w = new Map<string, number>();
  for (const m of members) for (const s of m.styles) w.set(s, (w.get(s) ?? 0) + 1 / m.styles.length);
  const top = Math.max(0, ...w.values());
  const styles = [...w.entries()].map(([id, x]) => ({ id, weight: Math.round((x / top) * 100) / 100 })).sort((a, b) => b.weight - a.weight).slice(0, 6);
  const genders = new Set(members.map((m) => m.gender).filter((g) => g !== 'any'));
  const budgets = members.map((m) => m.budget).filter((b) => b !== 'any').sort((a, b) => BUDGET_ORDER.indexOf(a) - BUDGET_ORDER.indexOf(b));
  return { styles, gender: genders.size === 1 ? [...genders][0] : undefined, budget: budgets[0] };
}

@Resolver(() => CourseGroup)
export class CourseGroupResolver {
  constructor(
    private readonly db: DbService,
    private readonly courses: CourseService,
    private readonly me: MeService,
    private readonly events: EventsService,
    private readonly limits: RateLimitService,
  ) {}

  private async row(id: string): Promise<Row> {
    if (!UUID.test(id)) throw new NotFoundException('같이 가기 링크를 찾지 못했어요');
    const r = await this.db.pool.query<Row>(
      `SELECT g.id::text, g.base_course_id::text, g.members, g.result_course_id::text, g.updated_at, c.request->>'regionName' AS region_name,
              c.request->>'regionId' AS region_id, c.request->'origin' AS origin
       FROM course_groups g JOIN courses c ON c.id = g.base_course_id WHERE g.id = $1`,
      [id],
    );
    if (!r.rows[0]) throw new NotFoundException('같이 가기 링크를 찾지 못했어요');
    return r.rows[0];
  }

  private toGroup(r: Row): CourseGroup {
    return {
      id: r.id, baseCourseId: r.base_course_id, regionName: r.region_name ?? undefined, regionId: r.region_id ?? undefined,
      origin: r.origin ? { lat: r.origin.lat, lng: r.origin.lng } : undefined,
      members: r.members.map(({ joinedAt: _j, ...m }) => m), resultCourseId: r.result_course_id ?? undefined, updatedAt: r.updated_at,
    };
  }

  @Query(() => CourseGroup, { description: '같이 가기 (링크 ?g=)' })
  async courseGroup(@Args('id', { type: () => ID }) id: string): Promise<CourseGroup> {
    return this.toGroup(await this.row(id));
  }

  @Mutation(() => CourseGroup, { description: '같이 가기 시작: 이 코스의 조건과 내 취향(코스의 스타일·누구 옷·예산)으로 링크를 만든다' })
  async startCourseGroup(
    @Args('courseId', { type: () => ID }) courseId: string,
    @Args('name', { nullable: true, type: () => String }) name: string | undefined,
    @Context('req') req: Request,
  ): Promise<CourseGroup> {
    const course = await this.courses.load(courseId);
    if (!course) throw new BadRequestException('코스를 찾지 못했어요');
    const q = course.request;
    const first = clean({ name, styles: q.styles, gender: q.gender, budget: q.budget }, '친구');
    const userId = await this.me.userId(req, false);
    await this.limits.hit('group', req, userId);
    const r = await this.db.pool.query<{ id: string }>(
      `INSERT INTO course_groups (base_course_id, created_by, members) VALUES ($1, $2, $3) RETURNING id::text`,
      [courseId, userId, JSON.stringify([first])],
    );
    this.events.record('share', { userId, courseId, data: { group: true } });
    return this.toGroup(await this.row(r.rows[0].id));
  }

  @Mutation(() => Course, { description: '같이 가기에 내 취향 넣기: 모두의 취향을 섞어 같은 동네·시간·고정 가게로 다시 짠 코스' })
  async joinCourseGroup(
    @Args('id', { type: () => ID }) id: string,
    @Args('member') member: GroupMemberInput,
    @Context('req') req: Request,
  ): Promise<Course> {
    // Each join plans a whole course, so it counts as a plan.
    await this.limits.hit('plan', req, await this.me.userId(req, false));
    const g = await this.row(id);
    if (g.members.length >= MAX_MEMBERS) throw new BadRequestException(`같이 가기는 ${MAX_MEMBERS}명까지예요`);
    const members = [...g.members, clean(member, `친구 ${g.members.length}`)];
    const { input, names } = await this.courses.groupRequest(g.base_course_id, mergeTastes(members), members.map((m) => m.name));
    // Nobody's own history steers a shared course (it's everyone's), so it's planned without a user.
    const course = await this.courses.plan(input, null);
    await this.courses.markGroup(course.id, id, names);
    await this.db.pool.query('UPDATE course_groups SET members = $2, result_course_id = $3, updated_at = now() WHERE id = $1', [
      id, JSON.stringify(members), course.id,
    ]);
    this.events.record('plan', { userId: await this.me.userId(req, false), courseId: course.id, data: { mode: 'group', members: members.length } });
    return this.courses.localize({ ...course, request: { ...course.request, groupId: id, groupNames: names } });
  }
}
