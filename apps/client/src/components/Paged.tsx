import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { type ReactNode, useRef } from 'react';
import { t } from '../i18n';

export const PAGE_SIZE = 10;

/** The page a list is on, how to turn it, and the name of its page buttons ("저장한 코스 페이지"). */
export type PageProps = { page: number; onPage: (page: number) => void; label: string };

/**
 * Page numbers to show: all of them up to five, else five slots with gaps (null) — first, last and the current one
 * ("1 … 4 … 9"), so the row fits a phone with 44px buttons.
 */
export function pageSlots(current: number, pages: number): (number | null)[] {
  if (pages <= 5) return Array.from({ length: pages }, (_, i) => i + 1);
  if (current <= 2) return [1, 2, 3, null, pages];
  if (current >= pages - 1) return [1, null, pages - 2, pages - 1, pages];
  return [1, null, current, null, pages];
}

/**
 * One page of a long list, page buttons under it (none when it all fits). The page lives with the caller, so a tab
 * keeps its page while another is open; past the last page (items removed meanwhile) it shows the last one.
 */
export function Paged<T>({ items, page, onPage, label, children }: PageProps & { items: T[]; children: (shown: T[]) => ReactNode }) {
  const top = useRef<HTMLDivElement>(null);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const from = (current - 1) * PAGE_SIZE;
  const shown = items.slice(from, from + PAGE_SIZE);

  // A new page starts at its top: the list scrolls back into view and takes focus, so a keyboard or screen reader
  // continues from the first item instead of the page buttons.
  function go(p: number) {
    onPage(p);
    requestAnimationFrame(() => {
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      top.current?.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
      top.current?.focus({ preventScroll: true });
    });
  }

  return (
    <div ref={top} tabIndex={-1} className="paged">
      {children(shown)}
      {pages > 1 && (
        <nav className="pager" aria-label={label}>
          <button type="button" className="pager-step" disabled={current === 1} onClick={() => go(current - 1)} aria-label={t('이전 페이지', 'Previous page')}>
            <CaretLeft size={16} aria-hidden />
          </button>
          {pageSlots(current, pages).map((p, i) =>
            p === null ? (
              <span key={`gap-${i}`} className="pager-gap" aria-hidden>
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                className="pager-num tabular"
                aria-current={p === current ? 'page' : undefined}
                aria-label={t(`${p}페이지`, `Page ${p}`)}
                onClick={() => p !== current && go(p)}
              >
                {p}
              </button>
            ),
          )}
          <button type="button" className="pager-step" disabled={current === pages} onClick={() => go(current + 1)} aria-label={t('다음 페이지', 'Next page')}>
            <CaretRight size={16} aria-hidden />
          </button>
          <p className="pager-range tabular" aria-live="polite">
            {t(`${from + 1}–${from + shown.length} / 전체 ${items.length}개`, `${from + 1}–${from + shown.length} of ${items.length}`)}
          </p>
        </nav>
      )}
    </div>
  );
}
