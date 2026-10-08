import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.get<string>('REDIS_URL', 'redis://localhost:6379'), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    });
    this.client.on('error', () => undefined);
  }

  async onModuleDestroy() {
    this.client.disconnect();
  }
}
