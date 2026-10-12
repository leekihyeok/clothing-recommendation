import { useQuery } from '@apollo/client';
import { ArrowLeft } from '@phosphor-icons/react';
import { useState } from 'react';
import { DataHealth } from './DataHealth';
import { Logo } from '../brand/Logo';
import { graphql } from '../gql';
import { getLang, t } from '../i18n';
import { loginUrl } from '../me/useAccount';
import { useClaimDocument, useOwnerClaims, useReviewClaim } from '../shop/useOwners';
import { QualityReview } from './QualityReview';

const ReportDoc = graphql(`
  query AdminReport($days: Int!) {
    adminReport(days: $days)
  }
`);

const CatalogDoc = graphql(`
  query AdminCatalog {
    catalog { styles { id label } }
  }
`);

// Mirrors AdminReport in apps/api/src/admin/admin.service.ts (sent as one JSON string).
interface Timing { n: number; failed?: number; p50: number | null; p90: number | null }
interface Report {
  days: number;
  users: { active: number; logged_in: number; new_users: number };
  courses: {
    byMode: ({ mode: string } & Timing)[];
    courses: number; shared: number; share_opens: number; reopened: number; edited: number; started: number; completed: number; walk_mode: number;
    editsByOp: { op: string; n: number }[];
  };
  actions: ({ kind: string } & Timing)[];
  reports: { closed: number; disliked: number; liked: number; visits: number; stops_shown: number };
  ai: {
    byPurpose: { purpose: string; calls: number; failed: number; p50: number | null; tokens_in: number; tokens_out: number; cost: string }[];
    byDay: { day: string; calls: number; failed: number }[];
  };
  runs: { step: string; status: string; started: string; minutes: number | null; error: string | null; stats: string }[];
  data: { candidates: number; scored: number; verified: number; low: number; suspended: number; closed: number };
  unsure: { id: string; name: string; result: string; checked: string; detail: string }[];
  lowInCourses: { id: string; name: string; category: string; confidence: string; times: number }[];
}

const MODE = (): Record<string, string> => ({
  buttons: t('버튼·칩', 'Buttons & chips'), here: t('내 위치', 'My location'), point: t('지도에서 고른 곳', 'Picked on map'), text: t('글', 'Text'),
  photo: t('사진', 'Photo'), preset: t('추천 카드', 'Suggestion card'), again: t('다시 짜기', 'Re-plan'), saved: t('찜한 가게로', 'From saved shops'),
});
const ACTION = (): Record<string, string> => ({
  plan: t('코스 짜기', 'Plan course'), parse_text: t('글 해석', 'Read text'), parse_photo: t('사진 해석', 'Read photo'), edit: t('버튼으로 고치기', 'Edit by button'),
  edit_text: t('말로 고치기', 'Edit by text'), share: t('공유', 'Share'), share_open: t('공유 링크 열림', 'Share link opened'),
  reopen: t('지난 코스 다시 열기', 'Reopen past course'), login: t('로그인', 'Log in'),
});
// PLAN.md 13: buttons within 1-2 s, text and photo within 3-5 s.
const TARGET_MS: Record<string, number> = { plan: 2000, edit: 1500, parse_text: 5000, parse_photo: 5000, edit_text: 5000 };
const OP = (): Record<string, string> => ({
  break: t('카페·맛집 넣기·빼기', 'Add/remove café or food'), replace: t('다른 가게로', 'Swap shop'), remove: t('빼기', 'Remove'),
  move: t('순서 바꾸기', 'Reorder'), add: t('더 넣기', 'Add more'), replan: t('다시 짜기', 'Re-plan'), text: t('말로 고치기', 'Edit by text'),
});

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
const secs = (ms: number | null) => (ms == null ? '–' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const num = (n: number) => n.toLocaleString(getLang() === 'en' ? 'en-US' : 'ko-KR');

/** /admin: usage numbers and the data that needs a look. Only for ADMIN_KAKAO_IDS accounts. */
export function AdminPage() {
  const [days, setDays] = useState(30);
  const { data, loading, error } = useQuery(ReportDoc, { variables: { days }, fetchPolicy: 'network-only' });
  const r: Report | null = data ? JSON.parse(data.adminReport) : null;

  return (
    <div className="admin-page">
      <header className="admin-head">
        <a className="btn-text" href="/">
          <ArrowLeft size={14} aria-hidden /> {t('앱으로', 'Back to app')}
        </a>
        <Logo />
        <div className="chip-row" role="group" aria-label={t('기간', 'Period')}>
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" className={`chip${d === days ? ' is-selected' : ''}`} aria-pressed={d === days} onClick={() => setDays(d)}>
              {t(`최근 ${d}일`, `Last ${d} days`)}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="region-note">
          {error.message.includes('관리자') || error.message.includes('Admins only') ? (
            <>
              {t('관리자 계정으로 로그인해야 볼 수 있어요.', 'Log in with an admin account to see this.')}{' '}
              <a href={loginUrl()}>{t('카카오 로그인', 'Log in with Kakao')}</a>
            </>
          ) : (
            error.message
          )}
        </div>
      )}
      {loading && !r && <p className="hint">{t('불러오는 중…', 'Loading…')}</p>}
      {r && <DataHealth />}
      {r && <Body r={r} />}
    </div>
  );
}

function Body({ r }: { r: Report }) {
  const styleLabels = Object.fromEntries((useQuery(CatalogDoc).data?.catalog.styles ?? []).map((x) => [x.id, x.label]));
  const c = r.courses;
  const mode = MODE();
  const action = ACTION();
  const op = OP();
  const maxMode = Math.max(1, ...c.byMode.map((m) => m.n));
  const maxOp = Math.max(1, ...c.editsByOp.map((m) => m.n));
  const maxDay = Math.max(1, ...r.ai.byDay.map((m) => m.calls));
  return (
    <>
      <section className="admin-tiles" aria-label={t('요약', 'Summary')}>
        <Tile label={t('코스', 'Courses')} value={num(c.courses)} sub={t(`사용자 ${num(r.users.active)} · 로그인 ${num(r.users.logged_in)}`, `${num(r.users.active)} users · ${num(r.users.logged_in)} logged in`)} />
        <Tile label={t('공유한 코스', 'Shared')} value={pct(c.shared, c.courses)} sub={t(`${num(c.shared)}개 · 링크 열림 ${num(c.share_opens)}`, `${num(c.shared)} · ${num(c.share_opens)} link opens`)} />
        <Tile label={t('고친 코스', 'Edited')} value={pct(c.edited, c.courses)} sub={t(`${num(c.edited)}개 · 다시 연 코스 ${num(c.reopened)}`, `${num(c.edited)} · ${num(c.reopened)} reopened`)} />
        <Tile
          label={t('걸은 코스', 'Walked')}
          value={pct(c.started, c.courses)}
          sub={t(
            `다녀옴 1곳 이상 ${num(c.started)} · 완주 ${num(c.completed)} · 걷기 모드 ${num(c.walk_mode ?? 0)}`,
            `1+ visited ${num(c.started)} · finished ${num(c.completed)} · walk mode ${num(c.walk_mode ?? 0)}`,
          )}
        />
        <Tile
          label={t('폐업 신고', 'Closure reports')}
          value={r.reports.stops_shown ? `${((r.reports.closed / r.reports.stops_shown) * 100).toFixed(1)}%` : '–'}
          sub={t(
            `추천한 가게 ${num(r.reports.stops_shown)}곳 중 ${num(r.reports.closed)}건 · 별로 ${num(r.reports.disliked)}`,
            `${num(r.reports.closed)} of ${num(r.reports.stops_shown)} shops shown · ${num(r.reports.disliked)} disliked`,
          )}
        />
      </section>

      <div className="admin-grid">
        <Panel title={t('어떻게 코스를 짰나', 'How courses were planned')} en="Input">
          <table className="admin-table">
            <thead>
              <tr><th>{t('방식', 'Mode')}</th><th className="num">{t('코스', 'Courses')}</th><th>{t('비율', 'Share')}</th><th className="num">{t('계산 중간값', 'Median time')}</th><th className="num">{t('느린 10%', 'Slowest 10%')}</th></tr>
            </thead>
            <tbody>
              {c.byMode.map((m) => (
                <tr key={m.mode}>
                  <td>{mode[m.mode] ?? m.mode}</td>
                  <td className="num">{num(m.n)}</td>
                  <td><Bar value={m.n} max={maxMode} label={pct(m.n, c.courses)} /></td>
                  <td className="num">{secs(m.p50)}</td>
                  <td className="num">{secs(m.p90)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!c.byMode.length && <Empty />}
          <p className="hint">
            {t(
              "계산 시간은 2026-10-08부터 기록해요. 그 전 코스는 모두 '버튼·칩'으로 남아 있어요.",
              "Timing is recorded from 2026-10-08. Earlier courses are all logged as 'Buttons & chips'.",
            )}
          </p>
        </Panel>

        <Panel title={t('응답 시간', 'Response time')} en="Latency">
          <table className="admin-table">
            <thead>
              <tr><th>{t('동작', 'Action')}</th><th className="num">{t('횟수', 'Count')}</th><th className="num">{t('실패', 'Failed')}</th><th className="num">{t('중간값', 'Median')}</th><th className="num">{t('느린 10%', 'Slowest 10%')}</th><th>{t('목표', 'Target')}</th></tr>
            </thead>
            <tbody>
              {r.actions.map((a) => {
                const target = TARGET_MS[a.kind];
                return (
                  <tr key={a.kind}>
                    <td>{action[a.kind] ?? a.kind}</td>
                    <td className="num">{num(a.n)}</td>
                    <td className="num">{a.failed ? num(a.failed) : ''}</td>
                    <td className="num">{secs(a.p50)}</td>
                    <td className="num">{secs(a.p90)}</td>
                    <td>{target ? (a.p90 != null && a.p90 > target ? <span className="admin-flag">{t(`느림 · ${secs(target)} 넘음`, `Slow · over ${secs(target)}`)}</span> : t(`${secs(target)} 안`, `Under ${secs(target)}`)) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!r.actions.length && <Empty />}
        </Panel>

        <Panel title={t('어떻게 고쳤나', 'How courses were edited')} en="Edits">
          <table className="admin-table">
            <tbody>
              {c.editsByOp.map((o) => (
                <tr key={o.op}>
                  <td>{op[o.op] ?? o.op}</td>
                  <td className="num">{num(o.n)}</td>
                  <td><Bar value={o.n} max={maxOp} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!c.editsByOp.length && <Empty />}
        </Panel>

        <Panel title={t('가게 데이터', 'Shop data')} en="Data">
          <table className="admin-table">
            <tbody>
              <tr><td>{t('추천 후보', 'Candidates')}</td><td className="num">{num(r.data.candidates)}</td></tr>
              <tr><td>{t('스타일 채점', 'Style scored')}</td><td className="num">{num(r.data.scored)} <span className="muted">({pct(r.data.scored, r.data.candidates)})</span></td></tr>
              <tr><td>{t('검증', 'Verified')}</td><td className="num">{num(r.data.verified)}</td></tr>
              <tr><td>{t('신뢰도 낮음', 'Low confidence')}</td><td className="num">{num(r.data.low)}</td></tr>
              <tr><td>{t('신고·점검으로 숨김', 'Hidden by reports or checks')}</td><td className="num">{num(r.data.suspended)}</td></tr>
              <tr><td>{t('폐업 확정', 'Confirmed closed')}</td><td className="num">{num(r.data.closed)}</td></tr>
            </tbody>
          </table>
        </Panel>

        <Panel title={t('AI 사용', 'AI usage')} en="AI" wide>
          <table className="admin-table">
            <thead>
              <tr><th>{t('용도', 'Purpose')}</th><th className="num">{t('호출', 'Calls')}</th><th className="num">{t('실패', 'Failed')}</th><th className="num">{t('응답 중간값', 'Median time')}</th><th className="num">{t('입력 토큰', 'Tokens in')}</th><th className="num">{t('출력 토큰', 'Tokens out')}</th><th className="num">{t('비용', 'Cost')}</th></tr>
            </thead>
            <tbody>
              {r.ai.byPurpose.map((a) => (
                <tr key={a.purpose}>
                  <td>{a.purpose}</td>
                  <td className="num">{num(a.calls)}</td>
                  <td className="num">{a.failed ? `${num(a.failed)} (${pct(a.failed, a.calls)})` : ''}</td>
                  <td className="num">{secs(a.p50)}</td>
                  <td className="num">{num(a.tokens_in)}</td>
                  <td className="num">{num(a.tokens_out)}</td>
                  <td className="num">${Number(a.cost).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="admin-sub">{t('날짜별 호출', 'Calls by day')}</h3>
          <table className="admin-table">
            <tbody>
              {r.ai.byDay.map((d) => (
                <tr key={d.day}>
                  <td className="tabular">{d.day}</td>
                  <td className="num">{num(d.calls)}</td>
                  <td><Bar value={d.calls} max={maxDay} /></td>
                  <td className="num">{d.failed ? t(`실패 ${num(d.failed)}`, `${num(d.failed)} failed`) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            {t(
              'Gemini 무료 등급은 비용 $0. 실패는 대부분 하루·분당 한도(429)와 과부하(503)로, 파이프라인이 기다렸다가 다시 해요.',
              'The Gemini free tier costs $0. Most failures are daily or per-minute limits (429) and overload (503); the pipeline waits and retries.',
            )}
          </p>
        </Panel>

        <Panel title={t('손으로 볼 가게', 'Shops to check by hand')} en="Review" wide>
          <h3 className="admin-sub">{t('숨겼지만 아직 판단 못 한 곳', 'Hidden but not yet decided')}</h3>
          {r.unsure.length ? (
            <table className="admin-table">
              <thead><tr><th>{t('가게', 'Shop')}</th><th>{t('마지막 확인', 'Last checked')}</th><th>{t('결과', 'Result')}</th><th>{t('근거', 'Evidence')}</th></tr></thead>
              <tbody>
                {r.unsure.map((u) => (
                  <tr key={u.id}><td>{u.name} <span className="muted">#{u.id}</span></td><td className="tabular">{u.checked}</td><td>{u.result}</td><td className="muted small">{u.detail}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text={t('없어요', 'None')} />
          )}
          <h3 className="admin-sub">{t('신뢰도가 낮은데 코스에 자주 나온 곳', 'Low confidence but often in courses')}</h3>
          {r.lowInCourses.length ? (
            <table className="admin-table">
              <thead><tr><th>{t('가게', 'Shop')}</th><th>{t('종류', 'Category')}</th><th className="num">{t('신뢰도', 'Confidence')}</th><th className="num">{t('코스에 나온 횟수', 'Times in courses')}</th></tr></thead>
              <tbody>
                {r.lowInCourses.map((s) => (
                  <tr key={s.id}><td>{s.name} <span className="muted">#{s.id}</span></td><td>{s.category}</td><td className="num">{s.confidence}</td><td className="num">{num(s.times)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text={t('없어요', 'None')} />
          )}
        </Panel>

        <Panel title={t('표본 확인', 'Sample review')} en="Spot check" wide>
          <QualityReview styleLabels={styleLabels} />
        </Panel>

        <Panel title={t('사장님 신청', 'Owner requests')} en="Owners" wide>
          <OwnerClaims />
        </Panel>

        <Panel title={t('파이프라인 실행 기록', 'Pipeline runs')} en="Runs" wide>
          <table className="admin-table">
            <thead><tr><th>{t('시작', 'Started')}</th><th>{t('단계', 'Step')}</th><th>{t('상태', 'Status')}</th><th className="num">{t('분', 'Min')}</th><th>{t('내용', 'Details')}</th></tr></thead>
            <tbody>
              {r.runs.map((x, i) => (
                <tr key={i}>
                  <td className="tabular">{x.started}</td>
                  <td>{x.step}</td>
                  <td>{x.status === 'ok' ? 'ok' : <span className="admin-flag">{x.status}</span>}</td>
                  <td className="num">{x.minutes ?? '–'}</td>
                  <td className="muted small">{x.error ?? x.stats}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}

/** Pending owner applications: what the tax service said, then approve or reject (with a reason the applicant sees). */
/** The certificate photo of one claim, opened on demand (it's deleted once the claim is decided). */
function ClaimDocument({ id }: { id: string }) {
  const { data, loading } = useClaimDocument(id);
  if (loading) return <p className="hint">{t('불러오는 중…', 'Loading…')}</p>;
  const src = data?.ownerClaimDocument;
  if (!src) return <p className="hint">{t('사진이 없어요', 'No photo')}</p>;
  return (
    <a href={src} target="_blank" rel="noreferrer" className="claim-doc">
      <img src={src} alt={t('사업자등록증', 'Business registration certificate')} />
    </a>
  );
}

function OwnerClaims() {
  const { data, loading } = useOwnerClaims('pending');
  const [open, setOpen] = useState<string | null>(null);
  const [review, { loading: busy }] = useReviewClaim();
  const list = data?.ownerClaims ?? [];
  if (loading && !data) return <p className="hint">{t('불러오는 중…', 'Loading…')}</p>;
  if (!list.length) return <Empty text={t('확인을 기다리는 신청이 없어요', 'No requests waiting')} />;
  return (
    <table className="admin-table">
      <thead>
        <tr><th>{t('가게', 'Shop')}</th><th>{t('사업자번호 · 국세청', 'Business no. · NTS')}</th><th>{t('대표자 · 연락처', 'Owner · contact')}</th><th>{t('신청', 'Requested')}</th><th /></tr>
      </thead>
      <tbody>
        {list.map((c) => (
          <tr key={c.id}>
            <td>
              <a href={`/?shop=${c.shopId}`} target="_blank" rel="noreferrer">{c.shopName}</a>
              <div className="muted small">{c.roadAddress}</div>
            </td>
            <td className="tabular">
              {c.businessNo.replace(/(\d{3})(\d{2})(\d{5})/, '$1-$2-$3')}
              <div className="muted small">{c.nts}</div>
              {c.hasDocument ? (
                <>
                  <button type="button" className="btn-text p-0" style={{ minHeight: 32 }} aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>
                    {open === c.id ? t('사업자등록증 닫기', 'Hide certificate') : t('사업자등록증 보기', 'View certificate')}
                  </button>
                  {open === c.id && <ClaimDocument id={c.id} />}
                </>
              ) : (
                <div className="muted small">{t('사업자등록증 없음', 'No certificate')}</div>
              )}
            </td>
            <td>
              {c.ownerName} <span className="muted small">({c.nickname})</span>
              <div className="muted small">{c.contact}</div>
              {c.message && <div className="small">“{c.message}”</div>}
            </td>
            <td className="tabular">{new Date(c.createdAt as string).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR')}</td>
            <td className="admin-actions">
              <button type="button" className="btn-ink btn-small" disabled={busy} onClick={() => review({ variables: { id: c.id, approve: true } })}>
                {t('승인', 'Approve')}
              </button>
              <button
                type="button"
                className="btn-text is-danger"
                disabled={busy}
                onClick={() => {
                  const note = window.prompt(t('반려 이유 (신청한 사람의 마이페이지에 보여요)', "Reason for rejecting (shown on the applicant's My page)"));
                  if (note !== null) review({ variables: { id: c.id, approve: false, note: note || null } });
                }}
              >
                {t('반려', 'Reject')}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="admin-tile">
      <div className="admin-tile-label">{label}</div>
      <div className="admin-tile-value tabular">{value}</div>
      <div className="admin-tile-sub">{sub}</div>
    </div>
  );
}

function Panel({ title, en, wide, children }: { title: string; en: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <section className={`admin-panel${wide ? ' is-wide' : ''}`} aria-label={title}>
      <h2 className="eyebrow">
        <span>{en}</span>
        <span className="ko">{title}</span>
      </h2>
      {children}
    </section>
  );
}

/** A thin single-hue proportion bar; the number sits beside it in text colour. */
function Bar({ value, max, label }: { value: number; max: number; label?: string }) {
  return (
    <span className="admin-bar" title={label ?? String(value)}>
      <span className="admin-bar-fill" style={{ width: `${Math.max(2, (value / max) * 100)}%` }} />
      {label && <span className="admin-bar-label tabular">{label}</span>}
    </span>
  );
}

function Empty({ text }: { text?: string }) {
  return <p className="hint">{text ?? t('아직 기록이 없어요', 'No records yet')}</p>;
}
