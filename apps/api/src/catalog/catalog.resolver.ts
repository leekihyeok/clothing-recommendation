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
import { lang } from '../infra/lang';

const inLang = (o: { id: string; label: string; labelEn?: string }) => ({ id: o.id, label: lang() === 'en' ? o.labelEn ?? o.label : o.label });

@Resolver(() => Catalog)
export class CatalogResolver {
  @Query(() => Catalog)
  catalog(): Catalog {
    return {
      version: CATALOG_VERSION,
      styles: STYLES.map(inLang),
      items: ITEMS.map(inLang),
      budgets: BUDGETS.map(inLang),
      stopCountOptions: [...STOP_COUNT_OPTIONS],
      timeBudgetOptionsMin: [...TIME_BUDGET_OPTIONS_MIN],
      defaults: DEFAULTS,
    };
  }
}
