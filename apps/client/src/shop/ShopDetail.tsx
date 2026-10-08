import { useMutation, useQuery } from '@apollo/client';
import {
  ArrowLeft, ArrowsClockwise, ArrowUpRight, CaretDown, CaretUp, Check, Globe, Heart, Plus, InstagramLogo, LinkSimple, MapPin, MapTrifold, Phone, SealCheck, Star, StarHalf, Storefront, Trash, Warning,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { graphql } from '../gql';
import type { ShopDetailQuery } from '../gql/graphql';
import { CATEGORY_BY_ID } from '../map/categories';
import { requireLogin } from '../me/LoginModal';
import { RatePrompt } from '../me/ShopActions';
import { useAccount } from '../me/useAccount';
import { useRecordShop, useShopStates } from '../me/useMyShops';
import { ClaimForm, DAYS, OwnerEditor } from './OwnerForms';

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

const PRICE_LABEL: Record<string, string> = { low: '저렴한 편', mid: '보통', high: '비싼 편' };
const PAGE = 10;

interface Props {
  shopId: string;
  onBack: () => void;
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
        문을 닫았거나 확인 중인 가게라 코스에 넣을 수 없어요.
      </div>
    );
  }
  return (
    <section className="course-put" aria-labelledby="put-label">
      <h3 className="eyebrow" id="put-label">
        <span>Course</span>
        <span className="ko">지금 코스에 넣기</span>
      </h3>
      <button type="button" className="btn-ink w-100" disabled={course.busy || course.stops.length >= COURSE_MAX} onClick={() => course.onPut(null)}>
        <Plus size={16} aria-hidden /> 이 코스에 넣기
      </button>
      <p className="hint">{course.stops.length >= COURSE_MAX ? `코스에는 ${COURSE_MAX}곳까지 넣을 수 있어요.` : '걷는 길이 가장 덜 늘어나는 자리에 넣어요.'}</p>
      <button
        type="button"
        className="put-disclose"
        aria-expanded={instead}
        aria-controls="put-instead-list"
        onClick={() => setInstead(!instead)}
      >
        <span>다른 가게 대신 넣기</span>
        {instead ? <CaretUp size={14} aria-hidden /> : <CaretDown size={14} aria-hidden />}
      </button>
      {instead && (
        <ul className="put-list" id="put-instead-list">
          {course.stops.map((s) => (
            <li key={s.id}>
              <button type="button" disabled={course.busy} onClick={() => course.onPut(s.order)} aria-label={`${s.order}번 ${s.name} 대신 넣기`}>
                <span className="put-num" aria-hidden>
                  {String(s.order).padStart(2, '0')}
                </span>
                <span className="put-name">{s.name}</span>
                <span className="put-action" aria-hidden>
                  <ArrowsClockwise size={14} /> 대신 넣기
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Shop detail: what we know, people's saves and visits, the combined rating, reviews, and the posts behind it all. */
export function ShopDetail({ shopId, onBack, styleLabels, itemLabels, course }: Props) {
  const { data, loading, error, refetch } = useQuery(ShopDetailDoc, { variables: { id: shopId }, fetchPolicy: 'cache-and-network' });
  const shop = data?.shop;
  const states = useShopStates([shopId]);
  const { record, busy } = useRecordShop();
  const mine = states.get(shopId) ?? { saved: false, visits: 0 };
  const loggedIn = useAccount()?.loggedIn === true;
  const [mode, setMode] = useState<'view' | 'claim' | 'edit'>('view');
  // Opening a shop counts as a view ("자주 본 곳"); the API counts one per shop per 10 minutes.
  useEffect(() => {
    record(shopId, 'view');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  if (!shop) {
    return (
      <div>
        <BackButton onBack={onBack} />
        {loading ? <p className="hint">불러오는 중…</p> : <p className="hint">{error?.message ?? '가게를 찾지 못했어요'}</p>}
      </div>
    );
  }
  const category = CATEGORY_BY_ID[shop.category];
  if (mode === 'claim') return <ClaimForm shopId={shop.id} shopName={shop.name} onBack={() => setMode('view')} />;
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
          {category?.label ?? shop.category}
          {shop.inMarket && ' · 전통시장'}
        </span>
        {shop.priceRange && PRICE_LABEL[shop.priceRange] && <span className="ko">{PRICE_LABEL[shop.priceRange]}</span>}
      </p>
      <h2 className="course-title" id="shop-title">
        {shop.name}
      </h2>
      {shop.status !== 'candidate' && (
        <div className="region-note mt-3 is-warning" role="note">
          <Warning size={14} aria-hidden /> {shop.status === 'closed' ? '문을 닫은 가게예요. 코스에는 넣지 않아요.' : '문 닫힘 신고가 들어와 확인하는 중이에요. 그동안 코스에는 넣지 않아요.'}
        </div>
      )}

      {course &&
        (course.stops.some((s) => s.id === shop.id) ? (
          <div className="region-note mt-3" role="note">
            지금 코스의 {course.stops.find((s) => s.id === shop.id)!.order}번 가게예요.
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
      {shop.owner && <OwnerSection owner={shop.owner} />}

      <PhotoStrip shop={shop} />

      {/* Three actions, one look: same size, outlined, filled in ink when on. */}
      <div className="detail-actions" role="group" aria-label="이 가게">
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
          <span>찜</span>
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
          <span>{mine.visits > 0 ? '다녀옴' : '다녀왔어요'}</span>
        </button>
        {shop.placeUrl ? (
          <a className="action-btn" href={shop.placeUrl} target="_blank" rel="noreferrer">
            <MapTrifold size={18} aria-hidden />
            <span>카카오맵</span>
            <ArrowUpRight size={12} aria-hidden />
          </a>
        ) : (
          <span className="action-btn is-disabled" aria-disabled="true">
            <MapTrifold size={18} aria-hidden />
            <span>카카오맵 없음</span>
          </span>
        )}
      </div>
      <div className="detail-sub">
        <span className="hint mt-0 tabular">다녀온 사람 {shop.visitors.toLocaleString()}명</span>
        <RatePrompt shopId={shop.id} state={states.get(shop.id)} />
      </div>

      <RatingBlock shop={shop} />

      {(shop.summary || shop.reason || shop.styles.length > 0) && (
        <section className="section" aria-labelledby="about-label">
          <h3 className="eyebrow" id="about-label">
            <span>About</span>
            <span className="ko">어떤 가게</span>
          </h3>
          {shop.summary && <p className="detail-summary">{shop.summary}</p>}
          {shop.reason && <p className="detail-reason">{shop.reason}</p>}
          {shop.styles.length > 0 && (
            <div className="detail-tags" aria-label="스타일">
              {shop.styles.map((s) => (
                <span key={s.style} className="tag">
                  {styleLabels[s.style] ?? s.style} <span className="tabular">{s.score}</span>
                </span>
              ))}
            </div>
          )}
          {shop.items.length > 0 && <p className="hint">주로 파는 것: {shop.items.map((i) => itemLabels[i] ?? i).join(' · ')}</p>}
          {shop.littleKnown && <p className="hint">아직 이 가게를 다룬 글을 찾지 못해서, 소개가 가게 종류에서 나온 추정이에요.</p>}
        </section>
      )}

      <Reviews shop={shop} onChanged={() => refetch()} />

      {shop.posts.length > 0 && (
        <section className="section" aria-labelledby="posts-label">
          <h3 className="eyebrow" id="posts-label">
            <span>Sources</span>
            <span className="ko">이 가게를 다룬 글</span>
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
      <p className="hint">카카오맵·네이버의 후기와 평점은 각 서비스에서 볼 수 있어요. 여기 평점은 ROUTE 01 후기와 모아 둔 블로그 글로 계산해요.</p>

      <div className="owner-entry">
        {shop.isOwner ? (
          <button type="button" className="btn-line" onClick={() => setMode('edit')}>
            <Storefront size={16} aria-hidden /> 가게 정보 고치기 (사장님)
          </button>
        ) : (
          <button
            type="button"
            className="btn-text"
            onClick={() => (loggedIn ? setMode('claim') : requireLogin('사장님 신청은 로그인한 뒤에 할 수 있어요.'))}
          >
            <Storefront size={14} aria-hidden /> 이 가게 사장님이세요?
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
  const list = own.length ? own.map((url) => ({ url, sourceUrl: null, source: '사장님', matched: true })) : shop.photos;
  if (!list.length) return null;
  const unsure = !own.length && list.some((p) => !p.matched);
  return (
    <section className="photo-strip" aria-label="가게 사진">
      <ul>
        {list.map((p) => (
          <li key={p.url}>
            {p.sourceUrl ? (
              <a href={p.sourceUrl} target="_blank" rel="noreferrer" aria-label={`사진 출처 ${p.source}에서 보기`}>
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
        {own.length ? '사장님이 올린 사진' : unsure ? '검색으로 찾은 사진이에요. 다른 가게 사진이 섞여 있을 수 있어요. 누르면 원래 글로 가요.' : '이 가게를 다룬 글의 사진이에요. 누르면 원래 글로 가요.'}
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
        <span className="ko">사장님이 올린 정보</span>
      </h3>
      {owner.hours && (
        <div className="hours">
          <p className="open-now">
            {owner.openNow === true ? (
              <span className="is-open">지금 영업 중</span>
            ) : owner.openNow === false ? (
              <span className="is-closed">지금은 영업 시간이 아니에요</span>
            ) : null}
          </p>
          <ul className="hours-list">
            {owner.hours.map((h, i) => (
              <li key={DAYS[i]} className={i === owner.today ? 'is-today' : ''}>
                <span>{DAYS[i]}{i === owner.today ? ' (오늘)' : ''}</span>
                <span className="tabular">{h.closed ? '쉬는 날' : `${h.open} – ${h.close}`}</span>
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
      <ArrowLeft size={14} aria-hidden /> 뒤로
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
        await navigator.clipboard.writeText(url.toString()).catch(() => window.prompt('이 링크를 복사하세요', url.toString()));
        setDone(true);
        setTimeout(() => setDone(false), 2500);
      }}
    >
      <LinkSimple size={14} aria-hidden /> {done ? '복사했어요' : '링크 복사'}
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
        <span className="ko">평점</span>
      </h3>
      {shop.combined ? (
        <div className="rating-hero">
          <strong className="rating-number tabular">{shop.combined.score.toFixed(1)}</strong>
          <div>
            <Stars value={shop.combined.score} size={18} />
            <div className="hint mt-0">{shop.combined.basis} 기준</div>
          </div>
        </div>
      ) : (
        <p className="hint mt-0">아직 평점이 없어요. 다녀왔다면 첫 후기를 남겨 주세요.</p>
      )}
      <div className="rating-sources">
        <div>
          <div className="rating-source-head">
            <span>ROUTE 01 후기</span>
            <span className="tabular">{shop.rating.average != null ? `${shop.rating.average.toFixed(1)} · ${shop.rating.count}개` : '아직 없음'}</span>
          </div>
          {shop.rating.count > 0 && (
            <ul className="histogram" aria-label="별점 분포">
              {[5, 4, 3, 2, 1].map((k) => (
                <li key={k}>
                  <span className="tabular">{k}점</span>
                  <span className="admin-bar-fill" style={{ width: `${(shop.rating.histogram[k - 1] / max) * 100}%` }} />
                  <span className="tabular">{shop.rating.histogram[k - 1]}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="rating-source-head">
            <span>블로그 평판</span>
            <span className="tabular">{shop.blog.score != null ? `${shop.blog.score.toFixed(1)} · 글 ${shop.blog.posts}건` : shop.blog.posts ? `글 ${shop.blog.posts}건 · 정리 중` : '다룬 글 없음'}</span>
          </div>
          {(shop.blog.pros.length > 0 || shop.blog.cons.length > 0) && (
            <ul className="reputation">
              {shop.blog.pros.map((p) => (
                <li key={`+${p}`}>
                  <span className="sign">좋은 점</span>
                  {p}
                </li>
              ))}
              {shop.blog.cons.map((c) => (
                <li key={`-${c}`} className="is-con">
                  <span className="sign">아쉬운 점</span>
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
          후기 <span className="tabular">· {shop.rating.count}</span>
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
        <button type="button" className="btn-line" onClick={() => requireLogin('후기와 별점은 로그인하면 남길 수 있어요.')}>
          <Star size={16} aria-hidden /> 후기 쓰기
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
        others <= 0 && !shop.myReview && <p className="hint">아직 후기가 없어요.</p>
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
          후기 더 보기
        </button>
      )}
    </section>
  );
}

function ReviewCard({ review, onEdit, shopId, onDeleted }: { review: ReviewItem; onEdit?: () => void; shopId?: string; onDeleted?: () => void }) {
  const [remove, { loading }] = useMutation(DeleteReviewDoc);
  const date = new Date(review.updatedAt as string).toLocaleDateString('ko-KR', { year: 'numeric', month: 'numeric', day: 'numeric' });
  return (
    <article className={`review-card${review.mine ? ' is-mine' : ''}`}>
      <header>
        <Avatar name={review.author.nickname} url={review.author.avatarUrl} />
        <div className="who">
          <strong>{review.mine ? '내 후기' : review.author.nickname}</strong>
          <span className="meta tabular">{date}</span>
        </div>
        <span className="review-stars" aria-label={`별점 ${review.rating}점`}>
          <Stars value={review.rating} size={14} />
        </span>
      </header>
      {review.body && <p>{review.body}</p>}
      {review.mine && onEdit && shopId && (
        <div className="review-tools">
          <button type="button" className="btn-text" onClick={onEdit}>
            고치기
          </button>
          <button
            type="button"
            className="btn-text is-danger"
            disabled={loading}
            onClick={async () => {
              if (!window.confirm('내 후기를 지울까요?')) return;
              await remove({ variables: { shopId } }).catch(() => undefined);
              onDeleted?.();
            }}
          >
            <Trash size={14} aria-hidden /> 지우기
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
          별점 <span className="required">(필수)</span>
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
              aria-label={`${n}점`}
            />
            <Star size={28} weight={n <= rating ? 'fill' : 'regular'} aria-hidden />
          </label>
        ))}
        <span className="tabular star-value" aria-hidden>
          {rating ? `${rating}점` : ''}
        </span>
      </fieldset>
      {missing && (
        <p className="field-error" role="alert">
          별점을 골라 주세요
        </p>
      )}
      <label htmlFor="review-body" className="field-label">
        후기 <span className="hint d-inline">(선택)</span>
      </label>
      <textarea
        id="review-body"
        value={body}
        maxLength={1000}
        rows={4}
        onChange={(e) => setBody(e.target.value)}
        placeholder="분위기, 가격, 사이즈, 사장님… 다음 사람에게 도움이 될 이야기"
      />
      <div className="d-flex justify-content-between align-items-center">
        <span className="hint mt-0 tabular">{body.length}/1000</span>
        <span className="d-flex gap-2">
          {onCancel && (
            <button type="button" className="btn-text" onClick={onCancel}>
              취소
            </button>
          )}
          <button type="submit" className="btn-ink btn-small" disabled={loading}>
            {loading ? '올리는 중…' : initial ? '고친 후기 올리기' : '후기 올리기'}
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
