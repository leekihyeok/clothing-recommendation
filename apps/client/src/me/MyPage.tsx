import { ArrowLeft, Camera, Heart, PencilSimple, Path, Storefront, Trash } from '@phosphor-icons/react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { useMyCourses, useSavedCourses } from '../course/useSavedCourses';
import { CATEGORY_BY_ID } from '../map/categories';
import { Avatar, Stars } from '../shop/ShopDetail';
import { forgetAnonId } from './anonId';
import { AccountBox } from './AccountBox';
import { logoutUrl, useAccount } from './useAccount';
import { type MyShopItem, useForgetMe, useMyShops } from './useMyShops';
import { useMyReviews, useProfile, useProfileEdits, useTaste } from './useProfile';
import { useMyOwnerStatus } from '../shop/useOwners';
import { requireLogin } from './LoginModal';

const RATING: Record<number, string> = { 1: '좋았어요', [-1]: '별로였어요' };

type Tab = 'courses' | 'saved' | 'visited' | 'reviews' | 'recent';
const TABS: { id: Tab; label: string; login: boolean }[] = [
  { id: 'courses', label: '저장한 코스', login: true },
  { id: 'saved', label: '찜한 가게', login: true },
  { id: 'visited', label: '다녀온 곳', login: false },
  { id: 'reviews', label: '내 후기', login: true },
  { id: 'recent', label: '최근 코스', login: false },
];

interface Props {
  onClose: () => void;
  onOpenCourse: (id: string) => void;
  onOpenShop: (id: string, at: { lat: number; lng: number } | null) => void;
  styleLabels: Record<string, string>;
  /** One line from the login round trip (logged in / cancelled / failed / logged out). */
  notice?: string | null;
}

/** 마이페이지: profile, then saved courses, saved shops, visits, my reviews and recent courses in tabs. */
export function MyPage({ onClose, onOpenCourse, onOpenShop, styleLabels, notice = null }: Props) {
  const account = useAccount();
  const loggedIn = account?.loggedIn === true;
  // Until a tab is picked, the default follows the login state, which arrives after the first render.
  const [picked, setTab] = useState<Tab | null>(null);
  const tab: Tab = picked ?? (loggedIn ? 'courses' : 'visited');
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  function onTabKey(e: KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current.get(TABS[next].id)?.focus();
  }

  const active = TABS.find((t) => t.id === tab)!;
  return (
    <div className="my-page">
      <button type="button" className="btn-text mb-2" onClick={onClose}>
        <ArrowLeft size={14} aria-hidden /> 코스 만들기로
      </button>
      <h2 className="course-title mb-3">마이페이지</h2>

      {loggedIn ? <ProfileCard notice={notice} /> : <AccountBox notice={notice} />}
      <TasteCard styleLabels={styleLabels} />
      {loggedIn && <OwnerStatus onOpenShop={(id) => onOpenShop(id, null)} />}

      <div className="my-tabs" role="tablist" aria-label="내 기록" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              if (el) tabRefs.current.set(t.id, el);
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="my-panel">
        {active.login && !loggedIn ? (
          <div className="empty-state">
            <p>{active.label}은(는) 로그인하면 볼 수 있어요.</p>
            <button type="button" className="btn-line" onClick={() => requireLogin(`${active.label}을(를) 보려면 로그인해 주세요.`)}>
              로그인하기
            </button>
          </div>
        ) : tab === 'courses' ? (
          <SavedCoursesList styleLabels={styleLabels} onOpen={onOpenCourse} />
        ) : tab === 'recent' ? (
          <RecentCoursesList styleLabels={styleLabels} onOpen={onOpenCourse} />
        ) : tab === 'reviews' ? (
          <MyReviewsList onOpen={(id) => onOpenShop(id, null)} />
        ) : (
          <ShopsList which={tab} onOpen={(s) => onOpenShop(s.shop.id, { lat: s.shop.lat, lng: s.shop.lng })} />
        )}
      </div>

      <LeaveSection loggedIn={loggedIn} />
    </div>
  );
}

function ProfileCard({ notice }: { notice: string | null }) {
  const profile = useProfile().data?.myProfile;
  const account = useAccount();
  const edits = useProfileEdits();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  if (!profile) return <p className="hint">불러오는 중…</p>;

  return (
    <section className="profile-card" aria-label="프로필">
      {notice && (
        <p className="account-notice" role="status">
          {notice}
        </p>
      )}
      <div className="profile-row">
        <div className="profile-photo">
          <Avatar name={profile.nickname} url={profile.avatarUrl} size={64} />
          <button
            type="button"
            className="photo-btn"
            aria-label="프로필 사진 바꾸기"
            disabled={edits.avatarState.loading}
            onClick={() => file.current?.click()}
          >
            <Camera size={16} />
          </button>
          <input
            ref={file}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setError(null);
              await edits.setAvatar(f).catch((err: Error) => setError(err.message));
            }}
          />
        </div>
        <div className="profile-text">
          {editing ? (
            <form
              className="nickname-form"
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                const ok = await edits.setNickname(name).then(() => true, (err: Error) => (setError(err.message), false));
                if (ok) setEditing(false);
              }}
            >
              <label htmlFor="nickname" className="field-label mt-0">
                닉네임 (2~20자)
              </label>
              <div className="d-flex gap-2">
                <input id="nickname" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="nickname" />
                <button type="submit" className="btn-ink btn-small" disabled={edits.nicknameState.loading}>
                  저장
                </button>
              </div>
              <button type="button" className="btn-text p-0" style={{ minHeight: 32 }} onClick={() => setEditing(false)}>
                취소
              </button>
            </form>
          ) : (
            <>
              <strong className="profile-name">{profile.nickname}</strong>
              <button
                type="button"
                className="btn-text p-0"
                style={{ minHeight: 32 }}
                onClick={() => {
                  setName(profile.nickname);
                  setEditing(true);
                }}
              >
                <PencilSimple size={14} aria-hidden /> 닉네임 바꾸기
              </button>
            </>
          )}
          <span className="hint mt-0 tabular">
            카카오 계정 · 저장한 코스 {profile.savedCourses} · 후기 {profile.reviews}
          </span>
        </div>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="profile-links">
        {profile.avatarUrl && (
          <button type="button" className="btn-text" disabled={edits.removeState.loading} onClick={() => edits.removeAvatar()}>
            사진 지우기
          </button>
        )}
        {account?.isAdmin && (
          <a className="btn-text" href="/admin">
            관리자 화면
          </a>
        )}
        <a className="btn-text" href={logoutUrl()}>
          로그아웃
        </a>
      </div>
    </section>
  );
}

const CLAIM_STATUS: Record<string, string> = { pending: '확인 중', approved: '승인됨', rejected: '반려됨', withdrawn: '취소함' };

/** Shops this person runs (open one to edit it there), and their owner applications. Hidden when there are none. */
function OwnerStatus({ onOpenShop }: { onOpenShop: (id: string) => void }) {
  const data = useMyOwnerStatus().data;
  const owned = data?.ownedShops ?? [];
  const claims = (data?.myClaims ?? []).filter((c) => c.status !== 'approved');
  if (!owned.length && !claims.length) return null;
  return (
    <section className="section" aria-labelledby="owner-status-label">
      <h3 className="eyebrow" id="owner-status-label">
        <span>Owner</span>
        <span className="ko">사장님</span>
      </h3>
      <ul className="my-list">
        {owned.map((s) => (
          <li key={s.shopId}>
            <button type="button" onClick={() => onOpenShop(s.shopId)}>
              <Storefront size={16} aria-hidden />
              <span className="name">{s.shopName}</span>
              <span className="meta">정보 고치기</span>
            </button>
          </li>
        ))}
        {claims.map((c) => (
          <li key={c.id}>
            <button type="button" onClick={() => onOpenShop(c.shopId)}>
              <Storefront size={16} aria-hidden />
              <span className="name">
                {c.shopName}
                {c.reviewNote && <span className="sub">{c.reviewNote}</span>}
              </span>
              <span className="meta">신청 {CLAIM_STATUS[c.status] ?? c.status}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const PRICE: Record<string, string> = { low: '저렴한 편', mid: '보통', high: '비싼 편' };

/** What the app has learnt about the person's taste, and that it shapes their courses. */
function TasteCard({ styleLabels }: { styleLabels: Record<string, string> }) {
  const taste = useTaste().data?.myTaste;
  if (!taste) return null;
  const max = Math.max(0.01, ...taste.likes.map((l) => l.weight));
  return (
    <section className="section taste-card" aria-labelledby="taste-label">
      <h3 className="eyebrow" id="taste-label">
        <span>Taste</span>
        <span className="ko">내 취향</span>
      </h3>
      {!taste.active ? (
        <p className="hint mt-0">
          찜하거나 '좋았어요', 별점을 남기면 취향을 배워서 다음 코스에 반영해요. 지금 {taste.signals}곳을 알고 있어요.
        </p>
      ) : (
        <>
          <ul className="taste-bars">
            {taste.likes.map((l) => (
              <li key={l.style}>
                <span>{styleLabels[l.style] ?? l.style}</span>
                <span className="admin-bar-fill" style={{ width: `${Math.max(4, (l.weight / max) * 100)}%` }} aria-hidden />
              </li>
            ))}
          </ul>
          <p className="hint mt-2">
            {taste.avoids.length > 0 && <>덜 고르는 쪽: {taste.avoids.map((a) => styleLabels[a.style] ?? a.style).join(' · ')}. </>}
            {taste.price && <>가격은 주로 {PRICE[taste.price] ?? taste.price}. </>}
            가게 {taste.signals}곳의 기록으로 배웠고, 최근 기록일수록 크게 반영해요. 코스를 짤 때 이 쪽으로 기울이고, 최근 코스에 나온 가게 대신 새 가게를 섞어요.
          </p>
        </>
      )}
    </section>
  );
}

const when = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
};

type CourseLike = {
  id: string;
  createdAt: unknown;
  startName?: string | null;
  request: { styles: string[]; regionName?: string | null };
  variants: { stops: { order: number; shop?: { name: string } }[] }[];
};

function CourseRows({ courses, styleLabels, onOpen }: { courses: CourseLike[]; styleLabels: Record<string, string>; onOpen: (id: string) => void }) {
  return (
    <ul className="my-list">
      {courses.map((c) => {
        const stops = c.variants[0]?.stops ?? [];
        const names = stops.map((s) => s.shop?.name).filter(Boolean);
        return (
          <li key={c.id}>
            <button type="button" onClick={() => onOpen(c.id)}>
              <Path size={16} aria-hidden />
              <span className="name">
                {c.request.regionName ?? c.startName ?? '이 근처'} · {c.request.styles.map((s) => styleLabels[s] ?? s).join(' · ') || '둘러보기'}
                {names.length > 0 && <span className="sub">{names.slice(0, 3).join(' → ')}{names.length > 3 ? ' …' : ''}</span>}
              </span>
              <span className="meta tabular">
                {stops.length}곳 · {when(c.createdAt as string)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function SavedCoursesList({ styleLabels, onOpen }: { styleLabels: Record<string, string>; onOpen: (id: string) => void }) {
  const { data, loading } = useSavedCourses();
  const list = data?.savedCourses ?? [];
  if (loading && !data) return <p className="hint">불러오는 중…</p>;
  if (!list.length) return <Empty text="저장한 코스가 없어요. 코스 화면의 '저장'을 누르면 여기 모여요." />;
  return <CourseRows courses={list} styleLabels={styleLabels} onOpen={onOpen} />;
}

function RecentCoursesList({ styleLabels, onOpen }: { styleLabels: Record<string, string>; onOpen: (id: string) => void }) {
  const list = useMyCourses().data?.myCourses ?? [];
  if (!list.length) return <Empty text="아직 짠 코스가 없어요." />;
  return <CourseRows courses={list} styleLabels={styleLabels} onOpen={onOpen} />;
}

function ShopsList({ which, onOpen }: { which: 'saved' | 'visited'; onOpen: (x: MyShopItem) => void }) {
  const { data, loading } = useMyShops();
  const mine = data?.myShops;
  if (loading && !mine) return <p className="hint">불러오는 중…</p>;
  const items = which === 'saved' ? mine?.saved ?? [] : mine?.visited ?? [];
  if (!items.length) {
    return (
      <Empty
        icon={<Heart size={16} aria-hidden />}
        text={which === 'saved' ? '찜한 가게가 없어요. 가게 화면이나 코스 카드의 ♡를 눌러 보세요.' : "다녀온 가게가 없어요. 코스를 걷고 '다녀왔어요'를 눌러 보세요."}
      />
    );
  }
  return (
    <ul className="my-list">
      {items.map((x) => (
        <li key={x.shop.id} className={x.shop.status === 'closed' || x.shop.status === 'suspended' ? 'is-gone' : ''}>
          <button type="button" onClick={() => onOpen(x)}>
            <span className="chip-dot" style={{ background: CATEGORY_BY_ID[x.shop.category]?.color }} aria-hidden />
            <span className="name">
              {x.shop.name}
              {x.shop.status === 'closed' && <span className="tag is-gone">폐업</span>}
              {x.shop.status === 'suspended' && <span className="tag is-gone">문 닫음 신고 · 확인 중</span>}
            </span>
            <span className="meta">
              {which === 'saved'
                ? CATEGORY_BY_ID[x.shop.category]?.label ?? ''
                : [x.state.visits > 1 ? `${x.state.visits}번` : '', RATING[x.state.rating] ?? '', x.state.purchased ? '샀어요' : ''].filter(Boolean).join(' · ')}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function MyReviewsList({ onOpen }: { onOpen: (shopId: string) => void }) {
  const { data, loading } = useMyReviews();
  const list = data?.myReviews ?? [];
  if (loading && !data) return <p className="hint">불러오는 중…</p>;
  if (!list.length) return <Empty text="쓴 후기가 없어요. 다녀온 가게 화면에서 별점과 후기를 남겨 보세요." />;
  return (
    <ul className="my-list">
      {list.map((r) => (
        <li key={r.id}>
          <button type="button" onClick={() => onOpen(r.shopId)}>
            <span className="chip-dot" style={{ background: CATEGORY_BY_ID[r.category]?.color }} aria-hidden />
            <span className="name">
              {r.shopName}
              {r.body && <span className="sub">{r.body}</span>}
            </span>
            <span className="meta" aria-label={`별점 ${r.rating}점`}>
              <Stars value={r.rating} size={12} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Empty({ text, icon }: { text: string; icon?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <p>
        {icon} {text}
      </p>
    </div>
  );
}

/** Destructive actions, apart from everything else: 회원 탈퇴 (logged in) or clearing this browser's records. */
function LeaveSection({ loggedIn }: { loggedIn: boolean }) {
  const edits = useProfileEdits();
  const [forget, forgetState] = useForgetMe();
  return (
    <section className="danger-zone" aria-label={loggedIn ? '회원 탈퇴' : '기록 지우기'}>
      {loggedIn ? (
        <button
          type="button"
          className="btn-text is-danger"
          disabled={edits.deleteState.loading}
          onClick={async () => {
            if (!window.confirm('탈퇴하면 찜, 다녀온 곳, 후기, 저장한 코스가 모두 지워지고 되돌릴 수 없어요. 탈퇴할까요?')) return;
            const res = await edits.deleteAccount().catch(() => null);
            if (!res?.data) return;
            forgetAnonId();
            if (!res.data.deleteAccount.kakaoUnlinked) {
              window.alert('탈퇴했어요. 카카오 계정의 연결 앱 목록에서 ROUTE 01 연결도 끊을 수 있어요(카카오톡 설정 > 카카오계정 > 연결된 서비스 관리).');
            }
            window.location.href = logoutUrl('/');
          }}
        >
          <Trash size={14} aria-hidden /> 회원 탈퇴
        </button>
      ) : (
        <button
          type="button"
          className="btn-text is-danger"
          disabled={forgetState.loading}
          onClick={async () => {
            if (!window.confirm('이 브라우저의 다녀온 곳과 최근 코스 기록을 모두 지울까요? 되돌릴 수 없어요.')) return;
            await forget().catch(() => undefined);
            forgetAnonId();
            window.location.reload();
          }}
        >
          <Trash size={14} aria-hidden /> 이 브라우저 기록 지우기
        </button>
      )}
    </section>
  );
}
