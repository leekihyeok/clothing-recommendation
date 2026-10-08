import { ArrowUpRight, X } from '@phosphor-icons/react';
import { useEffect } from 'react';
import { ShopActions } from '../me/ShopActions';
import { useRecordShop, useShopStates } from '../me/useMyShops';
import { CATEGORY_BY_ID } from './categories';
import type { MapShop } from './ShopMap';

export function ShopCard({ shop, onClose }: { shop: MapShop; onClose: () => void }) {
  const category = CATEGORY_BY_ID[shop.category];
  const states = useShopStates([shop.id]);
  const { record } = useRecordShop();
  // Opening a card counts as a view ("자주 본 곳"); the API counts one per shop per 10 minutes.
  useEffect(() => {
    record(shop.id, 'view');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop.id]);
  return (
    <article className="shop-card" aria-live="polite">
      <div className="d-flex align-items-start gap-2">
        <div className="flex-grow-1">
          <p className="eyebrow mb-1">
            <span>
              <span className="chip-dot me-1" style={{ background: category?.color }} />
              {category?.label ?? shop.category}
              {shop.inMarket && ' · 전통시장'}
            </span>
          </p>
          <h2>{shop.name}</h2>
          {shop.roadAddress && <div className="small text-secondary">{shop.roadAddress}</div>}
        </div>
        <button type="button" className="icon-btn" aria-label="닫기" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {shop.placeUrl && (
        <a className="small d-inline-flex align-items-center gap-1 mt-2" href={shop.placeUrl} target="_blank" rel="noreferrer">
          카카오맵에서 보기 <ArrowUpRight size={12} aria-hidden />
        </a>
      )}
      <ShopActions shopId={shop.id} state={states.get(shop.id)} />
    </article>
  );
}
