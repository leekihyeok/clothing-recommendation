import { Module } from '@nestjs/common';
import { CatalogResolver } from './catalog.resolver';

@Module({
  providers: [CatalogResolver],
})
export class CatalogModule {}
