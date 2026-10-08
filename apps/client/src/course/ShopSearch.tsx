import { useQuery } from '@apollo/client';
import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { useEffect, useId, useState } from 'react';
import { graphql } from '../gql';
import type { SearchShopsQuery } from '../gql/graphql';
import { CATEGORY_BY_ID } from '../map/categories';

const SearchDoc = graphql(`
  query SearchShops($q: String!, $near: LatLngInput, $strict: Boolean) {
    searchShops(q: $q, near: $near, limit: 6, strict: $strict) { id name category roadAddress lat lng distanceM }
  }
`);

export type ShopHit = SearchShopsQuery['searchShops'][number];

/** Shops matching `text` by name, asked once typing pauses (250 ms). Empty text asks nothing. */
export function useShopHits(text: string, near?: { lat: number; lng: number } | null, strict = false) {
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const { data, loading } = useQuery(SearchDoc, {
    variables: { q, near: near ? { lat: near.lat, lng: near.lng } : null, strict },
    skip: q.length < 1,
  });
  return { q, hits: q ? data?.searchShops ?? [] : [], loading: loading && !data };
}

/** "1.2km" / "350m" */
export const distance = (m?: number | null) => (m == null ? '' : m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`);

/**
 * Find a shop by name: type, pick one from the list. Nearer shops of the same name come first when `near` is given.
 * Used for "꼭 넣을 가게", "가게 추가" and "이 가게로 바꾸기".
 */
export function ShopSearch({
  label,
  near,
  exclude = [],
  onPick,
  onClose,
  autoFocus = true,
}: {
  label: string;
  near?: { lat: number; lng: number } | null;
  exclude?: string[];
  onPick: (hit: ShopHit) => void;
  onClose?: () => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const found = useShopHits(text, near);
  const { q, loading } = found;
  const hits = found.hits.filter((h) => !exclude.includes(h.id));

  return (
    <div className="shop-search">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="shop-search-box">
        <MagnifyingGlass size={16} aria-hidden />
        <input
          id={id}
          type="search"
          value={text}
          autoFocus={autoFocus}
          autoComplete="off"
          placeholder="가게 이름 (예: 폴유, EQL)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose?.();
            if (e.key === 'Enter' && hits[0]) onPick(hits[0]);
          }}
          aria-controls={`${id}-list`}
        />
        {onClose && (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="찾기 닫기">
            <X size={16} aria-hidden />
          </button>
        )}
      </div>
      <div aria-live="polite" className="visually-hidden">
        {q && !loading ? `${hits.length}곳 찾음` : ''}
      </div>
      {q.length > 0 && (
        <ul className="shop-search-list" id={`${id}-list`}>
          {loading && <li className="hint px-2">찾는 중…</li>}
          {!loading && hits.length === 0 && <li className="hint px-2">‘{q}’ 가게를 찾지 못했어요. 이름을 조금 줄여 보세요.</li>}
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" className="shop-search-hit" onClick={() => onPick(h)}>
                <strong>{h.name}</strong>
                <span className="muted small">
                  {CATEGORY_BY_ID[h.category]?.label ?? h.category}
                  {h.distanceM != null && ` · ${distance(h.distanceM)}`}
                  {h.roadAddress && ` · ${h.roadAddress.replace(/^서울(특별시)?\s*/, '')}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
