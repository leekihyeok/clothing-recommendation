import { Field, Float, ID, InputType, Int, ObjectType } from '@nestjs/graphql';

@InputType({ description: '지도 화면 영역 (남서쪽, 북동쪽 꼭짓점)' })
export class BoundsInput {
  @Field(() => Float)
  swLat: number;

  @Field(() => Float)
  swLng: number;

  @Field(() => Float)
  neLat: number;

  @Field(() => Float)
  neLng: number;
}

@ObjectType()
export class MapShop {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field({ description: 'store: 단일 매장, complex: 백화점·아울렛·몰 (코스의 한 정거장)' })
  kind: string;

  @Field({ description: 'select_shop | vintage | brand | spa | general | complex' })
  category: string;

  @Field(() => Float)
  lat: number;

  @Field(() => Float)
  lng: number;

  @Field({ nullable: true })
  roadAddress?: string;

  @Field({ description: '전통시장 안 매장' })
  inMarket: boolean;

  @Field({ nullable: true, description: '카카오맵 장소 페이지' })
  placeUrl?: string;

  @Field(() => Float, { description: '눈에 띄는 정도 0~1 (인기·신뢰도·종류)' })
  prominence: number;

  @Field({ description: '지도에 이름표를 붙일 만큼 상위인가' })
  labeled: boolean;

  @Field({ nullable: true, description: 'candidate | suspended(문 닫힘 신고로 확인 중) | closed(폐업). 내 가게 목록에서만 채움' })
  status?: string;
}

@ObjectType()
export class ShopsInBounds {
  @Field(() => [MapShop])
  shops: MapShop[];

  @Field(() => Int, { description: '영역 안 전체 수 (limit 때문에 일부만 왔을 수 있음)' })
  total: number;
}
