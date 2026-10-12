import { Check, CheckCircle, Heart, ThumbsDown, ThumbsUp } from '@phosphor-icons/react';
import { t } from '../i18n';
import { type ShopAction, useRecordShop } from './useMyShops';

export interface MyState {
  saved: boolean;
  visits: number;
  rating: number;
  closedReported: boolean;
}

const EMPTY: MyState = { saved: false, visits: 0, rating: 0, closedReported: false };

interface Props {
  shopId: string;
  state?: MyState;
  courseId?: string;
}

function useAct(shopId: string, courseId?: string) {
  const { record, busy } = useRecordShop();
  return { busy, act: (a: ShopAction) => record(shopId, a, courseId) };
}

/** ♡ as a single icon button (course card header). */
export function SaveButton({ shopId, state, courseId }: Props) {
  const s = state ?? EMPTY;
  const { act, busy } = useAct(shopId, courseId);
  return (
    <button
      type="button"
      className={`save-btn${s.saved ? ' is-on' : ''}`}
      aria-pressed={s.saved}
      aria-label={s.saved ? t('찜 취소', 'Unsave') : t('찜하기', 'Save')}
      title={s.saved ? t('찜 취소', 'Unsave') : t('찜하기', 'Save')}
      disabled={busy}
      onClick={() => act(s.saved ? 'unsave' : 'save')}
    >
      <Heart size={20} weight={s.saved ? 'fill' : 'regular'} />
    </button>
  );
}

/** 다녀왔어요, then ✓ + 👍 / 👎. */
export function VisitControls({ shopId, state, courseId }: Props) {
  const s = state ?? EMPTY;
  const { act, busy } = useAct(shopId, courseId);
  if (s.visits <= 0) {
    return (
      <button type="button" className="visit-btn" disabled={busy} onClick={() => act('visit')}>
        <Check size={14} aria-hidden /> {t('다녀왔어요', 'I went')}
      </button>
    );
  }
  return (
    <span className="visit-done" role="group" aria-label={t('다녀온 가게', 'Visited shop')}>
      <button type="button" className="is-on" aria-pressed title={t('다녀옴 취소', 'Undo visited')} aria-label={t('다녀옴 (누르면 취소)', 'Visited (tap to undo)')} disabled={busy} onClick={() => act('unvisit')}>
        <Check size={14} weight="bold" aria-hidden /> {t('다녀옴', 'Visited')}
      </button>
      <button
        type="button"
        className={s.rating > 0 ? 'is-on' : ''}
        aria-pressed={s.rating > 0}
        aria-label={t('좋았어요', 'Liked it')}
        title={t('좋았어요', 'Liked it')}
        disabled={busy}
        onClick={() => act(s.rating > 0 ? 'unrate' : 'like')}
      >
        <ThumbsUp size={15} weight={s.rating > 0 ? 'fill' : 'regular'} />
      </button>
      <button
        type="button"
        className={s.rating < 0 ? 'is-on' : ''}
        aria-pressed={s.rating < 0}
        aria-label={t('별로였어요', 'Not for me')}
        title={t('별로였어요', 'Not for me')}
        disabled={busy}
        onClick={() => act(s.rating < 0 ? 'unrate' : 'dislike')}
      >
        <ThumbsDown size={15} weight={s.rating < 0 ? 'fill' : 'regular'} />
      </button>
    </span>
  );
}

/** ✓ as a single icon button next to ♡ (course card header): 다녀왔어요 / 다녀옴 취소. */
export function VisitButton({ shopId, state, courseId }: Props) {
  const s = state ?? EMPTY;
  const { act, busy } = useAct(shopId, courseId);
  const done = s.visits > 0;
  return (
    <button
      type="button"
      className={`save-btn${done ? ' is-on' : ''}`}
      aria-pressed={done}
      aria-label={done ? t('다녀옴 (누르면 취소)', 'Visited (tap to undo)') : t('다녀왔어요', 'I went')}
      title={done ? t('다녀옴 취소', 'Undo visited') : t('다녀왔어요', 'I went')}
      disabled={busy}
      onClick={() => act(done ? 'unvisit' : 'visit')}
    >
      <CheckCircle size={20} weight={done ? 'fill' : 'regular'} />
    </button>
  );
}

/** After a visit: "좋았나요? 👍 👎" as a small inline prompt (course card meta line). */
export function RatePrompt({ shopId, state, courseId }: Props) {
  const s = state ?? EMPTY;
  const { act, busy } = useAct(shopId, courseId);
  if (s.visits <= 0) return null;
  return (
    <span className="rate-prompt" role="group" aria-label={t('좋았나요?', 'Did you like it?')}>
      {s.rating === 0 && <span>{t('좋았나요?', 'Did you like it?')}</span>}
      <button type="button" className={s.rating > 0 ? 'is-on' : ''} aria-pressed={s.rating > 0} aria-label={t('좋았어요', 'Liked it')} title={t('좋았어요', 'Liked it')} disabled={busy} onClick={() => act(s.rating > 0 ? 'unrate' : 'like')}>
        <ThumbsUp size={15} weight={s.rating > 0 ? 'fill' : 'regular'} />
      </button>
      <button type="button" className={s.rating < 0 ? 'is-on' : ''} aria-pressed={s.rating < 0} aria-label={t('별로였어요', 'Not for me')} title={t('별로였어요', 'Not for me')} disabled={busy} onClick={() => act(s.rating < 0 ? 'unrate' : 'dislike')}>
        <ThumbsDown size={15} weight={s.rating < 0 ? 'fill' : 'regular'} />
      </button>
    </span>
  );
}

/** Small "폐업 신고" link: the shop was closed or gone. */
export function ClosedReport({ shopId, state, courseId }: Props) {
  const s = state ?? EMPTY;
  const { act, busy } = useAct(shopId, courseId);
  if (s.closedReported) return <span className="closed-report is-done">{t('신고했어요', 'Reported')}</span>;
  return (
    <button
      type="button"
      className="closed-report"
      disabled={busy}
      onClick={() => {
        if (window.confirm(
            t(
              '이 가게가 문을 닫았거나 없어졌나요? 신고가 모이면 코스에서 바로 빼고, 영업 중인지 다시 확인해요.',
              "Has this shop closed or gone? Once a few reports come in, we take it out of courses and check whether it's still open.",
            ),
          )) act('closed');
      }}
    >
      {t('폐업 신고', 'Report closed')}
    </button>
  );
}

/** All of the above in one row: the map's shop card. */
export function ShopActions(props: Props) {
  return (
    <div className="shop-actions" role="group" aria-label={t('내 가게에 기록', 'Save to my shops')}>
      <SaveButton {...props} />
      <VisitControls {...props} />
      <ClosedReport {...props} />
    </div>
  );
}
