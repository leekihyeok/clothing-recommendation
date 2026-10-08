import { Module } from '@nestjs/common';
import { AdminResolver } from './admin.resolver';
import { AdminService } from './admin.service';
import { QualityResolver } from './quality.resolver';

@Module({
  providers: [AdminService, AdminResolver, QualityResolver],
  exports: [AdminService],
})
export class AdminModule {}
