import { Module } from '@nestjs/common';
import { OwnersModule } from '../owners/owners.module';
import { ShopDetailResolver } from './detail.resolver';
import { ShopDetailService } from './detail.service';
import { ShopPhotosService } from './photos.service';
import { ShopSearchResolver } from './search.resolver';
import { ShopsResolver } from './shops.resolver';
import { BrandsResolver } from './brands';

@Module({
  imports: [OwnersModule],
  providers: [ShopsResolver, ShopSearchResolver, ShopDetailService, ShopDetailResolver, ShopPhotosService, BrandsResolver],
  exports: [ShopDetailService],
})
export class ShopsModule {}
