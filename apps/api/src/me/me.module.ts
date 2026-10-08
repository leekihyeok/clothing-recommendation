import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ClosuresService } from './closures.service';
import { MeResolver } from './me.resolver';
import { MeService } from './me.service';
import { ProfileResolver } from './profile.resolver';
import { ProfileService } from './profile.service';

// Global: course planning also reads the user's saved / visited shops.
@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, ClosuresService, MeService, MeResolver, ProfileService, ProfileResolver],
  exports: [MeService],
})
export class MeModule {}
