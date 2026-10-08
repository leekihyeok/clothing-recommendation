// Shop categories produced by the data pipeline (services/model/pipeline/classify.py), with map colours.
export const SHOP_CATEGORIES = [
  { id: 'select_shop', label: '편집숍', color: '#c2410c' },
  { id: 'vintage', label: '빈티지·구제', color: '#8a5a2b' },
  { id: 'brand', label: '브랜드', color: '#1e3a8a' },
  { id: 'spa', label: 'SPA', color: '#4d7c0f' },
  { id: 'general', label: '일반', color: '#a8a29e' },
  { id: 'complex', label: '백화점·몰', color: '#44403c' },
] as const;

export type ShopCategoryId = (typeof SHOP_CATEGORIES)[number]['id'];

export const CATEGORY_BY_ID = Object.fromEntries(SHOP_CATEGORIES.map((c) => [c.id, c])) as Record<
  string,
  (typeof SHOP_CATEGORIES)[number]
>;
