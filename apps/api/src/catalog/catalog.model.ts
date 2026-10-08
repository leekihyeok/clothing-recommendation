import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class CatalogOption {
  @Field()
  id: string;

  @Field()
  label: string;
}

@ObjectType()
export class CatalogDefaults {
  @Field(() => Int)
  stopCount: number;

  @Field(() => Int)
  timeBudgetMin: number;

  @Field()
  travelMode: string;

  @Field()
  budget: string;
}

@ObjectType({ description: '입력 칩과 버튼에 쓰는 선택지 목록' })
export class Catalog {
  @Field(() => Int)
  version: number;

  @Field(() => [CatalogOption])
  styles: CatalogOption[];

  @Field(() => [CatalogOption])
  items: CatalogOption[];

  @Field(() => [CatalogOption])
  budgets: CatalogOption[];

  @Field(() => [Int])
  stopCountOptions: number[];

  @Field(() => [Int])
  timeBudgetOptionsMin: number[];

  @Field(() => CatalogDefaults)
  defaults: CatalogDefaults;
}
