import { Args, Context, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { EventsService } from '../infra/events.service';
import { RateLimitService } from '../infra/rate-limit.service';
import { MeService, type Request } from '../me/me.service';
import { Course, CourseEditInput, CourseEditResult, CourseRequestInput, LatLngInput, PinnedShop, TransitRoute } from './course.model';
import { Field, ObjectType } from '@nestjs/graphql';
import { CourseService } from './course.service';

@ObjectType()
export class PinResult {
  @Field(() => ID, { description: '고정을 바꾼 코스 (공유받은 코스면 새 사본)' })
  courseId: string;

  @Field(() => [PinnedShop])
  mustShops: PinnedShop[];
}

@Resolver(() => Course)
export class CourseResolver {
  constructor(
    private readonly courses: CourseService,
    private readonly me: MeService,
    private readonly events: EventsService,
    private readonly limits: RateLimitService,
  ) {}

  @Mutation(() => Course, { description: '요청서로 코스를 짠다 (추천 + 대안 최대 2개)' })
  async planCourse(@Args('request') request: CourseRequestInput, @Context('req') req: Request): Promise<Course> {
    const userId = await this.owner(req);
    await this.limits.hit('plan', req, userId);
    return this.events.timed(
      'plan',
      { userId, data: { mode: request.inputMode ?? 'buttons' } },
      () => this.courses.plan(request, userId).then((c) => this.courses.localize(c)),
      (c) => ({ courseId: c.id, data: { stops: c.variants[0]?.stops.length ?? 0 } }),
    );
  }

  @Mutation(() => CourseEditResult, { description: '코스 한 버전을 고친다 (빼기, 다른 가게로, 옮기기, 더 넣기, 다시 짜기)' })
  async editCourse(
    @Args('courseId', { type: () => ID }) courseId: string,
    @Args('variant', { type: () => Int }) variant: number,
    @Args('edit') edit: CourseEditInput,
    @Args('stopIds', { type: () => [ID], nullable: true, description: '화면에 보이는 가게 순서 (되돌리기 뒤에도 맞게)' })
    stopIds: string[] | undefined,
    @Context('req') req: Request,
  ): Promise<CourseEditResult> {
    const userId = await this.owner(req);
    await this.limits.hit('edit', req, userId);
    return this.events.timed(
      'edit',
      { userId, courseId, data: { op: edit.op } },
      () => this.courses.edit(courseId, variant, edit, stopIds, userId).then((r) => this.courses.localizeEdit(r)),
      (r) => ({ courseId: r.courseId }),
    );
  }

  @Mutation(() => CourseEditResult, { description: '말로 코스 고치기 ("3번 빼고 신발 가게로", "좀 더 가깝게")' })
  async editCourseByText(
    @Args('courseId', { type: () => ID }) courseId: string,
    @Args('variant', { type: () => Int }) variant: number,
    @Args('text') text: string,
    @Args('stopIds', { type: () => [ID], nullable: true }) stopIds: string[] | undefined,
    @Context('req') req: Request,
  ): Promise<CourseEditResult> {
    const userId = await this.owner(req);
    await this.limits.hit('ai', req, userId);
    return this.events.timed(
      'edit_text',
      { userId, courseId, data: { chars: text.trim().length } },
      () => this.courses.editByText(courseId, variant, text, stopIds, userId).then((r) => this.courses.localizeEdit(r)),
      (r) => ({ courseId: r.courseId }),
    );
  }

  @Mutation(() => Boolean, { description: '걷기를 마친 코스 평가: rating 1 좋았어요 · 0 그저 그랬어요 · -1 별로였어요, note 한 줄 (300자)' })
  async rateCourse(
    @Args('courseId', { type: () => ID }) courseId: string,
    @Args('rating', { type: () => Int }) rating: number,
    @Args('note', { type: () => String, nullable: true }) note: string | undefined,
    @Context('req') req: Request,
  ): Promise<boolean> {
    const userId = (await this.me.userId(req, true))!;
    await this.limits.hit('record', req, userId);
    return this.courses.rate(courseId, userId, rating, note);
  }

  @Mutation(() => CourseEditResult, { description: '되돌리기: 이 버전의 마지막 고치기 전으로 (서버에도 저장, 새로고침해도 그대로)' })
  async undoCourseEdit(
    @Args('courseId', { type: () => ID }) courseId: string,
    @Args('variant', { type: () => Int }) variant: number,
    @Context('req') req: Request,
  ): Promise<CourseEditResult> {
    const userId = await this.owner(req);
    await this.limits.hit('edit', req, userId);
    return this.courses.undo(courseId, variant, userId).then((r) => this.courses.localizeEdit(r));
  }

  @Mutation(() => CourseEditResult, { description: '쉬어 가는 곳 넣기·빼기: kind = cafe | food (카카오 검색으로 코스 중간 근처)' })
  async setCourseBreak(
    @Args('courseId', { type: () => ID }) courseId: string,
    @Args('variant', { type: () => Int }) variant: number,
    @Args('kind') kind: string,
    @Args('on') on: boolean,
    @Args('stopIds', { type: () => [ID], nullable: true }) stopIds: string[] | undefined,
    @Args('avoid', { type: () => [String], nullable: true, description: '다른 곳으로: 이미 넘긴 장소 이름' }) avoid: string[] | undefined,
    @Context('req') req: Request,
  ): Promise<CourseEditResult> {
    const userId = await this.owner(req);
    await this.limits.hit('edit', req, userId);
    return this.events.timed(
      'edit',
      { userId, courseId, data: { op: `break:${kind}:${on ? (avoid?.length ? 'swap' : 'on') : 'off'}` } },
      () => this.courses.setBreak(courseId, variant, kind as 'cafe' | 'food', on, stopIds, userId, avoid ?? []).then((r) => this.courses.localizeEdit(r)),
      (r) => ({ courseId: r.courseId }),
    );
  }

  @Mutation(() => PinResult, { description: '코스 카드의 고정: 다른 코스·다시 짜기에도 이 가게를 넣는다 (최대 8곳)' })
  async pinCourseShop(
    @Args('courseId', { type: () => ID }) courseId: string,
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('on') on: boolean,
    @Context('req') req: Request,
  ): Promise<PinResult> {
    const userId = await this.owner(req);
    await this.limits.hit('edit', req, userId);
    return this.courses.pin(courseId, shopId, on, userId);
  }

  /**
   * Walk mode (걷기 모드) on the phone: started and finished, with how many stops were confirmed. Only these counts are
   * kept — never the position (the client follows it on the device). Arrivals themselves are 다녀왔어요 visits.
   */
  @Mutation(() => Boolean, { description: '걷기 모드 시작·끝 (통계용, 위치는 보내지 않음): action = start | finish' })
  async walkEvent(
    @Args('courseId', { type: () => ID }) courseId: string,
    @Args('action') action: string,
    @Args('arrived', { type: () => Int, nullable: true }) arrived: number | undefined,
    @Args('stops', { type: () => Int, nullable: true }) stops: number | undefined,
    @Context('req') req: Request,
  ): Promise<boolean> {
    if (!['start', 'finish'].includes(action) || !/^[0-9a-f-]{36}$/i.test(courseId)) return false;
    const userId = await this.me.userId(req, false);
    this.events.record('walk', { userId, courseId, data: { action, arrived: arrived ?? null, stops: stops ?? null } });
    return true;
  }

  @Mutation(() => ID, { description: '화면의 코스 버전을 고정 사본으로 저장하고 공유 링크용 id를 준다' })
  async shareCourse(
    @Args('courseId', { type: () => ID }) courseId: string,
    @Args('variant', { type: () => Int }) variant: number,
    @Args('stopIds', { type: () => [ID], nullable: true }) stopIds: string[] | undefined,
    @Context('req') req: Request,
  ): Promise<string> {
    return this.events.timed(
      'share',
      { userId: await this.me.userId(req, false), courseId },
      () => this.courses.share(courseId, variant, stopIds),
      (shareId) => ({ data: { shareId } }),
    );
  }

  @Query(() => Course, { nullable: true, description: '저장된 코스 (공유 링크, 지난 코스 다시 열기)' })
  async course(@Args('id', { type: () => ID }) id: string, @Context('req') req: Request): Promise<Course | null> {
    const viewer = await this.me.userId(req, false);
    const c = await this.courses.load(id, viewer);
    if (c) this.events.record(c.shared ? 'share_open' : 'reopen', { userId: viewer, courseId: c.id });
    return c ? this.courses.localize(c) : c;
  }

  @Query(() => [Course], { description: '내가 짠 최근 코스 ("지난번처럼")' })
  async myCourses(@Args('limit', { type: () => Int, defaultValue: 10 }) limit: number, @Context('req') req: Request): Promise<Course[]> {
    const userId = await this.me.userId(req, false);
    return userId ? this.courses.localizeMany(await this.courses.recent(userId, limit)) : [];
  }

  @Mutation(() => ID, { description: '코스 저장 (마이페이지). 남의 코스·공유받은 코스는 내 사본으로 저장하고 그 id를 준다. 로그인 필요' })
  async saveCourse(@Args('courseId', { type: () => ID }) courseId: string, @Context('req') req: Request): Promise<string> {
    return this.courses.saveCourse(courseId, await this.me.requireLogin(req));
  }

  @Mutation(() => Boolean, { description: '코스 저장 취소' })
  async unsaveCourse(@Args('courseId', { type: () => ID }) courseId: string, @Context('req') req: Request): Promise<boolean> {
    return this.courses.unsaveCourse(courseId, await this.me.requireLogin(req));
  }

  @Query(() => [Course], { description: '저장한 코스 (최신 저장순)' })
  async savedCourses(@Context('req') req: Request): Promise<Course[]> {
    const userId = await this.me.sessionUser(req);
    return userId ? this.courses.localizeMany(await this.courses.saved(userId)) : [];
  }

  @Query(() => [ID], { description: '저장한 코스 id들 (저장 버튼 상태). 로그인 전이면 빈 목록' })
  async savedCourseIds(@Context('req') req: Request): Promise<string[]> {
    const userId = await this.me.sessionUser(req);
    return userId ? this.courses.savedIds(userId) : [];
  }

  @Query(() => TransitRoute, { description: '대중교통 길찾기 (ODsay, 없으면 카카오맵 링크만). 내 위치 → 코스 출발점 등' })
  async transitRoute(
    @Args('from') from: LatLngInput,
    @Args('to') to: LatLngInput,
    @Args('fromName', { type: () => String, nullable: true }) fromName: string | undefined,
    @Args('toName', { type: () => String, nullable: true }) toName: string | undefined,
    @Context('req') req: Request,
  ): Promise<TransitRoute> {
    await this.limits.hit('transit', req, await this.me.sessionUser(req));
    return this.courses.transitRoute({ ...from, name: fromName }, { ...to, name: toName });
  }

  /** Courses belong to the account or browser that made them (for "지난번처럼"); without either they stay unowned. */
  private owner(req: Request): Promise<string | null> {
    return this.me.userId(req, this.me.anonKey(req) !== null);
  }
}
