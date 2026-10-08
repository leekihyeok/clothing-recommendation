import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: '후기를 쓴 사람 (닉네임·프로필 사진만)' })
export class Reviewer {
  @Field()
  nickname: string;

  @Field({ nullable: true })
  avatarUrl?: string;
}

@ObjectType()
export class Review {
  @Field(() => ID)
  id: string;

  @Field(() => Int, { description: '1~5' })
  rating: number;

  @Field({ nullable: true })
  body?: string;

  @Field(() => Reviewer)
  author: Reviewer;

  @Field({ description: '내가 쓴 후기' })
  mine: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType({ description: '우리 사용자 별점' })
export class RatingSummary {
  @Field(() => Float, { nullable: true })
  average?: number;

  @Field(() => Int)
  count: number;

  @Field(() => [Int], { description: '1점~5점 각각의 수' })
  histogram: number[];
}

@ObjectType({ description: '모아 둔 블로그 글로 AI가 정리한 평판' })
export class BlogReputation {
  @Field(() => Float, { nullable: true, description: '1~5' })
  score?: number;

  @Field(() => Int, { description: '이 가게를 다룬 글 수' })
  posts: number;

  @Field(() => [String])
  pros: string[];

  @Field(() => [String])
  cons: string[];
}

@ObjectType({ description: '종합 평점: 우리 별점과 블로그 평판을 근거 수만큼 무게를 두어 평균' })
export class CombinedRating {
  @Field(() => Float)
  score: number;

  @Field({ description: '무엇을 합쳤는지 한 줄' })
  basis: string;
}

@ObjectType()
export class SourcePost {
  @Field()
  title: string;

  @Field()
  url: string;

  @Field({ nullable: true })
  postedOn?: string;

  @Field({ description: '블로그 | 카페 | 웹문서 | 영상' })
  source: string;
}

@ObjectType({ description: '가게 사진 한 장 (검색 썸네일 + 출처)' })
export class ShopPhoto {
  @Field()
  url: string;

  @Field({ description: '사진이 실린 글 (누르면 이동)' })
  sourceUrl: string;

  @Field()
  source: string;

  @Field({ description: '이 가게를 다룬 것으로 확인된 글의 사진' })
  matched: boolean;
}

@ObjectType()
export class StyleTag {
  @Field()
  style: string;

  @Field(() => Int)
  score: number;
}

@ObjectType({ description: '가게 상세' })
export class ShopDetail {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  kind: string;

  @Field()
  category: string;

  @Field()
  status: string;

  @Field(() => Float)
  lat: number;

  @Field(() => Float)
  lng: number;

  @Field({ nullable: true })
  roadAddress?: string;

  @Field({ nullable: true })
  phone?: string;

  @Field({ nullable: true })
  placeUrl?: string;

  @Field()
  inMarket: boolean;

  @Field({ nullable: true })
  summary?: string;

  @Field({ nullable: true, description: '들를 이유' })
  reason?: string;

  @Field({ nullable: true })
  priceRange?: string;

  @Field(() => [String])
  items: string[];

  @Field(() => [StyleTag], { description: '5점 이상 스타일' })
  styles: StyleTag[];

  @Field({ description: '근거가 적어 소개가 추정에 가까움' })
  littleKnown: boolean;

  @Field(() => Int, { description: '찜한 사람 수' })
  saves: number;

  @Field(() => Int, { description: '다녀온 사람 수' })
  visitors: number;

  @Field(() => RatingSummary)
  rating: RatingSummary;

  @Field(() => BlogReputation)
  blog: BlogReputation;

  @Field(() => CombinedRating, { nullable: true })
  combined?: CombinedRating;

  @Field(() => [SourcePost])
  posts: SourcePost[];

  @Field(() => Review, { nullable: true })
  myReview?: Review;
}
