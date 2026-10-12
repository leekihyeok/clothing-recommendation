import { useQuery } from '@apollo/client';
import { ArrowClockwise, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { graphql } from '../gql';
import { getLang, t } from '../i18n';

const HealthDoc = graphql(`
  query AdminDataHealth {
    adminDataHealth
  }
`);

/** Mirrors dataHealth() in apps/api/src/admin/health.ts. */
interface Health {
  keeper: { at: string | null; step: string | null; minutesAgo: number | null; alive: boolean };
  steps: { step: string; remaining: number; last3d: number | null; etaDays: number | null }[];
  runs: { step: string; status: string; started_at: string; finished_at: string | null; error: string | null }[];
  failing: { step: string; n: number }[];
  ai: { model: string; batch: number; live: number; failed: number; cap: number; reserve: boolean }[];
  ratings: { n: number; good: number; ok: number; bad: number; notes: { rating: number; note: string; created_at: string; region: string | null }[] };
  tmap: { today: number; cap: number };
}

const STEP = (): Record<string, string> => ({
  evidence: t('근거 글 모으기', 'Collect posts'),
  score: t('스타일 채점', 'Score styles'),
  verify: t('검증', 'Verify'),
  reputation: t('블로그 평판', 'Reputation'),
  hours: t('영업시간 읽기', 'Read hours'),
  embed: t('비슷한 가게용 임베딩', 'Similar-shop embeddings'),
  translate: t('영어 번역', 'English'),
});

const num = (n: number) => n.toLocaleString(getLang() === 'en' ? 'en-US' : 'ko-KR');
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(getLang() === 'en' ? 'en-US' : 'ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–';

/** "데이터 건강": is the data work alive and moving, and is today's free AI quota holding up. */
export function DataHealth() {
  const { data, loading, error, refetch } = useQuery(HealthDoc, { fetchPolicy: 'network-only' });
  if (error) return null; // the report below already says to log in as an admin
  const h: Health | null = data ? JSON.parse(data.adminDataHealth) : null;
  const step = STEP();

  return (
    <section className="admin-panel is-wide data-health" aria-labelledby="health-title" aria-busy={loading}>
      <div className="data-health-head">
        <h2 className="eyebrow" id="health-title">
          <span>Health</span>
          <span className="ko">{t('데이터 건강', 'Data health')}</span>
        </h2>
        <button type="button" className="btn-text" onClick={() => refetch()} disabled={loading}>
          <ArrowClockwise size={14} aria-hidden /> {loading ? t('불러오는 중…', 'Loading…') : t('새로 고침', 'Refresh')}
        </button>
      </div>
      {!h ? (
        <p className="hint">{t('불러오는 중…', 'Loading…')}</p>
      ) : (
        <>
          {/* The one line that matters most: colour plus an icon and words, never colour alone. */}
          <p className={`keeper-line${h.keeper.alive ? ' is-ok' : ' is-bad'}`} role="status">
            {h.keeper.alive ? <CheckCircle size={18} weight="fill" aria-hidden /> : <WarningCircle size={18} weight="fill" aria-hidden />}
            {h.keeper.at == null
              ? t('데이터 작업 신호가 없어요. scripts/pipeline-bg.ps1로 시작해 주세요', 'No signal from the data work. Start it with scripts/pipeline-bg.ps1')
              : h.keeper.alive
                ? t(`데이터 작업이 돌고 있어요 · ${h.keeper.minutesAgo}분 전 신호 · 지금 ${h.keeper.step ?? '–'}`, `Data work is running · signal ${h.keeper.minutesAgo} min ago · now: ${h.keeper.step ?? '–'}`)
                : t(`데이터 작업이 멈춘 것 같아요 · 마지막 신호 ${when(h.keeper.at)} (${h.keeper.step ?? '–'}) · 로그를 보고 다시 시작해 주세요`, `The data work seems stopped · last signal ${when(h.keeper.at)} (${h.keeper.step ?? '–'}) · check the log and restart it`)}
          </p>

          <div className="data-health-grid">
            <div>
              <h3 className="data-health-sub">{t('단계별 남은 일', 'Work left per step')}</h3>
              <div className="table-scroll">
                <table className="admin-table">
                  <thead>
                    <tr><th>{t('단계', 'Step')}</th><th className="num">{t('남음', 'Left')}</th><th className="num">{t('최근 3일', 'Last 3 days')}</th><th className="num">{t('끝날 때까지', 'To go')}</th></tr>
                  </thead>
                  <tbody>
                    {h.steps.map((s) => (
                      <tr key={s.step}>
                        <td>{step[s.step] ?? s.step}</td>
                        <td className="num">{num(s.remaining)}</td>
                        <td className="num">{s.last3d == null ? '–' : num(s.last3d)}</td>
                        <td className="num">
                          {s.remaining === 0
                            ? t('끝', 'Done')
                            : s.etaDays == null
                              ? (s.last3d === 0 ? <span className="admin-flag">{t('멈춤', 'Stalled')}</span> : '–')
                              : t(`약 ${num(s.etaDays)}일`, `~${num(s.etaDays)} days`)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {h.failing.length > 0 && (
                <p className="hint">
                  <span className="admin-flag">{t('최근 하루 실패', 'Failed in the last day')}</span>{' '}
                  {h.failing.map((f) => `${f.step} ${f.n}`).join(' · ')}
                </p>
              )}
            </div>

            <div>
              <h3 className="data-health-sub">{t('오늘 AI 사용량 (미국 서부 자정에 초기화)', 'AI use today (resets at midnight Pacific)')}</h3>
              <div className="table-scroll">
                <table className="admin-table">
                  <thead>
                    <tr><th>{t('모델', 'Model')}</th><th className="num">{t('데이터 작업', 'Pipeline')}</th><th className="num">{t('사용자', 'People')}</th><th className="num">{t('실패', 'Failed')}</th><th>{t('한도', 'Quota')}</th></tr>
                  </thead>
                  <tbody>
                    {h.ai.map((m) => {
                      const used = m.batch + m.live;
                      const full = used >= m.cap * 0.9;
                      return (
                        <tr key={m.model}>
                          <td>
                            {m.model}
                            {m.reserve && <span className="muted small"> · {t('사용자용 예비', 'kept for people')}</span>}
                          </td>
                          <td className="num">{num(m.batch)}</td>
                          <td className="num">{num(m.live)}</td>
                          <td className="num">{m.failed ? num(m.failed) : ''}</td>
                          <td>
                            <span className="admin-bar" title={`${used} / ${m.cap}`}>
                              <span className="admin-bar-fill" style={{ width: `${Math.min(100, Math.max(2, (used / m.cap) * 100))}%` }} />
                              <span className={`admin-bar-label tabular${full ? ' admin-flag' : ''}`}>{`${num(used)}/${num(m.cap)}`}</span>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!h.ai.length && <p className="hint">{t('오늘은 아직 AI 호출이 없어요', 'No AI calls yet today')}</p>}
              <p className="hint mb-0">
                {t(
                  `T map 도보 경로 오늘 ${num(h.tmap.today)}/${num(h.tmap.cap)}회 (서울 자정에 초기화 · 넘으면 직선 거리로 어림)`,
                  `T map walking routes today ${num(h.tmap.today)}/${num(h.tmap.cap)} (resets at midnight Seoul · past it, straight-line estimates)`,
                )}
                {h.tmap.today >= h.tmap.cap * 0.9 && <span className="admin-flag"> · {t('거의 다 씀', 'almost used up')}</span>}
              </p>
            </div>

            <div>
              <h3 className="data-health-sub">{t('최근 실행', 'Recent runs')}</h3>
              <ul className="run-list">
                {h.runs.map((r, i) => (
                  <li key={i} className={r.status === 'ok' ? '' : r.status === 'running' ? 'is-running' : 'is-failed'}>
                    <span className="tabular">{when(r.started_at)}</span>
                    <span>{r.step}</span>
                    <span>{r.status === 'ok' ? t('끝', 'ok') : r.status === 'running' ? t('도는 중', 'running') : t('실패', 'failed')}</span>
                    {r.error && <span className="run-error">{r.error}</span>}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="data-health-sub">{t('걷기 후 코스 평가 (30일)', 'Route ratings after a walk (30 days)')}</h3>
              {h.ratings.n ? (
                <>
                  <p className="tabular mb-2">
                    {t(`좋았어요 ${h.ratings.good} · 그저 그랬어요 ${h.ratings.ok} · 별로였어요 ${h.ratings.bad}`, `Loved ${h.ratings.good} · OK ${h.ratings.ok} · Not great ${h.ratings.bad}`)}
                  </p>
                  <ul className="rating-notes">
                    {h.ratings.notes.map((n, i) => (
                      <li key={i}>
                        <span className="muted small">{`${n.rating > 0 ? '+' : n.rating < 0 ? '−' : '·'} ${n.region ?? ''} ${when(n.created_at)}`}</span>
                        <span>{n.note}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="hint">{t('아직 평가가 없어요', 'No ratings yet')}</p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
