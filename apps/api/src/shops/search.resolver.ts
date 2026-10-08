import { Args, Field, Float, ID, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { LatLngInput } from '../course/course.model';
import { DbService } from '../infra/db.service';
import { searchShops } from './search';

@ObjectType({ description: '이름으로 찾은 가게' })
export class ShopHit {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  category: string;

  @Field({ nullable: true })
  roadAddress?: string;

  @Field(() => Float)
  lat: number;

  @Field(() => Float)
  lng: number;

  @Field(() => Int, { nullable: true, description: 'near에서 떨어진 거리(m)' })
  distanceM?: number;
}

@Resolver()
export class ShopSearchResolver {
  constructor(private readonly db: DbService) {}

  @Query(() => [ShopHit], { description: '가게 이름으로 찾기 (띄어쓰기·대소문자 무시). near를 주면 가까운 곳 먼저' })
  async searchShops(
    @Args('q') q: string,
    @Args('near', { type: () => LatLngInput, nullable: true }) near: LatLngInput | undefined,
    @Args('limit', { type: () => Int, defaultValue: 8 }) limit: number,
    @Args('strict', { defaultValue: false, description: '이름이 거의 맞는 가게만 (닮은 이름 빼고)' }) strict: boolean,
  ): Promise<ShopHit[]> {
    return searchShops(this.db.pool, q, near ?? undefined, limit, strict);
  }
}
