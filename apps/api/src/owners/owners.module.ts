import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { OwnersResolver } from './owners.resolver';
import { OwnersService } from './owners.service';

@Module({
  imports: [AdminModule],
  providers: [OwnersService, OwnersResolver],
  exports: [OwnersService],
})
export class OwnersModule {}
