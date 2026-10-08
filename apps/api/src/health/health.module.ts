import { Module } from '@nestjs/common';
import { HealthResolver } from './health.resolver';
import { HealthService } from './health.service';

@Module({
  providers: [HealthService, HealthResolver],
})
export class HealthModule {}
