import { ForbiddenException } from '@nestjs/common';
import { Args, Context, Int, Query, Resolver } from '@nestjs/graphql';
import { MeService, type Request } from '../me/me.service';
import { AdminService } from './admin.service';

@Resolver()
export class AdminResolver {
  constructor(
    private readonly admin: AdminService,
    private readonly me: MeService,
  ) {}

  @Query(() => Boolean, { description: '지금 사용자가 관리자인가 (관리자 화면 링크 표시용)' })
  async isAdmin(@Context('req') req: Request): Promise<boolean> {
    return this.admin.isAdmin(await this.me.sessionUser(req));
  }

  // One JSON document instead of a typed schema: the admin page is internal and its numbers change often.
  // The shape is AdminReport in admin.service.ts (mirrored in apps/client/src/admin/AdminPage.tsx).
  @Query(() => String, { description: '관리자 통계 (JSON). ADMIN_KAKAO_IDS에 있는 카카오 계정으로 로그인해야 한다' })
  async adminReport(@Args('days', { type: () => Int, defaultValue: 30 }) days: number, @Context('req') req: Request): Promise<string> {
    if (!(await this.admin.isAdmin(await this.me.sessionUser(req)))) throw new ForbiddenException('관리자만 볼 수 있어요');
    return JSON.stringify(await this.admin.report(days));
  }
}
