import { useMutation, useQuery } from '@apollo/client';
import { ArrowLeft, Megaphone, Trash } from '@phosphor-icons/react';
import { useState } from 'react';
import { graphql } from '../gql';
import type { ShopNewsQuery } from '../gql/graphql';
import { getLang, t } from '../i18n';
import { type PageProps, Paged } from '../components/Paged';

export const ShopNewsDoc = graphql(`
  query ShopNews($shopId: ID!) {
    shopNews(shopId: $shopId, limit: 5) { id shopId shopName kind kindLabel title body endsOn createdAt }
  }
`);

export const MySavedNewsDoc = graphql(`
  query MySavedNews {
    mySavedNews(limit: 30) { id shopId shopName kind kindLabel title body endsOn createdAt }
  }
`);

const PostDoc = graphql(`
  mutation PostShopNews($shopId: ID!, $kind: String!, $title: String!, $body: String, $endsOn: String) {
    postShopNews(shopId: $shopId, kind: $kind, title: $title, body: $body, endsOn: $endsOn) { id }
  }
`);

const DeleteDoc = graphql(`
  mutation DeleteShopNews($id: ID!) {
    deleteShopNews(id: $id)
  }
`);

export type NewsItem = ShopNewsQuery['shopNews'][number];

const KINDS = () => [
  { id: 'new', label: t('신상 입고', 'New arrivals') },
  { id: 'sale', label: t('세일', 'Sale') },
  { id: 'event', label: t('이벤트', 'Event') },
  { id: 'notice', label: t('공지', 'Notice') },
];

/** "10월 12일" ("Oct 12") for a post; "~10/20" ("until 10/20") for its end. */
const day = (d: string | Date) => {
  const x = new Date(d);
  return getLang() === 'en' ? x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : `${x.getMonth() + 1}월 ${x.getDate()}일`;
};
const until = (d: string) => `${t('~', 'until ')}${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** One post: kind tag, title, body, posted / ends. With `shopLink`, the shop's name opens it (the saved-shops feed). */
export function NewsCard({ n, onOpenShop, onDelete }: { n: NewsItem; onOpenShop?: (id: string) => void; onDelete?: (id: string) => void }) {
  return (
    <article className={`news-card is-${n.kind}`}>
      <div className="news-head">
        <span className="tag is-news">{n.kindLabel}</span>
        {onOpenShop && (
          <button type="button" className="shop-link news-shop" onClick={() => onOpenShop(n.shopId)}>
            {n.shopName}
          </button>
        )}
        <span className="news-date tabular">
          {day(n.createdAt as string)}
          {n.endsOn && ` · ${until(n.endsOn)}`}
        </span>
      </div>
      <h4>{n.title}</h4>
      {n.body && <p>{n.body}</p>}
      {onDelete && (
        <button
          type="button"
          className="btn-text news-delete"
          onClick={() => window.confirm(t('이 소식을 지울까요?', 'Delete this post?')) && onDelete(n.id)}
        >
          <Trash size={14} aria-hidden /> {t('지우기', 'Delete')}
        </button>
      )}
    </article>
  );
}

/** The shop page's "사장님 소식": the owner's running posts; the owner also gets "소식 올리기" and delete. */
export function NewsSection({ shopId, isOwner, onWrite }: { shopId: string; isOwner: boolean; onWrite: () => void }) {
  const { data, refetch } = useQuery(ShopNewsDoc, { variables: { shopId }, fetchPolicy: 'cache-and-network' });
  const [remove] = useMutation(DeleteDoc);
  const list = data?.shopNews ?? [];
  if (!list.length && !isOwner) return null;
  return (
    <section className="section" aria-labelledby="news-label">
      <h3 className="eyebrow" id="news-label">
        <span className="d-inline-flex align-items-center gap-1">
          <Megaphone size={14} weight="fill" aria-hidden /> News
        </span>
        <span className="ko">{t('사장님 소식', 'From the owner')}</span>
      </h3>
      {list.length ? (
        <div className="news-list">
          {list.map((n) => (
            <NewsCard
              key={n.id}
              n={n}
              onDelete={isOwner ? async (id) => (await remove({ variables: { id } }).catch(() => null), refetch()) : undefined}
            />
          ))}
        </div>
      ) : (
        <p className="hint mt-0">
          {t(
            '아직 올린 소식이 없어요. 신상 입고·세일·이벤트를 올리면 이 가게를 찜한 사람에게 보여요.',
            'No posts yet. Post new arrivals, sales or events and people who saved this shop will see them.',
          )}
        </p>
      )}
      {isOwner && (
        <button type="button" className="btn-line mt-2" onClick={onWrite}>
          <Megaphone size={16} aria-hidden /> {t('소식 올리기', 'Post news')}
        </button>
      )}
    </section>
  );
}

/** Owner: write a post (kind, title, details, optional end date). */
export function NewsForm({ shopId, shopName, onDone }: { shopId: string; shopName: string; onDone: () => void }) {
  const [kind, setKind] = useState('new');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [post, state] = useMutation(PostDoc, { refetchQueries: [ShopNewsDoc] });
  const today = new Date().toISOString().slice(0, 10);
  return (
    <form
      className="owner-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await post({ variables: { shopId, kind, title, body: body || null, endsOn: endsOn || null } }).catch(() => null);
        if (r?.data) onDone();
      }}
    >
      <button type="button" className="btn-text" onClick={onDone}>
        <ArrowLeft size={14} aria-hidden /> {t('가게로', 'Back to shop')}
      </button>
      <h2 className="course-title mt-2">{t('소식 올리기', 'Post news')}</h2>
      <p className="hint mt-0">
        {t(
          `${shopName}을(를) 찜한 사람의 마이페이지와 가게 화면에 보여요. 세일·신상·이벤트는 코스 카드에도 표시돼요.`,
          `Shows on this shop's page and on the My page of everyone who saved ${shopName}. Sales, new arrivals and events also show on course cards.`,
        )}
      </p>

      <fieldset>
        <legend className="field-label">{t('종류', 'Type')}</legend>
        <div className="chip-row" role="radiogroup" aria-label={t('소식 종류', 'Post type')}>
          {KINDS().map((k) => (
            <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={`chip${kind === k.id ? ' is-selected' : ''}`} onClick={() => setKind(k.id)}>
              {k.label}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="field-label" htmlFor="news-title">
        {t('제목', 'Title')}
      </label>
      <input id="news-title" value={title} maxLength={60} required onChange={(e) => setTitle(e.target.value)} placeholder={t('예) 가을 아우터 입고 · 니트 전 품목 20%', 'e.g. Fall outerwear is in · 20% off all knits')} />
      <label className="field-label" htmlFor="news-body">
        {t('내용', 'Details')} <span className="hint d-inline">{t('(선택, 500자)', '(optional, 500 characters)')}</span>
      </label>
      <textarea id="news-body" rows={4} maxLength={500} value={body} onChange={(e) => setBody(e.target.value)} />
      <label className="field-label" htmlFor="news-ends">
        {t('끝나는 날', 'Ends on')} <span className="hint d-inline">{t('(선택 · 비우면 30일 동안 보여요)', '(optional · shows for 30 days if left empty)')}</span>
      </label>
      <input id="news-ends" type="date" min={today} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
      {state.error && (
        <p className="field-error" role="alert">
          {state.error.message}
        </p>
      )}
      <button type="submit" className="btn-ink mt-3" disabled={state.loading || !title.trim()}>
        {state.loading ? t('올리는 중…', 'Posting…') : t('올리기', 'Post')}
      </button>
    </form>
  );
}

const SEEN_KEY = 'route01.newsSeen';

/** When the user last opened "찜한 가게 소식" (this device). */
export function newsSeenAt(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0);
  } catch {
    return 0;
  }
}
export function markNewsSeen() {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch {
    /* fine without it */
  }
}

/** Saved shops' posts since the user last looked: the dot on 마이페이지 and the tab's count. */
export function useNewNewsCount(skip = false): number {
  const list = useQuery(MySavedNewsDoc, { skip, fetchPolicy: 'cache-and-network' }).data?.mySavedNews ?? [];
  const seen = newsSeenAt();
  return list.filter((n) => +new Date(n.createdAt as string) > seen).length;
}

/** 마이페이지 tab: saved shops' news, newest first. Opening it marks everything seen. */
export function SavedNewsList({ onOpenShop, pager }: { onOpenShop: (id: string) => void; pager: PageProps }) {
  const { data, loading } = useQuery(MySavedNewsDoc, { fetchPolicy: 'cache-and-network' });
  const [seen] = useState(newsSeenAt);
  useState(() => markNewsSeen());
  const list = data?.mySavedNews ?? [];
  if (loading && !data) return <p className="hint">{t('불러오는 중…', 'Loading…')}</p>;
  if (!list.length) {
    return (
      <div className="empty-state">
        <p>
          <Megaphone size={16} aria-hidden />{' '}
          {t(
            '찜한 가게의 소식이 아직 없어요. 사장님이 신상 입고·세일·이벤트를 올리면 여기에 모여요.',
            'No news from your saved shops yet. When owners post new arrivals, sales or events, they show up here.',
          )}
        </p>
      </div>
    );
  }
  return (
    <Paged items={list} {...pager}>
      {(shown) => (
        <div className="news-list">
          {shown.map((n) => (
            <div key={n.id} className={+new Date(n.createdAt as string) > seen ? 'is-unread' : ''}>
              <NewsCard n={n} onOpenShop={onOpenShop} />
            </div>
          ))}
        </div>
      )}
    </Paged>
  );
}
