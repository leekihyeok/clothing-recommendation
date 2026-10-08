import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class ServiceStatus {
  @Field()
  ok: boolean;

  @Field({ nullable: true, description: '버전 정보 또는 실패 이유' })
  detail?: string;
}

@ObjectType()
export class Health {
  @Field(() => ServiceStatus)
  api: ServiceStatus;

  @Field(() => ServiceStatus)
  db: ServiceStatus;

  @Field(() => ServiceStatus, { description: 'PostGIS 확장 (1단계부터 필요)' })
  postgis: ServiceStatus;

  @Field(() => ServiceStatus)
  redis: ServiceStatus;

  @Field(() => ServiceStatus)
  model: ServiceStatus;

  @Field(() => ServiceStatus, { description: 'AI 제공자, 오늘 호출 수 (llm_calls 기준)' })
  ai: ServiceStatus;

  @Field(() => ServiceStatus, { description: '도보 경로 (T맵 키가 없으면 직선으로 대신함)' })
  walk: ServiceStatus;
}
