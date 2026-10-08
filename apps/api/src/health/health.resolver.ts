import { Query, Resolver } from '@nestjs/graphql';
import { Health } from './health.model';
import { HealthService } from './health.service';

@Resolver(() => Health)
export class HealthResolver {
  constructor(private readonly healthService: HealthService) {}

  @Query(() => Health, { description: '각 구성 요소의 연결 상태' })
  health(): Promise<Health> {
    return this.healthService.check();
  }
}
