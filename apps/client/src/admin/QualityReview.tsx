import { useMutation, useQuery } from '@apollo/client';
import { ArrowUpRight } from '@phosphor-icons/react';
import { useState } from 'react';
import { graphql } from '../gql';
import { t } from '../i18n';
import { CATEGORY_BY_ID } from '../map/categories';

const RegionsDoc = graphql(`
  query QualityRegions {
    regions { id name shopCount }
    qualityStats { region labeled good wrongStyle wrongInfo closed }
  }
`);

const SampleDoc = graphql(`
  query QualitySample($region: String!) {
    qualitySample(region: $region, size: 10) {
      id name category summary reason confidence evidence brands placeUrl verdict
      styles { style score }
    }
  }
`);

const LabelDoc = graphql(`
  mutation LabelShop($shopId: ID!, $verdict: String!, $note: String) {
    labelShop(shopId: $shopId, verdict: $verdict, note: $note)
  }
`);

const VERDICTS = (): { id: string; label: string }[] => [
  { id: 'good', label: t('맞아요', 'Correct') },
  { id: 'wrong_style', label: t('스타일 틀림', 'Wrong style') },
  { id: 'wrong_info', label: t('정보 틀림', 'Wrong info') },
  { id: 'closed', label: t('문 닫음', 'Closed') },
];

/**
 * "표본 확인": ten random scored shops of a region, what the AI wrote and what it read, and a verdict each. Wrong ones
 * are recommended less at once, closed ones go to the closure re-check. The table shows accuracy so far per region.
 */
export function QualityReview({ styleLabels }: { styleLabels: Record<string, string> }) {
  const base = useQuery(RegionsDoc, { fetchPolicy: 'network-only' });
  const [region, setRegion] = useState<string | null>(null);
  const sample = useQuery(SampleDoc, { variables: { region: region ?? '' }, skip: !region, fetchPolicy: 'network-only' });
  const [label, { loading }] = useMutation(LabelDoc, { refetchQueries: [RegionsDoc] });
  const [given, setGiven] = useState<Record<string, string>>({});
  const regions = base.data?.regions ?? [];
  const stats = base.data?.qualityStats ?? [];

  return (
    <div>
      {stats.length > 0 && (
        <table className="admin-table mb-3">
          <thead>
            <tr><th>{t('지역', 'Area')}</th><th className="num">{t('확인', 'Checked')}</th><th className="num">{t('맞음', 'Correct')}</th><th className="num">{t('스타일 틀림', 'Wrong style')}</th><th className="num">{t('정보 틀림', 'Wrong info')}</th><th className="num">{t('문 닫음', 'Closed')}</th></tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.region}>
                <td>{s.region}</td>
                <td className="num">{s.labeled}</td>
                <td className="num">{s.good} ({Math.round((s.good / s.labeled) * 100)}%)</td>
                <td className="num">{s.wrongStyle || ''}</td>
                <td className="num">{s.wrongInfo || ''}</td>
                <td className="num">{s.closed || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="chip-row" role="group" aria-label={t('표본을 볼 지역', 'Area to sample')}>
        {regions.slice(0, 16).map((r) => (
          <button key={r.id} type="button" className={`chip${region === r.name ? ' is-selected' : ''}`} aria-pressed={region === r.name} onClick={() => setRegion(r.name)}>
            {r.name}
          </button>
        ))}
        {region && (
          <button type="button" className="chip" onClick={() => sample.refetch()}>
            {t('다른 표본', 'New sample')}
          </button>
        )}
      </div>
      {!region && (
        <p className="hint">
          {t(
            '지역을 고르면 채점된 가게 10곳을 무작위로 보여 줘요. 아직 확인하지 않은 가게가 먼저 나와요.',
            'Pick an area to see 10 random scored shops. Shops not yet checked come first.',
          )}
        </p>
      )}
      {region && sample.loading && <p className="hint">{t('불러오는 중…', 'Loading…')}</p>}
      {region && sample.data && !sample.data.qualitySample.length && <p className="hint">{t('이 지역은 아직 채점된 가게가 없어요.', 'No scored shops in this area yet.')}</p>}
      <ul className="sample-list">
        {(sample.data?.qualitySample ?? []).map((s) => {
          const verdict = given[s.id] ?? s.verdict;
          return (
            <li key={s.id} className="sample-card">
              <div className="sample-head">
                <strong>{s.name}</strong>
                <span className="muted small">
                  {CATEGORY_BY_ID[s.category]?.label ?? s.category}
                  {s.confidence != null && ` · ${t('신뢰도', 'confidence')} ${s.confidence.toFixed(2)}`}
                </span>
                {s.placeUrl && (
                  <a className="small" href={s.placeUrl} target="_blank" rel="noreferrer">
                    {t('카카오맵', 'Kakao Map')} <ArrowUpRight size={12} aria-hidden />
                  </a>
                )}
              </div>
              {s.summary && <p className="mb-1">{s.summary}</p>}
              {s.reason && <p className="muted small mb-1">{t('들를 이유', 'Why visit')}: {s.reason}</p>}
              <p className="small mb-1">
                {s.styles.length ? s.styles.map((x) => `${styleLabels[x.style] ?? x.style} ${x.score}`).join(' · ') : t('5점 넘는 스타일 없음', 'No style above 5')}
              </p>
              {s.brands.length > 0 && (
                <p className="hint mt-0">
                  {t('다루는 브랜드', 'Brands')}: {s.brands.join(', ')}
                </p>
              )}
              {s.evidence.length > 0 && (
                <ul className="sample-evidence">
                  {s.evidence.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}
              <div className="sample-verdicts" role="group" aria-label={t(`${s.name} 판정`, `Verdict for ${s.name}`)}>
                {VERDICTS().map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className={`chip${verdict === v.id ? ' is-selected' : ''}`}
                    aria-pressed={verdict === v.id}
                    disabled={loading}
                    onClick={async () => {
                      const note = v.id === 'good' ? null : window.prompt(t('무엇이 틀렸나요? (선택)', 'What was wrong? (optional)')) ?? null;
                      await label({ variables: { shopId: s.id, verdict: v.id, note } }).catch(() => undefined);
                      setGiven((g) => ({ ...g, [s.id]: v.id }));
                    }}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
