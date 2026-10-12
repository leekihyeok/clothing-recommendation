import { ForbiddenException } from '@nestjs/common';
import { Args, Context, Field, ID, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { AdminService } from '../admin/admin.service';
import { MeService, type Request } from '../me/me.service';
import { RateLimitService } from '../infra/rate-limit.service';
import { OwnersService } from './owners.service';

@ObjectType()
@InputType('HoursDayInput')
export class HoursDay {
  @Field()
  closed: boolean;

  @Field({ nullable: true, description: '"11:00"' })
  open?: string;

  @Field({ nullable: true, description: '"21:00" (자정 넘으면 "02:00")' })
  close?: string;
}

@ObjectType({ description: '사장님이 직접 올린 가게 정보' })
export class OwnerInfo {
  @Field(() => [HoursDay], { nullable: true, description: '월~일 7개' })
  hours?: HoursDay[];

  @Field({ nullable: true })
  hoursNote?: string;

  @Field({ nullable: true })
  intro?: string;

  @Field({ nullable: true })
  instagram?: string;

  @Field({ nullable: true })
  phone?: string;

  @Field({ nullable: true, description: '가게 웹사이트·온라인 스토어' })
  website?: string;

  @Field(() => [String])
  photos: string[];

  @Field()
  updatedAt: Date;

  @Field({ nullable: true, description: '지금(서울 시각) 영업 중인가. 영업시간이 없으면 null' })
  openNow?: boolean;

  @Field(() => Int, { description: '오늘 요일 0=월' })
  today: number;
}

@InputType()
export class ShopInfoInput {
  @Field(() => [HoursDay], { nullable: true })
  hours?: HoursDay[];

  @Field({ nullable: true })
  hoursNote?: string;

  @Field({ nullable: true })
  intro?: string;

  @Field({ nullable: true })
  instagram?: string;

  @Field({ nullable: true })
  phone?: string;

  @Field({ nullable: true, description: '가게 웹사이트·온라인 스토어 (https://…)' })
  website?: string;
}

@InputType()
export class OwnerClaimInput {
  @Field({ description: '사업자등록번호 (하이픈 있어도 됨)' })
  businessNo: string;

  @Field()
  ownerName: string;

  @Field({ description: '연락처 (전화 또는 이메일)' })
  contact: string;

  @Field({ nullable: true })
  message?: string;

  @Field({ nullable: true, description: '사업자등록증 사진 (JPEG base64, 필수). 관리자만 보고 승인·거절하면 지운다' })
  documentBase64?: string;
}

@ObjectType()
export class OwnerClaimResult {
  @Field(() => ID)
  id: string;

  @Field()
  status: string;

  @Field({ description: '국세청으로 확인했나' })
  checked: boolean;
}

@ObjectType()
export class MyClaim {
  @Field(() => ID)
  id: string;

  @Field({ description: 'pending | approved | rejected' })
  status: string;

  @Field({ nullable: true })
  reviewNote?: string;

  @Field()
  createdAt: Date;

  @Field(() => ID)
  shopId: string;

  @Field()
  shopName: string;
}

@ObjectType()
export class OwnedShop {
  @Field(() => ID)
  shopId: string;

  @Field()
  shopName: string;
}

@ObjectType({ description: '관리자 화면의 사장님 신청' })
export class AdminClaim {
  @Field(() => ID)
  id: string;

  @Field({ description: '사업자등록증 사진이 남아 있나 (승인·거절하면 지운다)' })
  hasDocument: boolean;

  @Field()
  status: string;

  @Field()
  businessNo: string;

  @Field()
  ownerName: string;

  @Field()
  contact: string;

  @Field({ nullable: true })
  message?: string;

  @Field({ description: '국세청 확인 결과' })
  nts: string;

  @Field()
  createdAt: Date;

  @Field({ nullable: true })
  reviewNote?: string;

  @Field(() => ID)
  shopId: string;

  @Field()
  shopName: string;

  @Field({ nullable: true })
  roadAddress?: string;

  @Field()
  nickname: string;
}

@Resolver()
export class OwnersResolver {
  constructor(
    private readonly owners: OwnersService,
    private readonly me: MeService,
    private readonly admin: AdminService,
    private readonly limits: RateLimitService,
  ) {}

  @Mutation(() => OwnerClaimResult, { description: '이 가게 사장님이에요: 사업자등록번호로 신청 (관리자가 승인). 로그인 필요' })
  async claimShop(
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('input') input: OwnerClaimInput,
    @Context('req') req: Request,
  ): Promise<OwnerClaimResult> {
    const userId = await this.me.requireLogin(req);
    await this.limits.hit('claim', req, userId);
    return this.owners.claim(userId, shopId, input);
  }

  @Query(() => [MyClaim], { description: '내 사장님 신청' })
  async myClaims(@Context('req') req: Request): Promise<MyClaim[]> {
    const userId = await this.me.sessionUser(req);
    return userId ? this.owners.myClaims(userId) : [];
  }

  @Query(() => [OwnedShop], { description: '내가 사장님인 가게' })
  async ownedShops(@Context('req') req: Request): Promise<OwnedShop[]> {
    const userId = await this.me.sessionUser(req);
    return userId ? this.owners.ownedShops(userId) : [];
  }

  @Mutation(() => Boolean, { description: '사장님: 영업시간·소개·인스타그램·전화 고치기' })
  async updateShopInfo(
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('input') input: ShopInfoInput,
    @Context('req') req: Request,
  ): Promise<boolean> {
    return this.owners.updateInfo(await this.me.requireLogin(req), shopId, input);
  }

  @Mutation(() => [String], { description: '사장님: 가게 사진 올리기 (JPG, 6장까지). 사진 주소 목록을 준다' })
  async addShopPhoto(
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('imageBase64') imageBase64: string,
    @Context('req') req: Request,
  ): Promise<string[]> {
    return this.owners.addPhoto(await this.me.requireLogin(req), shopId, imageBase64);
  }

  @Mutation(() => [String], { description: '사장님: 가게 사진 지우기' })
  async removeShopPhoto(
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('url') url: string,
    @Context('req') req: Request,
  ): Promise<string[]> {
    return this.owners.removePhoto(await this.me.requireLogin(req), shopId, url);
  }

  @Query(() => [AdminClaim], { description: '관리자: 사장님 신청 목록' })
  async ownerClaims(@Args('status', { defaultValue: 'pending' }) status: string, @Context('req') req: Request): Promise<AdminClaim[]> {
    await this.requireAdmin(req);
    return this.owners.claims(status);
  }

  @Mutation(() => Boolean, { description: '관리자: 사장님 신청 승인·거절' })
  async reviewOwnerClaim(
    @Args('id', { type: () => ID }) id: string,
    @Args('approve') approve: boolean,
    @Args('note', { type: () => String, nullable: true }) note: string | undefined,
    @Context('req') req: Request,
  ): Promise<boolean> {
    return this.owners.review(await this.requireAdmin(req), id, approve, note);
  }

  @Query(() => String, { nullable: true, description: '관리자: 신청의 사업자등록증 사진 (data URL). 처리한 신청은 없음' })
  async ownerClaimDocument(@Args('id', { type: () => ID }) id: string, @Context('req') req: Request): Promise<string | null> {
    await this.requireAdmin(req);
    return this.owners.claimDocument(id);
  }

  private async requireAdmin(req: Request): Promise<string> {
    const userId = await this.me.sessionUser(req);
    if (!userId || !(await this.admin.isAdmin(userId))) throw new ForbiddenException('관리자만 할 수 있어요');
    return userId;
  }
}
