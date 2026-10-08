import { MapPin, X } from '@phosphor-icons/react';
import { useState } from 'react';
import { CATEGORY_BY_ID } from './categories';

export interface RegionItem {
  id: string;
  name: string;
  intro?: string | null;
  shopCount: number;
  categories: { category: string; count: number }[];
}

const FIRST = 8;

// Region chips, as in PLAN.md 6.2: "동묘 · 구제 강세 · 48곳".
export function RegionBar({
  regions,
  selectedId,
  onSelect,
  picking,
  picked,
  onPick,
  onClearPick,
}: {
  regions: RegionItem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  picking: boolean;
  picked: boolean;
  onPick: () => void;
  onClearPick: () => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? regions : regions.slice(0, FIRST);
  const selected = regions.find((r) => r.id === selectedId);

  return (
    <section className="section" aria-labelledby="area-label">
      <h2 className="eyebrow" id="area-label">
        <span>Area</span>
        <span className="ko">지역</span>
      </h2>
      <div className="chip-row">
        {shown.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`chip${r.id === selectedId ? ' is-selected' : ''}`}
            aria-pressed={r.id === selectedId}
            onClick={() => onSelect(r.id === selectedId ? null : r.id)}
          >
            {r.name}
          </button>
        ))}
        {regions.length > FIRST && (
          <button type="button" className="chip is-more" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? '접기' : `${regions.length - FIRST}곳 더 보기`}
          </button>
        )}
      </div>
      <button type="button" className={`chip pick-chip${picking || picked ? ' is-selected' : ''}`} aria-pressed={picking || picked} onClick={picked ? onClearPick : onPick}>
        <MapPin size={16} weight={picked ? 'fill' : 'regular'} aria-hidden />
        {picked ? '지도에서 고른 위치' : picking ? '지도를 눌러 주세요…' : '지도에서 출발점 고르기'}
        {picked && <X size={14} aria-label="고른 위치 지우기" />}
      </button>
      {selected ? (
        <div className="region-note">
          <strong>{selected.name}</strong>
          <span className="meta tabular"> · {strongest(selected)} · {selected.shopCount.toLocaleString()}곳</span>
          {selected.intro && <div className="meta mt-1">{selected.intro}</div>}
        </div>
      ) : (
        !picked && <p className="hint">지역이나 출발점을 고르지 않으면 지도 가운데에서 시작해요.</p>
      )}
    </section>
  );
}

// The category this area has unusually many of, rather than "일반" which dominates everywhere.
function strongest(r: RegionItem): string {
  const top = r.categories.find((c) => c.category !== 'general') ?? r.categories[0];
  return top ? `${CATEGORY_BY_ID[top.category]?.label ?? top.category} ${top.count}곳` : '';
}
