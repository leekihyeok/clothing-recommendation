import { CaretDown, CaretUp } from '@phosphor-icons/react';
import { useState } from 'react';
import { SHOP_CATEGORIES } from './categories';

const isPhone = () => window.matchMedia('(max-width: 767.98px)').matches;

/**
 * What the marks on the map mean. Shop dots by kind (백화점·몰 are squares), or, while a course is shown, the start,
 * the numbered stops and the walking line. Every colour comes with its name; phones start folded to keep the map.
 */
export function MapLegend({ mode, nearby = false }: { mode: 'shops' | 'course'; nearby?: boolean }) {
  const [open, setOpen] = useState(() => !isPhone());
  return (
    <aside className={`map-legend${open ? ' is-open' : ''}`} aria-label="지도 표시 설명">
      <button type="button" className="map-legend-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{mode === 'course' ? '코스 표시' : '가게 종류'}</span>
        {open ? <CaretDown size={14} aria-hidden /> : <CaretUp size={14} aria-hidden />}
      </button>
      {open && (
        <ul className="map-legend-list">
          {mode === 'course' ? (
            <>
              <li>
                <span className="legend-start">START</span>출발점
              </li>
              <li>
                <span className="legend-stop">1</span>들를 가게 (순서)
              </li>
              <li>
                <span className="legend-line" />걷는 길
              </li>
              <li>
                <span className="legend-break" />카페·맛집 (넣었을 때)
              </li>
              {nearby && (
                <li>
                  <span className="legend-dot is-faint" style={{ background: 'var(--ink-3)' }} />주변 가게 (누르면 넣기)
                </li>
              )}
            </>
          ) : (
            SHOP_CATEGORIES.map((c) => (
              <li key={c.id}>
                <span className={`legend-dot${c.id === 'complex' ? ' is-square' : ''}`} style={{ background: c.color }} />
                {c.label}
              </li>
            ))
          )}
        </ul>
      )}
    </aside>
  );
}
