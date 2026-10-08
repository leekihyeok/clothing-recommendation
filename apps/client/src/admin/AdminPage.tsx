import { useQuery } from '@apollo/client';
import { ArrowLeft } from '@phosphor-icons/react';
import { useState } from 'react';
import { Logo } from '../brand/Logo';
import { graphql } from '../gql';
import { loginUrl } from '../me/useAccount';
import { useOwnerClaims, useReviewClaim } from '../shop/useOwners';
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
    courses: number; shared: number; share_opens: number; reopened: number; edited: number; started: number; completed: number;
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

const MODE: Record<string, string> = {
  buttons: '버튼·칩', here: '내 위치', point: '지도에서 고른 곳', text: '글', photo: '사진', preset: '추천 카드', again: '다시 짜기',
};
const ACTION: Record<string, string> = {
  plan: '코스 짜기', parse_text: '글 해석', parse_photo: '사진 해석', edit: '버튼으로 고치기', edit_text: '말로 고치기',
  share: '공유', share_open: '공유 링크 열림', reopen: '지난 코스 다시 열기', login: '로그인',
};
// PLAN.md 13: buttons within 1-2 s, text and photo within 3-5 s.
const TARGET_MS: Record<string, number> = { plan: 2000, edit: 1500, parse_text: 5000, parse_photo: 5000, edit_text: 5000 };
const OP: Record<string, string> = { break: '카페·맛집 넣기·빼기', replace: '다른 가게로', remove: '빼기', move: '순서 바꾸기', add: '더 넣기', replan: '다시 짜기', text: '말로 고치기' };

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
const secs = (ms: number | null) => (ms == null ? '–' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const num = (n: number) => n.toLocaleString('ko-KR');

/** /admin: usage numbers and the data that needs a look. Only for ADMIN_KAKAO_IDS accounts. */
export function AdminPage() {
  const [days, setDays] = useState(30);
  const { data, loading, error } = useQuery(ReportDoc, { variables: { days }, fetchPolicy: 'network-only' });
  const r: Report | null = data ? JSON.parse(data.adminReport) : null;

  return (
    <div className="admin-page">
      <header className="admin-head">
        <a className="btn-text" href="/">
          <ArrowLeft size={14} aria-hidden /> 앱으로
        </a>
        <Logo />
        <div className="chip-row" role="group" aria-label="기간">
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" className={`chip${d === days ? ' is-selected' : ''}`} aria-pressed={d === days} onClick={() => setDays(d)}>
              최근 {d}일
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="region-note">
          {error.message.includes('관리자') ? (
            <>
              관리자 계정으로 로그인해야 볼 수 있어요. <a href={loginUrl()}>카카오 로그인</a>
            </>
          ) : (
            error.message
          )}
        </div>
      )}
      {loading && !r && <p className="hint">불러오는 중…</p>}
      {r && <Body r={r} />}
    </div>
  );
}

function Body({ r }: { r: Report }) {
  const styleLabels = Object.fromEntries((useQuery(CatalogDoc).data?.catalog.styles ?? []).map((x) => [x.id, x.label]));
  const c = r.courses;
  const maxMode = Math.max(1, ...c.byMode.map((m) => m.n));
  const maxOp = Math.max(1, ...c.editsByOp.map((m) => m.n));
  const maxDay = Math.max(1, ...r.ai.byDay.map((m) => m.calls));
  return (
    <>
      <section className="admin-tiles" aria-label="요약">
        <Tile label="코스" value={num(c.courses)} sub={`사용자 ${num(r.users.active)} · 로그인 ${num(r.users.logged_in)}`} />
        <Tile label="공유한 코스" value={pct(c.shared, c.courses)} sub={`${num(c.shared)}개 · 링크 열림 ${num(c.share_opens)}`} />
        <Tile label="고친 코스" value={pct(c.edited, c.courses)} sub={`${num(c.edited)}개 · 다시 연 코스 ${num(c.reopened)}`} />
        <Tile label="걸은 코스" value={pct(c.started, c.courses)} sub={`다녀옴 1곳 이상 ${num(c.started)} · 완주 ${num(c.completed)}`} />
        <Tile
          label="폐업 신고"
          value={r.reports.stops_shown ? `${((r.reports.closed / r.reports.stops_shown) * 100).toFixed(1)}%` : '–'}
          sub={`추천한 가게 ${num(r.reports.stops_shown)}곳 중 ${num(r.reports.closed)}건 · 별로 ${num(r.reports.disliked)}`}
        />
      </section>

      <div className="admin-grid">
        <Panel title="어떻게 코스를 짰나" en="Input">
          <table className="admin-table">
            <thead>
              <tr><th>방식</th><th className="num">코스</th><th>비율</th><th className="num">계산 중간값</th><th className="num">느린 10%</th></tr>
            </thead>
            <tbody>
              {c.byMode.map((m) => (
                <tr key={m.mode}>
                  <td>{MODE[m.mode] ?? m.mode}</td>
                  <td className="num">{num(m.n)}</td>
                  <td><Bar value={m.n} max={maxMode} label={pct(m.n, c.courses)} /></td>
                  <td className="num">{secs(m.p50)}</td>
                  <td className="num">{secs(m.p90)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!c.byMode.length && <Empty />}
          <p className="hint">계산 시간은 2026-10-08부터 기록해요. 그 전 코스는 모두 '버튼·칩'으로 남아 있어요.</p>
        </Panel>

        <Panel title="응답 시간" en="Latency">
          <table className="admin-table">
            <thead>
              <tr><th>동작</th><th className="num">횟수</th><th className="num">실패</th><th className="num">중간값</th><th className="num">느린 10%</th><th>목표</th></tr>
            </thead>
            <tbody>
              {r.actions.map((a) => {
                const target = TARGET_MS[a.kind];
                return (
                  <tr key={a.kind}>
                    <td>{ACTION[a.kind] ?? a.kind}</td>
                    <td className="num">{num(a.n)}</td>
                    <td className="num">{a.failed ? num(a.failed) : ''}</td>
                    <td className="num">{secs(a.p50)}</td>
                    <td className="num">{secs(a.p90)}</td>
                    <td>{target ? (a.p90 != null && a.p90 > target ? <span className="admin-flag">느림 · {secs(target)} 넘음</span> : `${secs(target)} 안`) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!r.actions.length && <Empty />}
        </Panel>

        <Panel title="어떻게 고쳤나" en="Edits">
          <table className="admin-table">
            <tbody>
              {c.editsByOp.map((o) => (
                <tr key={o.op}>
                  <td>{OP[o.op] ?? o.op}</td>
                  <td className="num">{num(o.n)}</td>
                  <td><Bar value={o.n} max={maxOp} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!c.editsByOp.length && <Empty />}
        </Panel>

        <Panel title="가게 데이터" en="Data">
          <table className="admin-table">
            <tbody>
              <tr><td>추천 후보</td><td className="num">{num(r.data.candidates)}</td></tr>
              <tr><td>스타일 채점</td><td className="num">{num(r.data.scored)} <span className="muted">({pct(r.data.scored, r.data.candidates)})</span></td></tr>
              <tr><td>검증</td><td className="num">{num(r.data.verified)}</td></tr>
              <tr><td>신뢰도 낮음</td><td className="num">{num(r.data.low)}</td></tr>
              <tr><td>신고·점검으로 숨김</td><td className="num">{num(r.data.suspended)}</td></tr>
              <tr><td>폐업 확정</td><td className="num">{num(r.data.closed)}</td></tr>
            </tbody>
          </table>
        </Panel>

        <Panel title="AI 사용" en="AI" wide>
          <table className="admin-table">
            <thead>
              <tr><th>용도</th><th className="num">호출</th><th className="num">실패</th><th className="num">응답 중간값</th><th className="num">입력 토큰</th><th className="num">출력 토큰</th><th className="num">비용</th></tr>
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
          <h3 className="admin-sub">날짜별 호출</h3>
          <table className="admin-table">
            <tbody>
              {r.ai.byDay.map((d) => (
                <tr key={d.day}>
                  <td className="tabular">{d.day}</td>
                  <td className="num">{num(d.calls)}</td>
                  <td><Bar value={d.calls} max={maxDay} /></td>
                  <td className="num">{d.failed ? `실패 ${num(d.failed)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">Gemini 무료 등급은 비용 $0. 실패는 대부분 하루·분당 한도(429)와 과부하(503)로, 파이프라인이 기다렸다가 다시 해요.</p>
        </Panel>

        <Panel title="손으로 볼 가게" en="Review" wide>
          <h3 className="admin-sub">숨겼지만 아직 판단 못 한 곳</h3>
          {r.unsure.length ? (
            <table className="admin-table">
              <thead><tr><th>가게</th><th>마지막 확인</th><th>결과</th><th>근거</th></tr></thead>
              <tbody>
                {r.unsure.map((u) => (
                  <tr key={u.id}><td>{u.name} <span className="muted">#{u.id}</span></td><td className="tabular">{u.checked}</td><td>{u.result}</td><td className="muted small">{u.detail}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="없어요" />
          )}
          <h3 className="admin-sub">신뢰도가 낮은데 코스에 자주 나온 곳</h3>
          {r.lowInCourses.length ? (
            <table className="admin-table">
              <thead><tr><th>가게</th><th>종류</th><th className="num">신뢰도</th><th className="num">코스에 나온 횟수</th></tr></thead>
              <tbody>
                {r.lowInCourses.map((s) => (
                  <tr key={s.id}><td>{s.name} <span className="muted">#{s.id}</span></td><td>{s.category}</td><td className="num">{s.confidence}</td><td className="num">{num(s.times)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text="없어요" />
          )}
        </Panel>

        <Panel title="표본 확인" en="Spot check" wide>
          <QualityReview styleLabels={styleLabels} />
        </Panel>

        <Panel title="사장님 신청" en="Owners" wide>
          <OwnerClaims />
        </Panel>

        <Panel title="파이프라인 실행 기록" en="Runs" wide>
          <table className="admin-table">
            <thead><tr><th>시작</th><th>단계</th><th>상태</th><th className="num">분</th><th>내용</th></tr></thead>
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
function OwnerClaims() {
  const { data, loading } = useOwnerClaims('pending');
  const [review, { loading: busy }] = useReviewClaim();
  const list = data?.ownerClaims ?? [];
  if (loading && !data) return <p className="hint">불러오는 중…</p>;
  if (!list.length) return <Empty text="확인을 기다리는 신청이 없어요" />;
  return (
    <table className="admin-table">
      <thead>
        <tr><th>가게</th><th>사업자번호 · 국세청</th><th>대표자 · 연락처</th><th>신청</th><th /></tr>
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
            </td>
            <td>
              {c.ownerName} <span className="muted small">({c.nickname})</span>
              <div className="muted small">{c.contact}</div>
              {c.message && <div className="small">“{c.message}”</div>}
            </td>
            <td className="tabular">{new Date(c.createdAt as string).toLocaleDateString('ko-KR')}</td>
            <td className="admin-actions">
              <button type="button" className="btn-ink btn-small" disabled={busy} onClick={() => review({ variables: { id: c.id, approve: true } })}>
                승인
              </button>
              <button
                type="button"
                className="btn-text is-danger"
                disabled={busy}
                onClick={() => {
                  const note = window.prompt('반려 이유 (신청한 사람의 마이페이지에 보여요)');
                  if (note !== null) review({ variables: { id: c.id, approve: false, note: note || null } });
                }}
              >
                반려
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

function Empty({ text = '아직 기록이 없어요' }: { text?: string }) {
  return <p className="hint">{text}</p>;
}
