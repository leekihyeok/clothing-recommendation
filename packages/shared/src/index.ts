import catalog from '../catalog.json';

// catalog.json is the single source of truth, also read by services/model.
export interface Option<T extends string = string> {
  id: T;
  label: string;
}

export type TravelMode = 'walk';

export interface CatalogDefaults {
  stopCount: number;
  timeBudgetMin: number;
  travelMode: TravelMode;
  budget: string;
}

export const CATALOG_VERSION: number = catalog.version;
export const STYLES: readonly Option[] = catalog.styles;
export const ITEMS: readonly Option[] = catalog.items;
export const BUDGETS: readonly Option[] = catalog.budgets;
export const STOP_COUNT_OPTIONS: readonly number[] = catalog.stopCountOptions;
export const TIME_BUDGET_OPTIONS_MIN: readonly number[] = catalog.timeBudgetOptionsMin;
export const DEFAULTS: CatalogDefaults = catalog.defaults as CatalogDefaults;

export const STYLE_IDS: readonly string[] = STYLES.map((s) => s.id);
