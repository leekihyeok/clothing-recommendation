import { useQuery } from '@apollo/client';
import { Tag, X } from '@phosphor-icons/react';
import { useEffect, useId, useState } from 'react';
import { graphql } from '../gql';
import type { Planner } from './usePlanner';
import { count, t } from '../i18n';

const BrandSearchDoc = graphql(`
  query BrandSearch($q: String!) {
    brandSearch(q: $q, limit: 6) { key name nameEn shops areas }
  }
`);

const MAX_BRANDS = 5;

/**
 * "브랜드": brands to look for ("아더에러", "칼하트"). Typing shows the brands we know shops for, with how many; a
 * picked brand moves the shops carrying it well up the course. Typed text in either spelling works.
 */
export function BrandPicker({ planner }: { planner: Planner }) {
  const id = useId();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 200);
    return () => clearTimeout(timer);
  }, [text]);
  const { data, loading } = useQuery(BrandSearchDoc, { variables: { q }, skip: q.length < 2 });
  const hits = (q.length >= 2 ? (data?.brandSearch ?? []) : []).filter((b) => !planner.brands.some((x) => x.key === b.key));
  const full = planner.brands.length >= MAX_BRANDS;

  return (
    <section className="section" aria-labelledby={`${id}-label`}>
      <h2 className="eyebrow" id={`${id}-label`}>
        <span>Brand</span>
        <span className="ko">{t('브랜드', 'Brands you like')} {planner.brands.length > 0 && <span className="tabular">· {planner.brands.length}</span>}</span>
      </h2>
      {planner.brands.length > 0 && (
        <ul className="must-list">
          {planner.brands.map((b) => (
            <li key={b.key} className="must-chip">
              <Tag size={14} weight="fill" aria-hidden /> {b.name}
              <button type="button" onClick={() => planner.removeBrand(b.key)} aria-label={t(`${b.name} 빼기`, `Remove ${b.name}`)}>
                <X size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="shop-search">
        <label className="visually-hidden" htmlFor={`${id}-input`}>
          {t('브랜드 이름', 'Brand name')}
        </label>
        <div className="shop-search-box">
          <input
            id={`${id}-input`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={full ? t(`${MAX_BRANDS}개까지 고를 수 있어요`, `Up to ${MAX_BRANDS} brands`) : t('예) 아더에러, 칼하트, 살로몬', 'e.g. Ader Error, Carhartt, Salomon')}
            disabled={full}
            autoComplete="off"
            maxLength={40}
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={`${id}-list`}
          />
        </div>
        {q.length >= 2 && (
          <ul className="shop-search-list" id={`${id}-list`} role="listbox" aria-label={t('브랜드', 'Brands')}>
            {loading && !data && <li className="hint px-2">{t('찾는 중…', 'Searching…')}</li>}
            {!loading && hits.length === 0 && <li className="hint px-2">{t(`‘${q}’을 다루는 가게를 아직 몰라요.`, `We don’t know any shops carrying ‘${q}’ yet.`)}</li>}
            {hits.map((b) => (
              <li key={b.key} role="option" aria-selected={false}>
                <button
                  type="button"
                  className="shop-search-hit"
                  onClick={() => {
                    planner.addBrand({ key: b.key, name: b.name });
                    setText('');
                    setQ('');
                  }}
                >
                  <strong>{b.name}</strong>
                  <span className="muted small">
                    {b.nameEn && b.nameEn !== b.name ? `${b.nameEn} · ` : ''}{t(`가게 ${b.shops}곳`, count(b.shops, '곳', 'shop'))}
                    {b.areas.length > 0 && t(` · 주로 ${b.areas.join(', ')}`, ` · mostly ${b.areas.join(', ')}`)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="hint">
        {t(
          '고른 브랜드를 다루는 가게를 앞으로 넣어요 (브랜드 매장, 그리고 블로그 글에 그 브랜드를 판다고 나온 편집숍·빈티지숍). 글로 “아더에러 파는 데”라고 써도 돼요.',
          'Shops carrying these brands move up the course: brand stores, plus select and vintage shops that blog posts say stock them. You can also type “somewhere that sells Ader Error”.',
        )}
      </p>
    </section>
  );
}
