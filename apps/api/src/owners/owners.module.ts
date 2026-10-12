import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { OwnersResolver } from './owners.resolver';
import { OwnersService } from './owners.service';
import { ShopNewsResolver } from './news';

@Module({
  imports: [AdminModule],
  providers: [OwnersService, OwnersResolver, ShopNewsResolver],
  exports: [OwnersService],
})
export class OwnersModule {}
