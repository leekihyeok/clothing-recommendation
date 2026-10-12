import { useQuery } from '@apollo/client';
import { ArrowRight, CaretLeft, CaretRight } from '@phosphor-icons/react';
import { useRef } from 'react';
import { graphql } from '../gql';
import type { PresetsQuery } from '../gql/graphql';
import { count, t } from '../i18n';

const PresetsDoc = graphql(`
  query Presets {
    presets(limit: 8) { id title intro regionId regionName styles stopCount }
  }
`);

export type PresetItem = PresetsQuery['presets'][number];

/** "이런 코스 어때요": ready-made ideas (pipeline.presets). One tap plans the course. */
export function PresetRow({ onPick, disabled }: { onPick: (p: PresetItem) => void; disabled: boolean }) {
  const presets = useQuery(PresetsDoc, { fetchPolicy: 'cache-and-network' }).data?.presets ?? [];
  const row = useRef<HTMLUListElement>(null);
  if (!presets.length) return null;
  // Mouse users can't swipe the strip, so they get buttons (shown only for a fine pointer, see .preset-nav).
  const page = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * row.current.clientWidth * 0.8, behavior: 'smooth' });
  return (
    <section className="section" aria-labelledby="ideas-label">
      <h2 className="eyebrow" id="ideas-label">
        <span>Ideas</span>
        <span className="ko">{t('이런 코스 어때요', 'Try one of these')}</span>
      </h2>
      <ul className="preset-row" ref={row}>
        {presets.map((p) => (
          <li key={p.id}>
            <button type="button" className="preset-card" disabled={disabled} onClick={() => onPick(p)}>
              <span className="preset-meta tabular">
                {p.regionName} · {count(p.stopCount, '곳', 'shop')}
              </span>
              <span className="preset-title">{p.title}</span>
              {p.intro && <span className="preset-intro">{p.intro}</span>}
              <ArrowRight className="preset-go" size={16} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <div className="preset-nav">
        <button type="button" aria-label={t('이전 코스 카드', 'Previous ideas')} onClick={() => page(-1)}>
          <CaretLeft size={16} />
        </button>
        <button type="button" aria-label={t('다음 코스 카드', 'More ideas')} onClick={() => page(1)}>
          <CaretRight size={16} />
        </button>
      </div>
    </section>
  );
}
