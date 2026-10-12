import { useMutation } from '@apollo/client';
import { Minus, ThumbsDown, ThumbsUp } from '@phosphor-icons/react';
import { useState } from 'react';
import { graphql } from '../gql';
import { t } from '../i18n';

const RateDoc = graphql(`
  mutation RateCourse($courseId: ID!, $rating: Int!, $note: String) {
    rateCourse(courseId: $courseId, rating: $rating, note: $note)
  }
`);

const KEY = (id: string) => `route01:course-rated:${id}`;

function stored(id: string): number | null {
  try {
    const v = localStorage.getItem(KEY(id));
    return v == null ? null : Number(v);
  } catch {
    return null;
  }
}

/**
 * "이 코스 어땠어요?" once the walk is done: one tap (좋았어요 · 그저 그랬어요 · 별로였어요), then an optional line.
 * Kept per course on this device so it isn't asked again; the answer goes to the server for the next courses.
 */
export function CourseRating({ courseId }: { courseId: string }) {
  const [rating, setRating] = useState<number | null>(() => stored(courseId));
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const [rate, { loading, error }] = useMutation(RateDoc);

  async function pick(r: number) {
    setRating(r);
    try {
      localStorage.setItem(KEY(courseId), String(r));
    } catch {
      /* fine without it */
    }
    await rate({ variables: { courseId, rating: r } }).catch(() => undefined);
  }

  const options = [
    { r: 1, icon: <ThumbsUp size={18} aria-hidden />, label: t('좋았어요', 'Loved it') },
    { r: 0, icon: <Minus size={18} aria-hidden />, label: t('그저 그랬어요', 'It was OK') },
    { r: -1, icon: <ThumbsDown size={18} aria-hidden />, label: t('별로였어요', 'Not great') },
  ];

  return (
    <div className="walk-rate course-rate" role="group" aria-labelledby="course-rate-label">
      <p id="course-rate-label">
        <strong>{t('이 코스 어땠어요?', 'How was this route?')}</strong>
      </p>
      <div className="walk-rate-buttons">
        {options.map((o) => (
          <button key={o.r} type="button" className={`action-btn${rating === o.r ? ' is-on' : ''}`} aria-pressed={rating === o.r} disabled={loading} onClick={() => pick(o.r)}>
            {o.icon} {o.label}
          </button>
        ))}
      </div>
      {rating !== null && !sent && (
        <form
          className="course-rate-note"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!note.trim()) return;
            const { data } = await rate({ variables: { courseId, rating, note: note.trim() } }).catch(() => ({ data: undefined }));
            if (data) setSent(true);
          }}
        >
          <label className="field-label" htmlFor="course-rate-text">
            {t('한 줄 남기기 (선택)', 'Add a line (optional)')}
          </label>
          <div className="course-rate-row">
            <input
              id="course-rate-text"
              className="form-control"
              maxLength={300}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('예: 빈티지가 더 많았으면', 'e.g. more vintage shops next time')}
            />
            <button type="submit" className="btn-line" disabled={loading || !note.trim()}>
              {t('보내기', 'Send')}
            </button>
          </div>
        </form>
      )}
      <p className="hint mb-0" role="status">
        {error
          ? error.message
          : sent
            ? t('고마워요. 다음 코스를 짤 때 참고할게요', 'Thanks. We’ll use it for the next routes')
            : rating !== null
              ? t('고마워요!', 'Thanks!')
              : ''}
      </p>
    </div>
  );
}
