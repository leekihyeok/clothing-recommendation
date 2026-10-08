import { Global, Module } from '@nestjs/common';
import { DbService } from './db.service';
import { EventsService } from './events.service';
import { ModelClient } from './model.client';
import { RedisService } from './redis.service';
import { TransitService } from './transit.service';
import { WalkService } from './walk.service';

@Global()
@Module({
  providers: [DbService, RedisService, ModelClient, WalkService, EventsService, TransitService],
  exports: [DbService, RedisService, ModelClient, WalkService, EventsService, TransitService],
})
export class InfraModule {}
