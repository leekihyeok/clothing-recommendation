import { Global, Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';
import { DbService } from './db.service';
import { WeatherService } from './weather.service';
import { EventsService } from './events.service';
import { ModelClient } from './model.client';
import { RedisService } from './redis.service';
import { TransitService } from './transit.service';
import { WalkService } from './walk.service';

@Global()
@Module({
  providers: [DbService, RedisService, ModelClient, WalkService, EventsService, TransitService, WeatherService, RateLimitService],
  exports: [DbService, RedisService, ModelClient, WalkService, EventsService, TransitService, WeatherService, RateLimitService],
})
export class InfraModule {}
