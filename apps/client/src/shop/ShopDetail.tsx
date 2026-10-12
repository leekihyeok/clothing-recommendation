import { useMutation, useQuery } from '@apollo/client';
import {
  ArrowLeft, ArrowsClockwise, ArrowUpRight, CaretDown, CaretUp, Check, Globe, Heart, Plus, InstagramLogo, LinkSimple, MapPin, MapTrifold, Phone, SealCheck, Star, StarHalf, Storefront, Trash, Warning,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { graphql } from '../gql';
import type { ShopDetailQuery } from '../gql/graphql';
import { count, getLang, t } from '../i18n';
import { CATEGORY_BY_ID } from '../map/categories';
import { requireLogin } from '../me/LoginModal';
import { RatePrompt } from '../me/ShopActions';
import { useAccount } from '../me/useAccount';
import { useRecordShop, useShopStates } from '../me/useMyShops';
import { ClaimForm, DAYS, OwnerEditor } from './OwnerForms';
import { NewsForm, NewsSection } from './ShopNews';

const ShopDetailDoc = graphql(`
  query ShopDetail($id: ID!) {
    shop(id: $id) {
      id name kind category status lat lng roadAddress phone placeUrl inMarket summary reason priceRange items littleKnown
      styles { style score }
      saves visitors
      rating { average count histogram }
      blog { score posts pros cons }
      combined { score basis }
      posts { title url postedOn source }
      myReview { id rating body createdAt updatedAt mine author { nickname avatarUrl } }
      isOwner
      photos { url sourceUrl source matched }
      owner { hours { closed open close } hoursNote intro instagram phone website photos updatedAt openNow today }
    }
  }
`);

// Asked separately so the page shows without waiting for the similarity search.
const SimilarDoc = graphql(`
  query ShopSimilar($id: ID!) {
    shop(id: $id) {
      id
      similar(limit: 6) { id name kind category lat lng distanceM reason }
    }
  }
`);

const ReviewsDoc = graphql(`
  query ShopReviews($shopId: ID!, $offset: Int!) {
    shopReviews(shopId: $shopId, offset: $offset) { id rating body createdAt updatedAt mine author { nickname avatarUrl } }
  }
`);

const SaveReviewDoc = graphql(`
  mutation SaveReview($shopId: ID!, $rating: Int!, $body: String) {
    saveReview(shopId: $shopId, rating: $rating, body: $body) { id }
  }
`);

const DeleteReviewDoc = graphql(`
  mutation DeleteReview($shopId: ID!) {
    deleteReview(shopId: $shopId)
  }
`);

type Detail = NonNullable<ShopDetailQuery['shop']>;
type ReviewItem = NonNullable<Detail['myReview']>;

const PRICE_LABEL = (): Record<string, string> => ({ low: t('저렴한 편', 'Affordable'), mid: t('보통', 'Mid-range'), high: t('비싼 편', 'Pricey') });
// DAYS (OwnerForms) are Korean; English weekday names for this page.
const DAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const dayName = (i: number) => (getLang() === 'en' ? DAYS_EN[i] : DAYS[i]);
/** The shop kind in the app's language (map/categories.ts labels follow it). */
export const categoryLabel = (id: string): string | undefined => CATEGORY_BY_ID[id]?.label;
const PAGE = 10;

interface Props {
  /** The shop's place, once loaded: the map shows it (a shared shop link, back / forward, a similar shop …). */
  onPlace?: (p: { lat: number; lng: number; name: string }) => void;
  shopId: string;
  onBack: () => void;
  /** Another shop's page (from "여기 좋았다면"). */
  onOpenShop: (id: string) => void;
  styleLabels: Record<string, string>;
  itemLabels: Record<string, string>;
  /** The course on screen, if any: this page can put the shop into it. */
  course?: CourseSlots | null;
}

export interface CourseSlots {
  stops: { order: number; id: string; name: string }[];
  /** null = wherever it adds the least walking; a number = instead of that stop. */
  onPut: (order: number | null) => Promise<void>;
  busy: boolean;
}

// Matches MAX_STOPS in apps/api/src/course/course.service.ts.
const COURSE_MAX = 20;

/** "이 코스에 넣기" / "N번 대신 넣기", when a course is open and the shop isn't in it yet. */
function PutInCourse({ course, open }: { course: CourseSlots; open: boolean }) {
  const [instead, setInstead] = useState(false);
  if (!open) {
    return (
      <div className="region-note mt-3" role="note">
        {t('문을 닫았거나 확인 중인 가게라 코스에 넣을 수 없어요.', "This shop is closed or being checked, so it can't go in a course.")}
      </div>
    );
  }
  return (
    <section className="course-put" aria-labelledby="put-label">
      <h3 className="eyebrow" id="put-label">
        <span>Course</span>
        <span className="ko">{t('지금 코스에 넣기', 'Add to this course')}</span>
      </h3>
      <button type="button" className="btn-ink w-100" disabled={course.busy || course.stops.length >= COURSE_MAX} onClick={() => course.onPut(null)}>
        <Plus size={16} aria-hidden /> {t('이 코스에 넣기', 'Add to course')}
      </button>
      <p className="hint">{course.stops.length >= COURSE_MAX
          ? t(`코스에는 ${COURSE_MAX}곳까지 넣을 수 있어요.`, `A course can have up to ${COURSE_MAX} shops.`)
          : t('걷는 길이 가장 덜 늘어나는 자리에 넣어요.', 'It goes where it adds the least walking.')}</p>
      <button
        type="button"
        className="put-disclose"
        aria-expanded={instead}
        aria-controls="put-instead-list"
        onClick={() => setInstead(!instead)}
      >
        <span>{t('다른 가게 대신 넣기', 'Swap for another shop')}</span>
        {instead ? <CaretUp size={14} aria-hidden /> : <CaretDown size={14} aria-hidden />}
      </button>
      {instead && (
        <ul className="put-list" id="put-instead-list">
          {course.stops.map((s) => (
            <li key={s.id}>
              <button type="button" disabled={course.busy} onClick={() => course.onPut(s.order)} aria-label={t(`${s.order}번 ${s.name} 대신 넣기`, `Swap for stop ${s.order}, ${s.name}`)}>
                <span className="put-num" aria-hidden>
                  {String(s.order).padStart(2, '0')}
                </span>
                <span className="put-name">{s.name}</span>
                <span className="put-action" aria-hidden>
                  <ArrowsClockwise size={14} /> {t('대신 넣기', 'Swap')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const far = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m / 10) * 10}m`);

/** "여기 좋았다면": shops most like this one (pipeline.embed), nearer ones a little ahead. Hidden when there are none. */
function SimilarShops({ shopId, onOpen }: { shopId: string; onOpen: (id: string) => void }) {
  const list = useQuery(SimilarDoc, { variables: { id: shopId } }).data?.shop?.similar ?? [];
  if (!list.length) return null;
  return (
    <section className="section" aria-labelledby="similar-label">
      <h3 className="eyebrow" id="similar-label">
        <span>Similar</span>
        <span className="ko">{t('여기 좋았다면', 'If you liked this')}</span>
      </h3>
      <ul className="similar-list">
        {list.map((x) => (
          <li key={x.id}>
            <button type="button" onClick={() => onOpen(x.id)}>
              <span className="chip-dot" style={{ background: CATEGORY_BY_ID[x.category]?.color }} aria-hidden />
              <span className="similar-text">
                <strong>{x.name}</strong>
                <span>{x.reason}</span>
              </span>
              <span className="similar-meta tabular">
                {categoryLabel(x.category) ?? ''}
                <br />
                {far(x.distanceM)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Shop detail: what we know, people's saves and visits, the combined rating, reviews, and the posts behind it all. */
export function ShopDetail({ shopId, onBack, onOpenShop, styleLabels, itemLabels, course, onPlace }: Props) {
  const { data, loading, error, refetch } = useQuery(ShopDetailDoc, { variables: { id: shopId }, fetchPolicy: 'cache-and-network' });
  const shop = data?.shop;
  const states = useShopStates([shopId]);
  const { record, busy } = useRecordShop();
  const mine = states.get(shopId) ?? { saved: false, visits: 0 };
  const loggedIn = useAccount()?.loggedIn === true;
  const [mode, setMode] = useState<'view' | 'claim' | 'edit' | 'news'>('view');
  useEffect(() => {
    if (shop) onPlace?.({ lat: shop.lat, lng: shop.lng, name: shop.name });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop?.id]);
  // Opening a shop counts as a view ("자주 본 곳"); the API counts one per shop per 10 minutes.
  useEffect(() => {
    record(shopId, 'view');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  if (!shop) {
    return (
      <div>
        <BackButton onBack={onBack} />
        {loading ? <p className="hint">{t('불러오는 중…', 'Loading…')}</p> : <p className="hint">{error?.message ?? t('가게를 찾지 못했어요', "We couldn't find this shop")}</p>}
      </div>
    );
  }
  const category = CATEGORY_BY_ID[shop.category];
  if (mode === 'claim') return <ClaimForm shopId={shop.id} shopName={shop.name} onBack={() => setMode('view')} />;
  if (mode === 'news') return <NewsForm shopId={shop.id} shopName={shop.name} onDone={() => setMode('view')} />;
  if (mode === 'edit') {
    return (
      <OwnerEditor
        shopId={shop.id}
        initial={shop.owner ?? null}
        onDone={() => {
          setMode('view');
          refetch();
        }}
      />
    );
  }
  const phone = shop.owner?.phone ?? shop.phone;

  return (
    <article className="shop-detail" aria-labelledby="shop-title">
      <div className="d-flex justify-content-between align-items-center">
        <BackButton onBack={onBack} />
        <CopyLink shopId={shop.id} />
      </div>

      <p className="eyebrow mt-2 mb-1">
        <span className="d-inline-flex align-items-center gap-1">
          <span className={`legend-dot${shop.kind === 'complex' ? ' is-square' : ''}`} style={{ background: category?.color }} aria-hidden />
          {categoryLabel(shop.category) ?? shop.category}
          {shop.inMarket && t(' · 전통시장', ' · Traditional market')}
        </span>
        {shop.priceRange && PRICE_LABEL()[shop.priceRange] && <span className="ko">{PRICE_LABEL()[shop.priceRange]}</span>}
      </p>
      <h2 className="course-title" id="shop-title">
        {shop.name}
      </h2>
      {shop.status !== 'candidate' && (
        <div className="region-note mt-3 is-warning" role="note">
          <Warning size={14} aria-hidden /> {shop.status === 'closed'
            ? t('문을 닫은 가게예요. 코스에는 넣지 않아요.', 'This shop has closed. We leave it out of courses.')
            : t('문 닫힘 신고가 들어와 확인하는 중이에요. 그동안 코스에는 넣지 않아요.', "Someone reported it closed and we're checking. Until then, it stays out of courses.")}
        </div>
      )}

      {course &&
        (course.stops.some((s) => s.id === shop.id) ? (
          <div className="region-note mt-3" role="note">
            {t(
              `지금 코스의 ${course.stops.find((s) => s.id === shop.id)!.order}번 가게예요.`,
              `This is stop ${course.stops.find((s) => s.id === shop.id)!.order} in your course.`,
            )}
          </div>
        ) : (
          <PutInCourse course={course} open={shop.status === 'candidate'} />
        ))}

      <ul className="detail-facts">
        {shop.roadAddress && (
          <li>
            <MapPin size={16} aria-hidden /> {shop.roadAddress}
          </li>
        )}
        {phone && (
          <li>
            <Phone size={16} aria-hidden /> <a href={`tel:${phone}`}>{phone}</a>
          </li>
        )}
        {shop.owner?.instagram && (
          <li>
            <InstagramLogo size={16} aria-hidden />{' '}
            <a href={`https://www.instagram.com/${shop.owner.instagram}/`} target="_blank" rel="noreferrer">
              @{shop.owner.instagram}
            </a>
          </li>
        )}
        {shop.owner?.website && (
          <li>
            <Globe size={16} aria-hidden />{' '}
            <a href={shop.owner.website} target="_blank" rel="noreferrer noopener">
              {shop.owner.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')} <ArrowUpRight size={12} aria-hidden />
            </a>
          </li>
        )}
      </ul>
      <NewsSection shopId={shop.id} isOwner={shop.isOwner} onWrite={() => setMode('news')} />
      {shop.owner && <OwnerSection owner={shop.owner} />}

      <PhotoStrip shop={shop} />

      {/* Three actions, one look: same size, outlined, filled in ink when on. */}
      <div className="detail-actions" role="group" aria-label={t('이 가게', 'This shop')}>
        <button
          type="button"
          className={`action-btn${mine.saved ? ' is-on' : ''}`}
          aria-pressed={mine.saved}
          disabled={busy}
          onClick={async () => {
            await record(shop.id, mine.saved ? 'unsave' : 'save');
            refetch();
          }}
        >
          <Heart size={18} weight={mine.saved ? 'fill' : 'regular'} aria-hidden />
          <span>{t('찜', 'Save')}</span>
          <span className="tabular count">{shop.saves.toLocaleString()}</span>
        </button>
        <button
          type="button"
          className={`action-btn${mine.visits > 0 ? ' is-on' : ''}`}
          aria-pressed={mine.visits > 0}
          disabled={busy}
          onClick={async () => {
            await record(shop.id, mine.visits > 0 ? 'unvisit' : 'visit');
            refetch();
          }}
        >
          <Check size={18} weight={mine.visits > 0 ? 'bold' : 'regular'} aria-hidden />
          <span>{mine.visits > 0 ? t('다녀옴', 'Visited') : t('다녀왔어요', 'I went')}</span>
        </button>
        {shop.placeUrl ? (
          <a className="action-btn" href={shop.placeUrl} target="_blank" rel="noreferrer">
            <MapTrifold size={18} aria-hidden />
            <span>{t('카카오맵', 'Kakao Map')}</span>
            <ArrowUpRight size={12} aria-hidden />
          </a>
        ) : (
          <span className="action-btn is-disabled" aria-disabled="true">
            <MapTrifold size={18} aria-hidden />
            <span>{t('카카오맵 없음', 'No Kakao Map')}</span>
          </span>
        )}
      </div>
      <div className="detail-sub">
        <span className="hint mt-0 tabular">{t(`다녀온 사람 ${shop.visitors.toLocaleString()}명`, `${shop.visitors.toLocaleString()} ${shop.visitors === 1 ? 'visitor' : 'visitors'}`)}</span>
        <RatePrompt shopId={shop.id} state={states.get(shop.id)} />
      </div>

      <RatingBlock shop={shop} />

      {(shop.summary || shop.reason || shop.styles.length > 0) && (
        <section className="section" aria-labelledby="about-label">
          <h3 className="eyebrow" id="about-label">
            <span>About</span>
            <span className="ko">{t('어떤 가게', 'About this shop')}</span>
          </h3>
          {shop.summary && <p className="detail-summary">{shop.summary}</p>}
          {shop.reason && <p className="detail-reason">{shop.reason}</p>}
          {shop.styles.length > 0 && (
            <div className="detail-tags" aria-label={t('스타일', 'Styles')}>
              {shop.styles.map((s) => (
                <span key={s.style} className="tag">
                  {styleLabels[s.style] ?? s.style} <span className="tabular">{s.score}</span>
                </span>
              ))}
            </div>
          )}
          {shop.items.length > 0 && <p className="hint">{t('주로 파는 것', 'Mostly sells')}: {shop.items.map((i) => itemLabels[i] ?? i).join(' · ')}</p>}
          {shop.littleKnown && <p className="hint">
              {t(
                '아직 이 가게를 다룬 글을 찾지 못해서, 소개가 가게 종류에서 나온 추정이에요.',
                "We haven't found any posts about this shop yet, so this description is a guess based on its type.",
              )}
            </p>}
        </section>
      )}

      <SimilarShops shopId={shop.id} onOpen={onOpenShop} />

      <Reviews shop={shop} onChanged={() => refetch()} />

      {shop.posts.length > 0 && (
        <section className="section" aria-labelledby="posts-label">
          <h3 className="eyebrow" id="posts-label">
            <span>Sources</span>
            <span className="ko">{t('이 가게를 다룬 글', 'Posts about this shop')}</span>
          </h3>
          <ul className="detail-posts">
            {shop.posts.map((p) => (
              <li key={p.url}>
                <a href={p.url} target="_blank" rel="noreferrer">
                  <span className="meta tabular">
                    {p.source}
                    {p.postedOn && ` · ${p.postedOn}`}
                  </span>
                  <span className="title">{p.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="hint">
        {t(
          '카카오맵·네이버의 후기와 평점은 각 서비스에서 볼 수 있어요. 여기 평점은 ROUTE 01 후기와 모아 둔 블로그 글로 계산해요.',
          'Kakao Map and Naver reviews and ratings are on their own apps. The rating here comes from ROUTE 01 reviews and the blog posts we collected.',
        )}
      </p>

      <div className="owner-entry">
        {shop.isOwner ? (
          <button type="button" className="btn-line" onClick={() => setMode('edit')}>
            <Storefront size={16} aria-hidden /> {t('가게 정보 고치기 (사장님)', 'Edit shop info (owner)')}
          </button>
        ) : (
          <button
            type="button"
            className="btn-text"
            onClick={() => (loggedIn ? setMode('claim') : requireLogin(t('사장님 신청은 로그인한 뒤에 할 수 있어요.', 'Log in to claim this shop as its owner.')))}
          >
            <Storefront size={14} aria-hidden /> {t('이 가게 사장님이세요?', 'Own this shop?')}
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * Photos at the top: the owner's own when there are any, otherwise pictures from the image search, each linking to
 * the post it came from. Search pictures not confirmed to be this shop say so.
 */
function PhotoStrip({ shop }: { shop: Detail }) {
  const own = shop.owner?.photos ?? [];
  const list = own.length ? own.map((url) => ({ url, sourceUrl: null, source: t('사장님', 'Owner'), matched: true })) : shop.photos;
  if (!list.length) return null;
  const unsure = !own.length && list.some((p) => !p.matched);
  return (
    <section className="photo-strip" aria-label={t('가게 사진', 'Shop photos')}>
      <ul>
        {list.map((p) => (
          <li key={p.url}>
            {p.sourceUrl ? (
              <a href={p.sourceUrl} target="_blank" rel="noreferrer" aria-label={t(`사진 출처 ${p.source}에서 보기`, `View photo source on ${p.source}`)}>
                <img src={p.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                <span className="photo-source">{p.source}</span>
              </a>
            ) : (
              <img src={p.url} alt="" loading="lazy" />
            )}
          </li>
        ))}
      </ul>
      <p className="hint mt-1">
        {own.length
          ? t('사장님이 올린 사진', 'Photos from the owner')
          : unsure
            ? t('검색으로 찾은 사진이에요. 다른 가게 사진이 섞여 있을 수 있어요. 누르면 원래 글로 가요.', 'Photos found by search. Some may be of other shops. Tap one to see the original post.')
            : t('이 가게를 다룬 글의 사진이에요. 누르면 원래 글로 가요.', 'Photos from posts about this shop. Tap one to see the original post.')}
      </p>
    </section>
  );
}

/** What the owner put up: photos, opening hours (today in bold, open now or not, in words), intro. */
function OwnerSection({ owner }: { owner: NonNullable<Detail['owner']> }) {
  return (
    <section className="section owner-section" aria-labelledby="owner-label">
      <h3 className="eyebrow" id="owner-label">
        <span className="d-inline-flex align-items-center gap-1">
          <SealCheck size={14} weight="fill" aria-hidden /> Owner
        </span>
        <span className="ko">{t('사장님이 올린 정보', 'From the owner')}</span>
      </h3>
      {owner.hours && (
        <div className="hours">
          <p className="open-now">
            {owner.openNow === true ? (
              <span className="is-open">{t('지금 영업 중', 'Open now')}</span>
            ) : owner.openNow === false ? (
              <span className="is-closed">{t('지금은 영업 시간이 아니에요', 'Closed now')}</span>
            ) : null}
          </p>
          <ul className="hours-list">
            {owner.hours.map((h, i) => (
              <li key={DAYS[i]} className={i === owner.today ? 'is-today' : ''}>
                <span>{dayName(i)}{i === owner.today ? t(' (오늘)', ' (today)') : ''}</span>
                <span className="tabular">{h.closed ? t('쉬는 날', 'Closed') : `${h.open} – ${h.close}`}</span>
              </li>
            ))}
          </ul>
          {owner.hoursNote && <p className="hint mt-1">{owner.hoursNote}</p>}
        </div>
      )}
      {owner.intro && <p className="detail-summary mt-2">{owner.intro}</p>}
    </section>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="btn-text" onClick={onBack}>
      <ArrowLeft size={14} aria-hidden /> {t('뒤로', 'Back')}
    </button>
  );
}

/** This page's address (?shop=<id>) to the clipboard. */
function CopyLink({ shopId }: { shopId: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-text"
      onClick={async () => {
        const url = new URL(window.location.href);
        url.search = `?shop=${shopId}`;
        await navigator.clipboard.writeText(url.toString()).catch(() => window.prompt(t('이 링크를 복사하세요', 'Copy this link'), url.toString()));
        setDone(true);
        setTimeout(() => setDone(false), 2500);
      }}
    >
      <LinkSimple size={14} aria-hidden /> {done ? t('복사했어요', 'Copied') : t('링크 복사', 'Copy link')}
    </button>
  );
}

/** Stars for a 0-5 value, halves included. The number is always written next to them (stars alone are decoration). */
export function Stars({ value, size = 16 }: { value: number; size?: number }) {
  return (
    <span className="stars" aria-hidden>
      {[1, 2, 3, 4, 5].map((i) =>
        value >= i - 0.25 ? (
          <Star key={i} size={size} weight="fill" />
        ) : value >= i - 0.75 ? (
          <StarHalf key={i} size={size} weight="fill" />
        ) : (
          <Star key={i} size={size} className="is-empty" />
        ),
      )}
    </span>
  );
}

function RatingBlock({ shop }: { shop: Detail }) {
  const max = Math.max(1, ...shop.rating.histogram);
  return (
    <section className="section detail-rating" aria-labelledby="rating-label">
      <h3 className="eyebrow" id="rating-label">
        <span>Rating</span>
        <span className="ko">{t('평점', 'Rating')}</span>
      </h3>
      {shop.combined ? (
        <div className="rating-hero">
          <strong className="rating-number tabular">{shop.combined.score.toFixed(1)}</strong>
          <div>
            <Stars value={shop.combined.score} size={18} />
            <div className="hint mt-0">{t(`${shop.combined.basis} 기준`, `Based on ${shop.combined.basis}`)}</div>
          </div>
        </div>
      ) : (
        <p className="hint mt-0">{t('아직 평점이 없어요. 다녀왔다면 첫 후기를 남겨 주세요.', 'No rating yet. Been there? Leave the first review.')}</p>
      )}
      <div className="rating-sources">
        <div>
          <div className="rating-source-head">
            <span>{t('ROUTE 01 후기', 'ROUTE 01 reviews')}</span>
            <span className="tabular">{shop.rating.average != null ? `${shop.rating.average.toFixed(1)} · ${count(shop.rating.count, '개', 'review')}` : t('아직 없음', 'None yet')}</span>
          </div>
          {shop.rating.count > 0 && (
            <ul className="histogram" aria-label={t('별점 분포', 'Rating breakdown')}>
              {[5, 4, 3, 2, 1].map((k) => (
                <li key={k}>
                  <span className="tabular">{t(`${k}점`, `${k}★`)}</span>
                  <span className="admin-bar-fill" style={{ width: `${(shop.rating.histogram[k - 1] / max) * 100}%` }} />
                  <span className="tabular">{shop.rating.histogram[k - 1]}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="rating-source-head">
            <span>{t('블로그 평판', 'Blog reputation')}</span>
            <span className="tabular">{shop.blog.score != null
              ? `${shop.blog.score.toFixed(1)} · ${t(`글 ${shop.blog.posts}건`, count(shop.blog.posts, '', 'post'))}`
              : shop.blog.posts
                ? t(`글 ${shop.blog.posts}건 · 정리 중`, `${count(shop.blog.posts, '', 'post')} · summarizing`)
                : t('다룬 글 없음', 'No posts')}</span>
          </div>
          {(shop.blog.pros.length > 0 || shop.blog.cons.length > 0) && (
            <ul className="reputation">
              {shop.blog.pros.map((p) => (
                <li key={`+${p}`}>
                  <span className="sign">{t('좋은 점', 'Pro')}</span>
                  {p}
                </li>
              ))}
              {shop.blog.cons.map((c) => (
                <li key={`-${c}`} className="is-con">
                  <span className="sign">{t('아쉬운 점', 'Con')}</span>
                  {c}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function Reviews({ shop, onChanged }: { shop: Detail; onChanged: () => void }) {
  const loggedIn = useAccount()?.loggedIn === true;
  const [editing, setEditing] = useState(false);
  const { data, fetchMore, refetch } = useQuery(ReviewsDoc, { variables: { shopId: shop.id, offset: 0 }, fetchPolicy: 'cache-and-network' });
  const list = data?.shopReviews ?? [];
  const [more, setMore] = useState(true);
  const others = shop.rating.count - (shop.myReview ? 1 : 0);

  return (
    <section className="section" aria-labelledby="reviews-label">
      <h3 className="eyebrow" id="reviews-label">
        <span>Reviews</span>
        <span className="ko">
          {t('후기', 'Reviews')} <span className="tabular">· {shop.rating.count}</span>
        </span>
      </h3>

      {shop.myReview && !editing ? (
        <ReviewCard review={shop.myReview} onEdit={() => setEditing(true)} shopId={shop.id} onDeleted={onChanged} />
      ) : loggedIn ? (
        <ReviewForm
          shopId={shop.id}
          initial={shop.myReview ?? null}
          onDone={() => {
            setEditing(false);
            onChanged();
            refetch();
          }}
          onCancel={shop.myReview ? () => setEditing(false) : undefined}
        />
      ) : (
        <button type="button" className="btn-line" onClick={() => requireLogin(t('후기와 별점은 로그인하면 남길 수 있어요.', 'Log in to leave a review and rating.'))}>
          <Star size={16} aria-hidden /> {t('후기 쓰기', 'Write a review')}
        </button>
      )}

      {list.length > 0 ? (
        <ul className="review-list">
          {list.map((r) => (
            <li key={r.id}>
              <ReviewCard review={r} />
            </li>
          ))}
        </ul>
      ) : (
        others <= 0 && !shop.myReview && <p className="hint">{t('아직 후기가 없어요.', 'No reviews yet.')}</p>
      )}
      {more && list.length >= PAGE && list.length < others && (
        <button
          type="button"
          className="btn-line"
          onClick={async () => {
            const res = await fetchMore({
              variables: { offset: list.length },
              updateQuery: (prev, { fetchMoreResult }) => ({ shopReviews: [...prev.shopReviews, ...fetchMoreResult.shopReviews] }),
            });
            if (res.data.shopReviews.length < PAGE) setMore(false);
          }}
        >
          {t('후기 더 보기', 'More reviews')}
        </button>
      )}
    </section>
  );
}

function ReviewCard({ review, onEdit, shopId, onDeleted }: { review: ReviewItem; onEdit?: () => void; shopId?: string; onDeleted?: () => void }) {
  const [remove, { loading }] = useMutation(DeleteReviewDoc);
  const date = new Date(review.updatedAt as string).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric' });
  return (
    <article className={`review-card${review.mine ? ' is-mine' : ''}`}>
      <header>
        <Avatar name={review.author.nickname} url={review.author.avatarUrl} />
        <div className="who">
          <strong>{review.mine ? t('내 후기', 'Your review') : review.author.nickname}</strong>
          <span className="meta tabular">{date}</span>
        </div>
        <span className="review-stars" aria-label={t(`별점 ${review.rating}점`, `Rated ${review.rating} out of 5`)}>
          <Stars value={review.rating} size={14} />
        </span>
      </header>
      {review.body && <p>{review.body}</p>}
      {review.mine && onEdit && shopId && (
        <div className="review-tools">
          <button type="button" className="btn-text" onClick={onEdit}>
            {t('고치기', 'Edit')}
          </button>
          <button
            type="button"
            className="btn-text is-danger"
            disabled={loading}
            onClick={async () => {
              if (!window.confirm(t('내 후기를 지울까요?', 'Delete your review?'))) return;
              await remove({ variables: { shopId } }).catch(() => undefined);
              onDeleted?.();
            }}
          >
            <Trash size={14} aria-hidden /> {t('지우기', 'Delete')}
          </button>
        </div>
      )}
    </article>
  );
}

export function Avatar({ name, url, size = 36 }: { name: string; url?: string | null; size?: number }) {
  return url ? (
    <img className="avatar" src={url} alt="" width={size} height={size} />
  ) : (
    <span className="avatar is-initial" style={{ width: size, height: size }} aria-hidden>
      {name.trim().slice(0, 1) || '?'}
    </span>
  );
}

function ReviewForm({ shopId, initial, onDone, onCancel }: { shopId: string; initial: ReviewItem | null; onDone: () => void; onCancel?: () => void }) {
  const [rating, setRating] = useState(initial?.rating ?? 0);
  const [body, setBody] = useState(initial?.body ?? '');
  const [save, { loading, error }] = useMutation(SaveReviewDoc);
  const [missing, setMissing] = useState(false);
  return (
    <form
      className="review-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!rating) {
          setMissing(true);
          return;
        }
        const res = await save({ variables: { shopId, rating, body: body.trim() || null } }).catch(() => null);
        if (res?.data) onDone();
      }}
    >
      <fieldset className="star-input">
        <legend>
          {t('별점', 'Rating')} <span className="required">{t('(필수)', '(required)')}</span>
        </legend>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className={n <= rating ? 'is-on' : ''}>
            <input
              type="radio"
              name="rating"
              value={n}
              checked={rating === n}
              onChange={() => {
                setRating(n);
                setMissing(false);
              }}
              aria-label={t(`${n}점`, count(n, '', 'star'))}
            />
            <Star size={28} weight={n <= rating ? 'fill' : 'regular'} aria-hidden />
          </label>
        ))}
        <span className="tabular star-value" aria-hidden>
          {rating ? t(`${rating}점`, `${rating}/5`) : ''}
        </span>
      </fieldset>
      {missing && (
        <p className="field-error" role="alert">
          {t('별점을 골라 주세요', 'Pick a rating')}
        </p>
      )}
      <label htmlFor="review-body" className="field-label">
        {t('후기', 'Review')} <span className="hint d-inline">{t('(선택)', '(optional)')}</span>
      </label>
      <textarea
        id="review-body"
        value={body}
        maxLength={1000}
        rows={4}
        onChange={(e) => setBody(e.target.value)}
        placeholder={t('분위기, 가격, 사이즈, 사장님… 다음 사람에게 도움이 될 이야기', 'Vibe, prices, sizes, staff… anything that helps the next visitor')}
      />
      <div className="d-flex justify-content-between align-items-center">
        <span className="hint mt-0 tabular">{body.length}/1000</span>
        <span className="d-flex gap-2">
          {onCancel && (
            <button type="button" className="btn-text" onClick={onCancel}>
              {t('취소', 'Cancel')}
            </button>
          )}
          <button type="submit" className="btn-ink btn-small" disabled={loading}>
            {loading ? t('올리는 중…', 'Posting…') : initial ? t('고친 후기 올리기', 'Post changes') : t('후기 올리기', 'Post review')}
          </button>
        </span>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error.message}
        </p>
      )}
    </form>
  );
}
