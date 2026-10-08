import { join } from 'node:path';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { AdminModule } from './admin/admin.module';
import { CatalogModule } from './catalog/catalog.module';
import { CourseModule } from './course/course.module';
import { HealthModule } from './health/health.module';
import { InfraModule } from './infra/infra.module';
import { MeModule } from './me/me.module';
import { OwnersModule } from './owners/owners.module';
import { RegionsModule } from './regions/regions.module';
import { ShopsModule } from './shops/shops.module';

@Module({
  imports: [
    // npm workspaces run scripts from apps/api, so the repo-root .env is two levels up.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      // Written on boot; apps/client codegen reads it.
      autoSchemaFile: join(process.cwd(), 'schema.gql'),
      sortSchema: true,
      // Resolvers read the anonymous browser id header (x-route-anon) from the request.
      context: ({ req }: { req: unknown }) => ({ req }),
    }),
    InfraModule,
    HealthModule,
    CatalogModule,
    ShopsModule,
    RegionsModule,
    CourseModule,
    MeModule,
    AdminModule,
    OwnersModule,
  ],
})
export class AppModule {}
