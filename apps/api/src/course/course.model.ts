import { Field, Float, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import { LatLng } from '../regions/regions.resolver';
import { BoundsInput } from '../shops/shops.model';
import { BrandRef } from '../shops/brands';

@InputType()
export class LatLngInput {
  @Field(() => Float)
  lat: number;

  @Field(() => Float)
  lng: number;
}

@InputType({ description: '출발점. 하나만 채운다: 현재 위치, 지역, 지도에서 찍은 점' })
export class OriginInput {
  @Field(() => LatLngInput, { nullable: true })
  gps?: LatLngInput;

  @Field(() => ID, { nullable: true })
  regionId?: string;

  @Field(() => LatLngInput, { nullable: true })
  point?: LatLngInput;

  @Field({ nullable: true, description: '출발 장소 이름 (예: 망원역). 코스 제목에 쓴다' })
  label?: string;

  @Field(() => BoundsInput, { nullable: true, description: '지도 화면 영역: 지역을 고르지 않았으면 이 안의 가게로만 짠다' })
  bounds?: BoundsInput;
}

@InputType({ description: '끝나는 곳: 지도·글에서 고른 점, 또는 출발점으로 돌아오기' })
export class EndInput {
  @Field(() => LatLngInput, { nullable: true })
  point?: LatLngInput;

  @Field({ nullable: true, description: '끝나는 장소 이름 (예: 합정역)' })
  label?: string;

  @Field({ nullable: true, description: '출발점으로 돌아오기' })
  back?: boolean;
}

@ObjectType({ description: '코스를 짠 지도 화면 영역 (지역을 고르지 않고 "지도 가운데서" 짰을 때)' })
export class MapArea {
  @Field(() => Float)
  swLat: number;

  @Field(() => Float)
  swLng: number;

  @Field(() => Float)
  neLat: number;

  @Field(() => Float)
  neLng: number;
}

@ObjectType({ description: '고정한 가게: 꼭 넣을 가게로 고르거나 코스에 직접 넣은 곳. 다시 짜도 남는다' })
export class PinnedShop {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;
}

@InputType()
export class StyleWeightInput {
  @Field()
  id: string;

  @Field(() => Float, { defaultValue: 1 })
  weight: number;
}

@InputType({ description: '요청서. 비운 칸은 기본값으로 채운다' })
export class CourseRequestInput {
  @Field(() => OriginInput)
  origin: OriginInput;

  @Field(() => [StyleWeightInput], { nullable: true })
  styles?: StyleWeightInput[];

  @Field(() => Int, { nullable: true, description: '2~20. 비우면 기본값' })
  stopCount?: number;

  @Field({ nullable: true, description: '시간 안에 들를 수 있는 만큼 최대한 (stopCount 무시)' })
  maxStops?: boolean;

  @Field(() => Int, { nullable: true, description: '30~720분. 비우면 기본값(개수를 정했으면 개수에 맞춤)' })
  timeBudgetMin?: number;

  @Field({ nullable: true, description: 'any | low | mid | high' })
  budget?: string;

  @Field(() => [String], { nullable: true, description: '찾는 품목 (catalog items)' })
  items?: string[];

  @Field({ nullable: true, description: '다녀온 가게는 넣지 않기 (내 가게 기록)' })
  skipVisited?: boolean;

  @Field(() => [ID], { nullable: true, description: '방금 보여 준 코스의 가게들: 같은 조건으로 다시 짤 때 뒤로 미뤄 다른 코스가 나오게' })
  seenShopIds?: string[];

  @Field(() => [ID], { nullable: true, description: '"다른 코스": 지금 보고 있는 코스의 가게들 (순서대로). 찜한 곳과 가장 잘 맞는 몇 곳은 남기고 나머지를 바꾼다' })
  keepShopIds?: string[];

  @Field(() => [ID], { nullable: true, description: '꼭 넣을 가게 (시간 안에 들어가면 반드시 넣는다)' })
  mustShopIds?: string[];

  @Field({ nullable: true, description: '어떻게 요청했나 (통계용): buttons | here | point | text | photo | preset | again | saved' })
  inputMode?: string;

  @Field(() => ID, { nullable: true, description: '이 코스에서 이어 가기: 그 코스의 마지막 가게에서 새 출발점까지 대중교통 안내' })
  continueFrom?: string;

  @Field({ nullable: true, description: '코스 중간에 카페 들르기 (카카오 카페 검색)' })
  withCafe?: boolean;

  @Field({ nullable: true, description: '가는 길에 맛집 들르기 (카카오 맛집 검색)' })
  withFood?: boolean;

  @Field({ nullable: true, description: '누구 옷: men(남성복) | women(여성복). 비우면 상관없음' })
  gender?: string;

  @Field({ nullable: true, description: '출발 시각 (서울, "2026-10-17T14:00"). 비우면 지금. 그때 여는 가게로 짠다' })
  startAt?: string;

  @Field({ nullable: true, description: '이 시각까지 끝내기 ("18:00"). 주면 시간은 출발부터 여기까지' })
  endBy?: string;

  @Field(() => EndInput, { nullable: true, description: '끝나는 곳. 비우면 마지막 가게에서 끝' })
  end?: EndInput;

  @Field(() => [String], { nullable: true, description: '찾는 브랜드 (brandSearch의 key, 최대 5개). 다루는 가게를 앞으로' })
  brands?: string[];

  @Field({ nullable: true, description: 'false면 날씨를 반영하지 않는다 (기본: 비·눈·더위·추위면 실내 위주, 덜 걷게)' })
  weather?: boolean;
}

@ObjectType({ description: '코스 시간대의 날씨 (Open-Meteo 예보)' })
export class CourseWeather {
  @Field({ description: 'fine | rain | snow | hot | cold' })
  condition: string;

  @Field({ description: '"비 70% · 18°"' })
  summary: string;

  @Field(() => Int)
  rainChance: number;

  @Field(() => Int)
  tempC: number;

  @Field({ description: '코스에 반영했나 (날씨가 나쁘고 반영을 끄지 않았을 때)' })
  applied: boolean;

  @Field({ nullable: true, description: '어떻게 반영했나 한 줄' })
  note?: string;
}

@ObjectType({ description: '코스 중간에 쉬어 가는 곳: 카페나 맛집 (가게 목록과 별도, 카카오 장소 검색)' })
export class BreakStop {
  @Field({ description: 'cafe | food' })
  kind: string;

  @Field(() => Int, { description: '몇 번째 가게 다음에 들르나' })
  afterOrder: number;

  @Field()
  name: string;

  @Field(() => Float)
  lat: number;

  @Field(() => Float)
  lng: number;

  @Field({ nullable: true })
  address?: string;

  @Field({ nullable: true })
  placeUrl?: string;

  @Field({ nullable: true, description: '카카오 분류의 마지막 단계 (한식, 디저트카페 …)' })
  category?: string;

  @Field(() => Int, { description: '머무는 시간(분)' })
  minutes: number;

  @Field(() => Int, { description: '들르느라 더 걷는 거리(m)' })
  detourM: number;
}

@ObjectType()
export class TransitStep {
  @Field({ description: 'subway | bus | walk' })
  mode: string;

  @Field({ description: '2호선, 간선 472, 도보' })
  line: string;

  @Field({ nullable: true })
  from?: string;

  @Field({ nullable: true })
  to?: string;

  @Field(() => Int)
  minutes: number;

  @Field(() => Int, { nullable: true })
  stops?: number;
}

@ObjectType({ description: '대중교통 경로 (ODsay). found=false면 카카오맵 링크로 안내' })
export class TransitRoute {
  @Field()
  found: boolean;

  @Field(() => Int)
  minutes: number;

  @Field(() => Int, { nullable: true })
  fare?: number;

  @Field(() => Int)
  transfers: number;

  @Field(() => Int)
  walkM: number;

  @Field(() => [TransitStep])
  steps: TransitStep[];

  @Field({ description: '카카오맵 길찾기 (항상)' })
  kakaoUrl: string;

  @Field({ nullable: true })
  note?: string;
}

@ObjectType({ description: '이어 가는 코스: 앞 코스와 거기서 오는 길' })
export class CourseLink {
  @Field(() => ID)
  prevCourseId: string;

  @Field({ description: '앞 코스 이름 (지역)' })
  prevName: string;

  @Field({ description: '앞 코스 마지막 가게' })
  fromShop: string;

  @Field(() => TransitRoute)
  transit: TransitRoute;
}

@ObjectType({ description: '실제로 쓰인 요청서 (기본값 채운 뒤)' })
export class ResolvedRequest {
  @Field(() => [String])
  styles: string[];

  @Field(() => Int)
  stopCount: number;

  @Field()
  maxStops: boolean;

  @Field(() => Int)
  timeBudgetMin: number;

  @Field()
  budget: string;

  @Field(() => [String])
  items: string[];

  @Field({ nullable: true })
  regionName?: string;

  @Field(() => ID, { nullable: true, description: '지역을 골랐으면 그 지역 (같은 조건으로 다시 짤 때)' })
  regionId?: string;

  @Field({ nullable: true, description: '취향 학습이 이 코스에 어떻게 반영됐나 한 줄' })
  tasteNote?: string;

  @Field({ nullable: true, description: '카페 들르기를 요청했나' })
  withCafe?: boolean;

  @Field({ nullable: true, description: '맛집 들르기를 요청했나' })
  withFood?: boolean;

  @Field({ nullable: true, description: 'men | women (남성복 / 여성복), 없으면 상관없음' })
  gender?: string;

  @Field({ nullable: true, description: '고른 출발 시각 ("2026-10-17T14:00"), 지금 출발이면 없음' })
  startAt?: string;

  @Field({ nullable: true, description: '이 시각까지 끝내기 ("18:00")' })
  endBy?: string;

  @Field({ nullable: true, description: '출발점으로 돌아오는 코스' })
  roundTrip?: boolean;

  @Field(() => [BrandRef], { description: '찾은 브랜드' })
  brands: BrandRef[];

  @Field(() => [PinnedShop], { description: '고정한 가게 (다른 코스·다시 짜기에도 넣는다)' })
  mustShops: PinnedShop[];

  @Field({ description: '다녀온 가게는 넣지 않기' })
  skipVisited: boolean;

  @Field(() => MapArea, { nullable: true, description: '이 지도 화면 안에서만 짰으면 그 영역 (다시 짤 때도 같은 영역)' })
  bounds?: MapArea;

  @Field({ description: '날씨 반영을 껐나' })
  ignoreWeather: boolean;

  @Field(() => ID, { nullable: true, description: '같이 가기로 짠 코스면 그 같이 가기' })
  groupId?: string;

  @Field(() => [String], { nullable: true, description: '같이 가는 사람 이름 (취향을 섞은 사람들)' })
  groupNames?: string[];

  @Field(() => [String], { description: '기본값으로 채운 칸 (칩을 흐리게 표시)' })
  defaultedFields: string[];
}

@ObjectType()
export class StyleScore {
  @Field()
  style: string;

  @Field(() => Int)
  score: number;
}

@ObjectType()
export class CourseShop {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  kind: string;

  @Field()
  category: string;

  @Field(() => Float)
  lat: number;

  @Field(() => Float)
  lng: number;

  @Field({ nullable: true })
  roadAddress?: string;

  @Field({ nullable: true })
  placeUrl?: string;

  @Field({ nullable: true })
  summary?: string;

  @Field({ nullable: true })
  priceRange?: string;

  @Field(() => [StyleScore], { description: '5점 이상 스타일, 높은 순' })
  topStyles: StyleScore[];

  @Field({ description: '근거(블로그 등)를 찾지 못한 가게: "정보가 적은 가게"로 표시' })
  littleKnown: boolean;

  @Field({ nullable: true, description: '코스 날의 영업시간 ("오늘 11:00–21:00", "토 쉬는 날"). 없으면 영업시간 확인 필요' })
  hoursToday?: string;

  @Field({ nullable: true, description: '영업시간 출처: owner(사장님) | blog(블로그 글)' })
  hoursSource?: string;

  @Field({ nullable: true, description: '도착할 때 닫혀 있으면 안내 ("도착(19:40) 때는 문을 닫아요")' })
  hoursWarning?: string;

  @Field({ nullable: true, description: '사장님 소식으로 진행 중인 것 ("세일 중", "신상 입고", "이벤트 중")' })
  newsTag?: string;
}

@ObjectType()
export class Leg {
  @Field(() => Int)
  distanceM: number;

  @Field(() => Float)
  durationMin: number;

  @Field(() => [LatLng], { description: '지금은 직선. 보행자 경로 API를 붙이면 실제 길' })
  path: LatLng[];
}

@ObjectType()
export class CourseStop {
  @Field(() => Int)
  order: number;

  @Field(() => CourseShop)
  shop: CourseShop;

  @Field({ description: '왜 추천했나 한 줄' })
  reason: string;

  @Field(() => Leg)
  legFromPrev: Leg;

  @Field({ nullable: true, description: '출발 시각을 골랐으면 도착 예정 시각 ("14:20")' })
  arriveAt?: string;

  @Field(() => [String], { nullable: true, description: '조건에서 고른 브랜드 중 이 가게가 다루는 것 (다시 짜도 브랜드마다 한 곳은 넣는다). 예전 코스는 없음' })
  brands?: string[];
}

@ObjectType({ description: '추천 / 가까운 위주 / 취향 우선 중 하나' })
export class CourseVariant {
  @Field()
  variant: string;

  @Field()
  label: string;

  @Field(() => [CourseStop])
  stops: CourseStop[];

  @Field(() => Int)
  totalDistanceM: number;

  @Field(() => Float)
  walkMin: number;

  @Field(() => Float)
  totalMin: number;

  @Field({ nullable: true })
  note?: string;

  @Field(() => [BreakStop], { nullable: true, description: '쉬어 가는 곳 (카페·맛집), 최대 종류별 하나' })
  breaks?: BreakStop[];

  @Field(() => Leg, { nullable: true, description: '마지막 가게 → 끝나는 곳 (정했을 때)' })
  endLeg?: Leg;

  @Field({ nullable: true, description: '출발 시각을 골랐으면 끝나는 예정 시각 ("17:40")' })
  finishAt?: string;
}

@ObjectType()
export class Course {
  @Field(() => ID)
  id: string;

  @Field(() => ResolvedRequest)
  request: ResolvedRequest;

  @Field(() => LatLng)
  origin: LatLng;

  @Field({ nullable: true, description: '출발 장소 이름 (지역을 고르면 가까운 지하철역)' })
  startName?: string;

  @Field(() => LatLng, { nullable: true, description: '끝나는 곳 (정했을 때)' })
  end?: LatLng;

  @Field({ nullable: true, description: '끝나는 곳 이름 (합정역, 출발점 …)' })
  endName?: string;

  @Field(() => CourseWeather, { nullable: true, description: '코스 시간대 날씨 (예보가 없으면 없음)' })
  weather?: CourseWeather;

  @Field(() => [CourseVariant], { description: '첫 번째가 추천 코스' })
  variants: CourseVariant[];

  @Field({ description: '공유 링크로 연 고정 사본. 고치면 내 코스로 새로 복사된다' })
  shared: boolean;

  @Field(() => CourseLink, { nullable: true, description: '다른 코스에서 이어 왔으면 그 코스와 오는 길' })
  link?: CourseLink;

  @Field()
  createdAt: Date;
}

@InputType({ description: '코스 고치기 한 번. op: remove | replace | move | add | replan' })
export class CourseEditInput {
  @Field()
  op: string;

  @Field(() => Int, { nullable: true, description: '대상 가게 번호 (1부터)' })
  order?: number;

  @Field(() => Int, { nullable: true, description: 'move: 옮길 자리' })
  toOrder?: number;

  @Field(() => ID, { nullable: true, description: 'replace/add: 이 가게로 (이름으로 찾았거나 지도·가게 정보에서 고른 가게)' })
  shopId?: string;

  @Field(() => [ID], { nullable: true, description: 'replace/add: 이미 거절한 가게 (다시 추천하지 않음)' })
  avoid?: string[];

  @Field({ nullable: true, description: 'select_shop | vintage | brand | spa | general | complex' })
  wantCategory?: string;

  @Field({ nullable: true })
  wantStyle?: string;

  @Field({ nullable: true })
  wantItem?: string;

  @Field({ nullable: true, description: 'low | mid | high' })
  wantBudget?: string;

  @Field({ nullable: true, description: 'replan: nearby | taste' })
  prefer?: string;
}

@ObjectType()
export class CourseEditResult {
  @Field(() => ID, { description: '고친 코스. 공유받은 코스를 고치면 새 사본의 id' })
  courseId: string;

  @Field(() => CourseVariant)
  variant: CourseVariant;

  @Field({ nullable: true, description: '무엇을 바꿨는지 한 줄' })
  message?: string;

  @Field(() => [PinnedShop], { description: '고친 뒤의 고정한 가게' })
  mustShops: PinnedShop[];
}
