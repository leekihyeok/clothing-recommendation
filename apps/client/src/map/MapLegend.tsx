import { CaretDown, CaretUp } from '@phosphor-icons/react';
import { useState } from 'react';
import { SHOP_CATEGORIES } from './categories';
import { t } from '../i18n';

const isPhone = () => window.matchMedia('(max-width: 767.98px)').matches;

/**
 * What the marks on the map mean. Shop dots by kind (백화점·몰 are squares), or, while a course is shown, the start,
 * the numbered stops and the walking line. Every colour comes with its name; phones start folded to keep the map.
 */
export function MapLegend({ mode, nearby = false }: { mode: 'shops' | 'course'; nearby?: boolean }) {
  const [open, setOpen] = useState(() => !isPhone());
  return (
    <aside className={`map-legend${open ? ' is-open' : ''}`} aria-label={t('지도 표시 설명', 'Map legend')}>
      <button type="button" className="map-legend-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{mode === 'course' ? t('코스 표시', 'On the map') : t('가게 종류', 'Shop types')}</span>
        {open ? <CaretDown size={14} aria-hidden /> : <CaretUp size={14} aria-hidden />}
      </button>
      {open && (
        <ul className="map-legend-list">
          {mode === 'course' ? (
            <>
              <li>
                <span className="legend-start">START</span>{t('출발점', 'Start')}
              </li>
              <li>
                <span className="legend-stop">1</span>{t('들를 가게 (순서)', 'Stops (in order)')}
              </li>
              <li>
                <span className="legend-line" />{t('걷는 길', 'Walking route')}
              </li>
              <li>
                <span className="legend-break" />{t('카페·맛집 (넣었을 때)', 'Café / food (if added)')}
              </li>
              {nearby && (
                <li>
                  <span className="legend-dot is-faint" style={{ background: 'var(--ink-3)' }} />{t('주변 가게 (누르면 넣기)', 'Shops nearby (tap to add)')}
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
