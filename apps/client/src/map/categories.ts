import { t } from '../i18n';

// Shop categories produced by the data pipeline (services/model/pipeline/classify.py), with map colours.
// `label` follows the app's language (a getter, so every place that shows it switches with it).
const DEFS = [
  { id: 'select_shop', ko: '편집숍', en: 'Select shop', color: '#c2410c' },
  { id: 'vintage', ko: '빈티지·구제', en: 'Vintage & thrift', color: '#8a5a2b' },
  { id: 'brand', ko: '브랜드', en: 'Brand store', color: '#1e3a8a' },
  { id: 'spa', ko: 'SPA', en: 'Fast fashion', color: '#4d7c0f' },
  { id: 'general', ko: '일반', en: 'Clothing', color: '#a8a29e' },
  { id: 'complex', ko: '백화점·몰', en: 'Dept. store & mall', color: '#44403c' },
] as const;

export type ShopCategoryId = (typeof DEFS)[number]['id'];

export interface ShopCategory {
  id: ShopCategoryId;
  readonly label: string;
  color: string;
}

export const SHOP_CATEGORIES: readonly ShopCategory[] = DEFS.map((d) => ({
  id: d.id,
  color: d.color,
  get label() {
    return t(d.ko, d.en);
  },
}));

export const CATEGORY_BY_ID = Object.fromEntries(SHOP_CATEGORIES.map((c) => [c.id, c])) as Record<string, ShopCategory>;
