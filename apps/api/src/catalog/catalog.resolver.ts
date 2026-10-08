import { Query, Resolver } from '@nestjs/graphql';
import {
  BUDGETS,
  CATALOG_VERSION,
  DEFAULTS,
  ITEMS,
  STOP_COUNT_OPTIONS,
  STYLES,
  TIME_BUDGET_OPTIONS_MIN,
} from '@cr/shared';
import { Catalog } from './catalog.model';

@Resolver(() => Catalog)
export class CatalogResolver {
  @Query(() => Catalog)
  catalog(): Catalog {
    return {
      version: CATALOG_VERSION,
      styles: [...STYLES],
      items: [...ITEMS],
      budgets: [...BUDGETS],
      stopCountOptions: [...STOP_COUNT_OPTIONS],
      timeBudgetOptionsMin: [...TIME_BUDGET_OPTIONS_MIN],
      defaults: DEFAULTS,
    };
  }
}
