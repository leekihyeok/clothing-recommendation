import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { UPLOAD_DIR } from './me/profile.service';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Uploaded files (profile photos) at /media/…; the client's Vite proxy forwards /media here.
  app.useStaticAssets(UPLOAD_DIR, { prefix: '/media/', maxAge: '7d', index: false });
  app.enableCors({ origin: ['http://localhost:5180'] });
  app.enableShutdownHooks();

  const port = app.get(ConfigService).get<number>('API_PORT', 4000);
  await app.listen(port);
  Logger.log(`GraphQL ready at http://localhost:${port}/graphql`, 'Bootstrap');
}

bootstrap();
