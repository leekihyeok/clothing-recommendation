import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { UPLOAD_DIR } from './me/profile.service';
import { langMiddleware } from './infra/lang';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Uploaded files (profile photos) at /media/…; the client's Vite proxy forwards /media here.
  // Every request runs in the language it asked for (x-route-lang), so replies can be written in it.
  app.use(langMiddleware);
  // Uploaded photos: served as what their extension says, never sniffed into something a browser would run.
  app.useStaticAssets(UPLOAD_DIR, {
    prefix: '/media/',
    maxAge: '7d',
    index: false,
    dotfiles: 'deny',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  });
  app.enableCors({ origin: ['http://localhost:5180'] });
  app.enableShutdownHooks();

  const port = app.get(ConfigService).get<number>('API_PORT', 4000);
  await app.listen(port);
  Logger.log(`GraphQL ready at http://localhost:${port}/graphql`, 'Bootstrap');
}

bootstrap();
