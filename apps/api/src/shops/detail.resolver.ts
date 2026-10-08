import { Args, Context, ID, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { OwnerInfo } from '../owners/owners.resolver';
import { OwnersService } from '../owners/owners.service';
import { ShopPhoto } from './detail.model';
import { ShopPhotosService } from './photos.service';
import { MeService, type Request } from '../me/me.service';
import { Review, ShopDetail } from './detail.model';
import { ShopDetailService } from './detail.service';

@Resolver(() => ShopDetail)
export class ShopDetailResolver {
  constructor(
    private readonly detail: ShopDetailService,
    private readonly me: MeService,
    private readonly owners: OwnersService,
    private readonly photoSearch: ShopPhotosService,
  ) {}

  @ResolveField(() => [ShopPhoto], { description: '가게 사진 (카카오 이미지 검색, 이 가게를 다룬 글의 사진 먼저). 사장님 사진은 owner.photos' })
  photos(@Parent() shop: ShopDetail) {
    return this.photoSearch.photos(shop.id);
  }

  @ResolveField(() => OwnerInfo, { nullable: true, description: '사장님이 올린 정보 (영업시간, 소개, 사진)' })
  owner(@Parent() shop: ShopDetail) {
    return this.owners.info(shop.id);
  }

  @ResolveField(() => Boolean, { description: '보고 있는 사람이 이 가게 사장님인가' })
  async isOwner(@Parent() shop: ShopDetail, @Context('req') req: Request): Promise<boolean> {
    const userId = await this.me.sessionUser(req);
    return userId ? this.owners.isOwner(userId, shop.id) : false;
  }

  @Query(() => ShopDetail, { nullable: true, description: '가게 상세 (소개, 찜·방문 수, 별점, 블로그 평판, 근거 글)' })
  async shop(@Args('id', { type: () => ID }) id: string, @Context('req') req: Request): Promise<ShopDetail | null> {
    return this.detail.detail(id, await this.me.userId(req, false));
  }

  @Query(() => [Review], { description: '가게 후기, 최신순 10개씩 (내 후기는 shop.myReview)' })
  async shopReviews(
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('offset', { type: () => Int, defaultValue: 0 }) offset: number,
    @Context('req') req: Request,
  ): Promise<Review[]> {
    return this.detail.reviews(shopId, await this.me.userId(req, false), offset);
  }

  @Mutation(() => Review, { description: '후기 쓰기·고치기 (가게마다 한 사람 하나). 카카오 로그인 필요' })
  async saveReview(
    @Args('shopId', { type: () => ID }) shopId: string,
    @Args('rating', { type: () => Int }) rating: number,
    @Args('body', { type: () => String, nullable: true }) body: string | undefined,
    @Context('req') req: Request,
  ): Promise<Review> {
    return this.detail.save(shopId, await this.me.requireLogin(req), rating, body);
  }

  @Mutation(() => Boolean, { description: '내 후기 지우기' })
  async deleteReview(@Args('shopId', { type: () => ID }) shopId: string, @Context('req') req: Request): Promise<boolean> {
    return this.detail.remove(shopId, await this.me.requireLogin(req));
  }
}
