import { ArrowLeft, ArrowRight, Camera, Heart, PencilSimple, Path, Storefront, Trash } from '@phosphor-icons/react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { useMyCourses, useSavedCourses } from '../course/useSavedCourses';
import { count, getLang, t } from '../i18n';
import { CATEGORY_BY_ID } from '../map/categories';
import { Avatar, categoryLabel, Stars } from '../shop/ShopDetail';
import { forgetAnonId } from './anonId';
import { AccountBox } from './AccountBox';
import { logoutUrl, useAccount } from './useAccount';
import { type MyShopItem, useForgetMe, useMyShops, useSavedGroups } from './useMyShops';
import type { SavedGroupLike } from '../course/usePlanner';
import { useMyReviews, useProfile, useProfileEdits, useTaste } from './useProfile';
import { useMyOwnerStatus } from '../shop/useOwners';
import { requireLogin } from './LoginModal';
import { SavedNewsList, useNewNewsCount } from '../shop/ShopNews';

const RATING = (): Record<number, string> => ({ 1: t('좋았어요', 'Liked it'), [-1]: t('별로였어요', 'Not for me') });

type Tab = 'courses' | 'saved' | 'news' | 'visited' | 'reviews' | 'recent';
const tabs = (): { id: Tab; label: string; login: boolean }[] => [
  { id: 'courses', label: t('저장한 코스', 'Saved courses'), login: true },
  { id: 'saved', label: t('찜한 가게', 'Saved shops'), login: true },
  { id: 'news', label: t('가게 소식', 'Shop news'), login: true },
  { id: 'visited', label: t('다녀온 곳', 'Visited'), login: false },
  { id: 'reviews', label: t('내 후기', 'Your reviews'), login: true },
  { id: 'recent', label: t('최근 코스', 'Recent courses'), login: false },
];

interface Props {
  onClose: () => void;
  onOpenCourse: (id: string) => void;
  onOpenShop: (id: string, at: { lat: number; lng: number } | null) => void;
  styleLabels: Record<string, string>;
  /** One line from the login round trip (logged in / cancelled / failed / logged out). */
  notice?: string | null;
  /** "찜한 가게로 코스 짜기" for one neighbourhood of saved shops. */
  onPlanSaved: (g: SavedGroupLike) => void;
  busy: boolean;
}

/** 마이페이지: profile, then saved courses, saved shops, visits, my reviews and recent courses in tabs. */
export function MyPage({ onClose, onOpenCourse, onOpenShop, styleLabels, notice = null, onPlanSaved, busy }: Props) {
  const account = useAccount();
  const loggedIn = account?.loggedIn === true;
  // Until a tab is picked, the default follows the login state, which arrives after the first render.
  const [picked, setTab] = useState<Tab | null>(null);
  const tab: Tab = picked ?? (loggedIn ? 'courses' : 'visited');
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const TABS = tabs();

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  function onTabKey(e: KeyboardEvent) {
    const i = TABS.findIndex((x) => x.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current.get(TABS[next].id)?.focus();
  }

  const active = TABS.find((x) => x.id === tab)!;
  const unread = useNewNewsCount(!loggedIn);
  return (
    <div className="my-page">
      <button type="button" className="btn-text mb-2" onClick={onClose}>
        <ArrowLeft size={14} aria-hidden /> {t('코스 만들기로', 'Back to planning')}
      </button>
      <h2 className="course-title mb-3">{t('마이페이지', 'My page')}</h2>

      {loggedIn ? <ProfileCard notice={notice} /> : <AccountBox notice={notice} />}
      <TasteCard styleLabels={styleLabels} />
      {loggedIn && <OwnerStatus onOpenShop={(id) => onOpenShop(id, null)} />}

      <div className="my-tabs" role="tablist" aria-label={t('내 기록', 'My records')} onKeyDown={onTabKey}>
        {TABS.map((x) => (
          <button
            key={x.id}
            ref={(el) => {
              if (el) tabRefs.current.set(x.id, el);
            }}
            type="button"
            role="tab"
            id={`tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`panel-${x.id}`}
            tabIndex={tab === x.id ? 0 : -1}
            onClick={() => setTab(x.id)}
          >
            {x.label}
            {x.id === 'news' && unread > 0 && tab !== 'news' && (
              <span className="tab-count tabular" aria-label={t(`새 소식 ${unread}개`, `${unread} new`)}>
                {unread}
              </span>
            )}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="my-panel">
        {active.login && !loggedIn ? (
          <div className="empty-state">
            <p>{t(`${active.label}은(는) 로그인하면 볼 수 있어요.`, `Log in to see ${active.label.toLowerCase()}.`)}</p>
            <button
              type="button"
              className="btn-line"
              onClick={() => requireLogin(t(`${active.label}을(를) 보려면 로그인해 주세요.`, `Please log in to see ${active.label.toLowerCase()}.`))}
            >
              {t('로그인하기', 'Log in')}
            </button>
          </div>
        ) : tab === 'courses' ? (
          <SavedCoursesList styleLabels={styleLabels} onOpen={onOpenCourse} />
        ) : tab === 'recent' ? (
          <RecentCoursesList styleLabels={styleLabels} onOpen={onOpenCourse} />
        ) : tab === 'news' ? (
          <SavedNewsList onOpenShop={(id) => onOpenShop(id, null)} />
        ) : tab === 'reviews' ? (
          <MyReviewsList onOpen={(id) => onOpenShop(id, null)} />
        ) : (
          <>
            {tab === 'saved' && <SavedCourseBox onPlan={onPlanSaved} busy={busy} />}
            <ShopsList which={tab} onOpen={(s) => onOpenShop(s.shop.id, { lat: s.shop.lat, lng: s.shop.lng })} />
          </>
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
  if (!profile) return <p className="hint">{t('불러오는 중…', 'Loading…')}</p>;

  return (
    <section className="profile-card" aria-label={t('프로필', 'Profile')}>
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
            aria-label={t('프로필 사진 바꾸기', 'Change profile photo')}
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
                {t('닉네임 (2~20자)', 'Nickname (2–20 characters)')}
              </label>
              <div className="d-flex gap-2">
                <input id="nickname" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="nickname" />
                <button type="submit" className="btn-ink btn-small" disabled={edits.nicknameState.loading}>
                  {t('저장', 'Save')}
                </button>
              </div>
              <button type="button" className="btn-text p-0" style={{ minHeight: 32 }} onClick={() => setEditing(false)}>
                {t('취소', 'Cancel')}
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
                <PencilSimple size={14} aria-hidden /> {t('닉네임 바꾸기', 'Change nickname')}
              </button>
            </>
          )}
          <span className="hint mt-0 tabular">
            {t(
              `카카오 계정 · 저장한 코스 ${profile.savedCourses} · 후기 ${profile.reviews}`,
              `Kakao account · ${count(profile.savedCourses, '', 'saved course')} · ${count(profile.reviews, '', 'review')}`,
            )}
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
            {t('사진 지우기', 'Remove photo')}
          </button>
        )}
        {account?.isAdmin && (
          <a className="btn-text" href="/admin">
            {t('관리자 화면', 'Admin')}
          </a>
        )}
        <a className="btn-text" href={logoutUrl()}>
          {t('로그아웃', 'Log out')}
        </a>
      </div>
    </section>
  );
}

const CLAIM_STATUS = (): Record<string, string> => ({
  pending: t('확인 중', 'in review'),
  approved: t('승인됨', 'approved'),
  rejected: t('반려됨', 'declined'),
  withdrawn: t('취소함', 'withdrawn'),
});

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
        <span className="ko">{t('사장님', 'Your shops')}</span>
      </h3>
      <ul className="my-list">
        {owned.map((s) => (
          <li key={s.shopId}>
            <button type="button" onClick={() => onOpenShop(s.shopId)}>
              <Storefront size={16} aria-hidden />
              <span className="name">{s.shopName}</span>
              <span className="meta">{t('정보 고치기', 'Edit info')}</span>
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
              <span className="meta">
                {t('신청', 'Claim')} {CLAIM_STATUS()[c.status] ?? c.status}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const PRICE = (): Record<string, string> => ({ low: t('저렴한 편', 'on the affordable side'), mid: t('보통', 'mid-range'), high: t('비싼 편', 'on the pricey side') });

/** What the app has learnt about the person's taste, and that it shapes their courses. */
function TasteCard({ styleLabels }: { styleLabels: Record<string, string> }) {
  const taste = useTaste().data?.myTaste;
  if (!taste) return null;
  const max = Math.max(0.01, ...taste.likes.map((l) => l.weight));
  return (
    <section className="section taste-card" aria-labelledby="taste-label">
      <h3 className="eyebrow" id="taste-label">
        <span>Taste</span>
        <span className="ko">{t('내 취향', 'Your taste')}</span>
      </h3>
      {!taste.active ? (
        <p className="hint mt-0">
          {t(
            `찜하거나 '좋았어요', 별점을 남기면 취향을 배워서 다음 코스에 반영해요. 지금 ${taste.signals}곳을 알고 있어요.`,
            `Save shops, tap "Liked it" or leave ratings, and we'll learn your taste for your next course. So far we know ${count(taste.signals, '', 'shop')}.`,
          )}
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
            {taste.avoids.length > 0 && <>{t('덜 고르는 쪽', 'Less your thing')}: {taste.avoids.map((a) => styleLabels[a.style] ?? a.style).join(' · ')}. </>}
            {taste.price && <>{t('가격은 주로', 'Prices mostly')} {PRICE()[taste.price] ?? taste.price}. </>}
            {t(
              `가게 ${taste.signals}곳의 기록으로 배웠고, 최근 기록일수록 크게 반영해요. 코스를 짤 때 이 쪽으로 기울이고, 최근 코스에 나온 가게 대신 새 가게를 섞어요.`,
              `Learned from ${count(taste.signals, '', 'shop')}, with recent ones counting more. Courses lean this way, and mix in new shops instead of ones from your recent courses.`,
            )}
          </p>
        </>
      )}
    </section>
  );
}

const when = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(getLang() === 'en' ? 'en-US' : 'ko-KR', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', getLang() === 'en' ? { month: 'short', day: 'numeric' } : { month: 'numeric', day: 'numeric' });
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
                {c.request.regionName ?? c.startName ?? t('이 근처', 'Nearby')} · {c.request.styles.map((s) => styleLabels[s] ?? s).join(' · ') || t('둘러보기', 'Browsing')}
                {names.length > 0 && <span className="sub">{names.slice(0, 3).join(' → ')}{names.length > 3 ? ' …' : ''}</span>}
              </span>
              <span className="meta tabular">
                {count(stops.length, '곳', 'stop')} · {when(c.createdAt as string)}
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
  if (loading && !data) return <p className="hint">{t('불러오는 중…', 'Loading…')}</p>;
  if (!list.length) return <Empty text={t("저장한 코스가 없어요. 코스 화면의 '저장'을 누르면 여기 모여요.", 'No saved courses yet. Tap "Save" on a course and it shows up here.')} />;
  return <CourseRows courses={list} styleLabels={styleLabels} onOpen={onOpen} />;
}

function RecentCoursesList({ styleLabels, onOpen }: { styleLabels: Record<string, string>; onOpen: (id: string) => void }) {
  const list = useMyCourses().data?.myCourses ?? [];
  if (!list.length) return <Empty text={t('아직 짠 코스가 없어요.', "You haven't planned a course yet.")} />;
  return <CourseRows courses={list} styleLabels={styleLabels} onOpen={onOpen} />;
}

/**
 * "찜한 가게로 코스 짜기": one button per neighbourhood of saved shops ("성수 · 찜 5곳"). Saved shops across Seoul aren't
 * one walk, so each neighbourhood is its own course; more than 8 there, the 8 most recent go in.
 */
function SavedCourseBox({ onPlan, busy }: { onPlan: (g: SavedGroupLike) => void; busy: boolean }) {
  const groups = useSavedGroups().data?.mySavedGroups ?? [];
  if (!groups.length) return null;
  return (
    <section className="saved-plan" aria-labelledby="saved-plan-label">
      <h3 id="saved-plan-label">{t('찜한 가게로 코스 짜기', 'Plan a course from saved shops')}</h3>
      <p className="hint mt-0">
        {t(
          '동네마다 찜한 곳을 모두 넣고 걷는 순서를 맞춰요. 적으면 비슷한 가게를 몇 곳 더 넣어요.',
          'One course per neighborhood with all your saved shops, in walking order. If there are only a few, we add some similar ones.',
        )}
      </p>
      <ul>
        {groups.slice(0, 6).map((g) => (
          <li key={g.regionId ?? g.name}>
            <button type="button" className="saved-plan-btn" disabled={busy} onClick={() => onPlan(g)}>
              <span className="saved-plan-text">
                <strong>{g.name}</strong>
                <span>
                  {t(`찜 ${g.shops.length}곳`, `${g.shops.length} saved`)} · {g.shops.slice(0, 3).map((x) => x.name).join(', ')}
                  {g.shops.length > 3 ? ' …' : ''}
                </span>
              </span>
              <ArrowRight size={18} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {groups.some((g) => g.shops.length > 8) && <p className="hint mb-0">{t('한 코스에는 찜한 곳을 8곳까지 넣어요 (최근 순).', 'A course takes up to 8 saved shops (most recent first).')}</p>}
    </section>
  );
}

function ShopsList({ which, onOpen }: { which: 'saved' | 'visited'; onOpen: (x: MyShopItem) => void }) {
  const { data, loading } = useMyShops();
  const mine = data?.myShops;
  if (loading && !mine) return <p className="hint">{t('불러오는 중…', 'Loading…')}</p>;
  const items = which === 'saved' ? mine?.saved ?? [] : mine?.visited ?? [];
  if (!items.length) {
    return (
      <Empty
        icon={<Heart size={16} aria-hidden />}
        text={
          which === 'saved'
            ? t('찜한 가게가 없어요. 가게 화면이나 코스 카드의 ♡를 눌러 보세요.', 'No saved shops yet. Tap ♡ on a shop page or course card.')
            : t("다녀온 가게가 없어요. 코스를 걷고 '다녀왔어요'를 눌러 보세요.", 'No visited shops yet. Walk a course and tap "I went".')
        }
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
              {x.shop.status === 'closed' && <span className="tag is-gone">{t('폐업', 'Closed')}</span>}
              {x.shop.status === 'suspended' && <span className="tag is-gone">{t('문 닫음 신고 · 확인 중', 'Reported closed · checking')}</span>}
            </span>
            <span className="meta">
              {which === 'saved'
                ? categoryLabel(x.shop.category) ?? ''
                : [x.state.visits > 1 ? t(`${x.state.visits}번`, `${x.state.visits} times`) : '', RATING()[x.state.rating] ?? '', x.state.purchased ? t('샀어요', 'Bought') : '']
                    .filter(Boolean)
                    .join(' · ')}
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
  if (loading && !data) return <p className="hint">{t('불러오는 중…', 'Loading…')}</p>;
  if (!list.length) return <Empty text={t('쓴 후기가 없어요. 다녀온 가게 화면에서 별점과 후기를 남겨 보세요.', 'No reviews yet. Rate and review a shop you visited from its page.')} />;
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
            <span className="meta" aria-label={t(`별점 ${r.rating}점`, `Rated ${r.rating} out of 5`)}>
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
    <section className="danger-zone" aria-label={loggedIn ? t('회원 탈퇴', 'Delete account') : t('기록 지우기', 'Clear history')}>
      {loggedIn ? (
        <button
          type="button"
          className="btn-text is-danger"
          disabled={edits.deleteState.loading}
          onClick={async () => {
            if (!window.confirm(
                t(
                  '탈퇴하면 찜, 다녀온 곳, 후기, 저장한 코스가 모두 지워지고 되돌릴 수 없어요. 탈퇴할까요?',
                  'Deleting your account removes your saved shops, visits, reviews and saved courses for good. Delete your account?',
                ),
              )) return;
            const res = await edits.deleteAccount().catch(() => null);
            if (!res?.data) return;
            forgetAnonId();
            if (!res.data.deleteAccount.kakaoUnlinked) {
              window.alert(
                t(
                  '탈퇴했어요. 카카오 계정의 연결 앱 목록에서 ROUTE 01 연결도 끊을 수 있어요(카카오톡 설정 > 카카오계정 > 연결된 서비스 관리).',
                  'Your account is deleted. You can also disconnect ROUTE 01 in your Kakao account (KakaoTalk Settings > Kakao Account > Connected services).',
                ),
              );
            }
            window.location.href = logoutUrl('/');
          }}
        >
          <Trash size={14} aria-hidden /> {t('회원 탈퇴', 'Delete account')}
        </button>
      ) : (
        <button
          type="button"
          className="btn-text is-danger"
          disabled={forgetState.loading}
          onClick={async () => {
            if (!window.confirm(
                t('이 브라우저의 다녀온 곳과 최근 코스 기록을 모두 지울까요? 되돌릴 수 없어요.', "Clear all visits and recent courses in this browser? This can't be undone."),
              )) return;
            await forget().catch(() => undefined);
            forgetAnonId();
            window.location.reload();
          }}
        >
          <Trash size={14} aria-hidden /> {t('이 브라우저 기록 지우기', 'Clear this browser’s history')}
        </button>
      )}
    </section>
  );
}
