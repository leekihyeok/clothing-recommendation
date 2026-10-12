import { useMutation, useQuery } from '@apollo/client';
import { ArrowRight, UsersThree } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { graphql } from '../gql';
import { GENDER_OPTIONS } from './CourseForm';
import type { Gender } from './usePlanner';
import { useProfile } from '../me/useProfile';
import { t } from '../i18n';

export const GROUP_PARAM = 'g';

const GroupDoc = graphql(`
  query CourseGroup($id: ID!) {
    courseGroup(id: $id) { id baseCourseId regionName regionId origin { lat lng } resultCourseId updatedAt members { name styles gender budget } }
  }
`);

const StartDoc = graphql(`
  mutation StartCourseGroup($courseId: ID!, $name: String) {
    startCourseGroup(courseId: $courseId, name: $name) { id }
  }
`);

const JoinDoc = graphql(`
  mutation JoinCourseGroup($id: ID!, $member: GroupMemberInput!) {
    joinCourseGroup(id: $id, member: $member) { id }
  }
`);

const BUDGETS = () => [
  { id: 'any', label: t('상관없음', 'Any') },
  { id: 'low', label: t('저렴하게', 'Low') },
  { id: 'mid', label: t('적당히', 'Mid') },
  { id: 'high', label: t('고급', 'High-end') },
];
const GENDER_LABEL = (): Record<string, string> => ({ men: t('남성복', 'Menswear'), women: t('여성복', 'Womenswear') });
const BUDGET_LABEL = (): Record<string, string> => ({ low: t('저렴하게', 'Low budget'), mid: t('적당히', 'Mid budget'), high: t('고급', 'High-end') });
const POLL_MS = 8000;

/** This course's group on this device (so a reload still shows the invite and its news). */
const keyFor = (courseId: string) => `route01.group.${courseId}`;
function storedGroup(courseId: string): string | null {
  try {
    return localStorage.getItem(keyFor(courseId));
  } catch {
    return null;
  }
}
function storeGroup(courseId: string, groupId: string) {
  try {
    localStorage.setItem(keyFor(courseId), groupId);
  } catch {
    /* fine without it */
  }
}

const groupUrl = (id: string) => `${window.location.origin}/?${GROUP_PARAM}=${id}`;

/** Phone: the share sheet; else copy the link. Returns a line for the status, or null. */
async function sendLink(url: string, title: string): Promise<string | null> {
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title, url });
      return null;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return t('링크를 복사했어요. 같이 갈 사람에게 보내 주세요', 'Link copied. Send it to whoever is coming along');
  } catch {
    window.prompt(t('이 링크를 복사해 보내세요', 'Copy this link and send it'), url);
    return null;
  }
}

function tasteLine(m: { styles: string[]; gender: string; budget: string }, styleLabels: Record<string, string>): string {
  const parts = [
    m.styles.length ? m.styles.map((s) => styleLabels[s] ?? s).join('·') : t('스타일 상관없음', 'Any style'),
    GENDER_LABEL()[m.gender],
    BUDGET_LABEL()[m.budget],
  ].filter(Boolean);
  return parts.join(' · ');
}

/**
 * On a course: "같이 가기" — a link for the people coming along. Each one adds their taste and the course is planned
 * again for all of them; while this is open it checks every few seconds and offers the new course when there is one.
 */
export function GroupInvite({ courseId, title, groupId: fromCourse, groupNames, styleLabels, onOpenCourse }: {
  courseId: string;
  title: string;
  /** The course was already planned for a group: invite more to the same one. */
  groupId?: string | null;
  groupNames?: string[] | null;
  styleLabels: Record<string, string>;
  onOpenCourse: (id: string) => void;
}) {
  const [groupId, setGroupId] = useState<string | null>(() => fromCourse ?? storedGroup(courseId));
  useEffect(() => setGroupId(fromCourse ?? storedGroup(courseId)), [courseId, fromCourse]);
  const [note, setNote] = useState<string | null>(null);
  // How the others see me ("지훈님과 성수에서 같이 걸을 코스"): the Kakao nickname when logged in, else typed.
  const nickname = useProfile().data?.myProfile?.nickname ?? '';
  const [name, setName] = useState(nickname);
  useEffect(() => setName((n) => n || nickname), [nickname]);
  const [start, startState] = useMutation(StartDoc);
  const { data } = useQuery(GroupDoc, { variables: { id: groupId ?? '' }, skip: !groupId, pollInterval: POLL_MS, fetchPolicy: 'cache-and-network' });
  const g = data?.courseGroup;
  const fresh = g?.resultCourseId && g.resultCourseId !== courseId ? g : null;

  async function invite() {
    setNote(null);
    let id = groupId;
    if (!id) {
      const r = await start({ variables: { courseId, name: name.trim() || null } }).catch(() => null);
      id = r?.data?.startCourseGroup.id ?? null;
      if (!id) return setNote(t('링크를 만들지 못했어요. 잠시 뒤 다시 해 주세요', "Couldn't make the link. Please try again in a moment"));
      storeGroup(courseId, id);
      setGroupId(id);
    }
    setNote(await sendLink(groupUrl(id), `ROUTE 01 · ${t('같이 가요', 'Come along')} · ${title}`));
  }

  return (
    <section className="section group-box" aria-labelledby="group-label">
      <h3 className="eyebrow" id="group-label">
        <span className="d-inline-flex align-items-center gap-1">
          <UsersThree size={14} weight="fill" aria-hidden /> Together
        </span>
        <span className="ko">{t('같이 가기', 'Go together')}</span>
      </h3>
      {groupNames?.length ? (
        <p className="group-names">
          {t('', 'A route mixing the tastes of ')}<strong>{groupNames.join(' + ')}</strong>{t(' 취향을 섞어 짠 코스예요.', '.')}
        </p>
      ) : (
        <p className="hint mt-0">{t('같이 갈 사람에게 링크를 보내면, 그 사람이 고른 스타일·누구 옷·예산을 섞어 둘 다 맞는 코스로 다시 짜요. 동네·시간·고정한 가게는 그대로예요.', 'Send a link to whoever is coming along. Their style, who it’s for and budget get mixed with yours into a route that suits you both. The area, times and pinned shops stay the same.')}</p>
      )}
      {g && g.members.length > 0 && (
        <ul className="group-members">
          {g.members.map((m, i) => (
            <li key={`${m.name}-${i}`}>
              <strong>{m.name}</strong>
              <span>{tasteLine(m, styleLabels)}</span>
            </li>
          ))}
        </ul>
      )}
      {fresh && (
        <div className="group-fresh" role="status">
          <span>
            <strong>{fresh.members[fresh.members.length - 1].name}</strong>{t('님이 취향을 넣어서 다시 짰어요', ' added their taste — the route is replanned')}
          </span>
          <button type="button" className="btn-ink btn-small" onClick={() => onOpenCourse(fresh.resultCourseId!)}>
            {t('같이 짠 코스', 'Shared route')} <ArrowRight size={16} aria-hidden />
          </button>
        </div>
      )}
      {!groupId && !groupNames?.length && (
        <>
          <label className="field-label" htmlFor="group-host">
            {t('내 이름', 'Your name')} <span className="hint d-inline">{t('(친구에게 보여요 · 선택)', '(friends see it · optional)')}</span>
          </label>
          <input id="group-host" className="field-input" value={name} maxLength={12} onChange={(e) => setName(e.target.value)} placeholder={t('예) 지훈', 'e.g. Alex')} autoComplete="nickname" />
        </>
      )}
      <button type="button" className="btn-line mt-2" disabled={startState.loading} onClick={invite}>
        <UsersThree size={16} aria-hidden /> {groupId ? t('링크 다시 보내기', 'Send the link again') : t('같이 갈 사람 부르기', 'Invite someone along')}
      </button>
      {note && (
        <p className="hint mb-0" role="status">
          {note}
        </p>
      )}
      {groupId && !fresh && <p className="hint mb-0">{t('링크를 받은 사람이 취향을 넣으면 여기에 바로 알려 드려요.', 'We’ll tell you here as soon as they add their taste.')}</p>}
    </section>
  );
}

/**
 * Opened from a "같이 가기" link: who's coming and their taste, then mine (name, styles, 누구 옷, budget) → the course
 * planned for everyone. A course already made for the group can be opened directly.
 */
export function GroupJoin({ groupId, styles, styleLabels, onJoined, onClose, onPlace }: {
  groupId: string;
  /** Where the group's course is, once known: the map goes there. */
  onPlace?: (p: { regionId?: string; at?: { lat: number; lng: number } }) => void;
  styles: { id: string; label: string }[];
  styleLabels: Record<string, string>;
  onJoined: (courseId: string) => void;
  onClose: () => void;
}) {
  const { data, loading, error } = useQuery(GroupDoc, { variables: { id: groupId } });
  const [join, joinState] = useMutation(JoinDoc);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [gender, setGender] = useState<Gender>('any');
  const [budget, setBudget] = useState('any');
  const g = data?.courseGroup;
  const placed = useRef(false);
  useEffect(() => {
    if (!g || placed.current) return;
    placed.current = true;
    onPlace?.({ regionId: g.regionId ?? undefined, at: g.origin ? { lat: g.origin.lat, lng: g.origin.lng } : undefined });
  }, [g]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading && !g) return <p className="hint">{t('불러오는 중…', 'Loading…')}</p>;
  if (!g) {
    return (
      <div className="empty-state">
        <p>{error?.message ?? t('같이 가기 링크를 찾지 못했어요', 'Couldn’t find this invite link')}</p>
        <button type="button" className="btn-line" onClick={onClose}>
          {t('코스 만들기로', 'Plan a route')}
        </button>
      </div>
    );
  }
  const host = g.members[0]?.name ?? '친구';
  const withHost = host === '친구' ? t('친구와', 'With a friend') : t(`${host}님과`, `With ${host}`);
  return (
    <form
      className="group-join"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await join({ variables: { id: groupId, member: { name: name || null, styles: picked, gender, budget } } }).catch(() => null);
        if (r?.data) onJoined(r.data.joinCourseGroup.id);
      }}
    >
      <p className="eyebrow mb-2">
        <span className="d-inline-flex align-items-center gap-1">
          <UsersThree size={14} weight="fill" aria-hidden /> Together
        </span>
        <span className="ko">{t('같이 가기', 'Go together')}</span>
      </p>
      <h2 className="course-title">
        {t(`${withHost} ${g.regionName ?? '서울'}에서`, `${withHost} in ${g.regionName ?? 'Seoul'}:`)}
        <br />
        {t('같이 걸을 코스', 'a route to walk together')}
      </h2>
      <p className="hint">{t(`내 취향을 고르면 모두에게 맞게 코스를 다시 짜요. 동네와 시간은 ${host === '친구' ? '처음 코스' : `${host}님이 정한`} 그대로예요.`, `Pick your taste and the route is replanned to suit everyone. The area and times stay as ${host === '친구' ? 'in the first route' : `${host} set them`}.`)}</p>
      <ul className="group-members">
        {g.members.map((m, i) => (
          <li key={`${m.name}-${i}`}>
            <strong>{m.name}</strong>
            <span>{tasteLine(m, styleLabels)}</span>
          </li>
        ))}
      </ul>

      <label className="field-label" htmlFor="group-name">
        {t('내 이름', 'Your name')} <span className="hint d-inline">{t('(선택)', '(optional)')}</span>
      </label>
      <input id="group-name" className="field-input" value={name} maxLength={12} onChange={(e) => setName(e.target.value)} placeholder={t('예) 민지', 'e.g. Sam')} autoComplete="nickname" />

      <h3 className="eyebrow mt-3" id="group-style">
        <span>Style</span>
        <span className="ko">{t('내 스타일', 'Your style')}</span>
      </h3>
      <div className="chip-row" role="group" aria-labelledby="group-style">
        {styles.map((s) => {
          const on = picked.includes(s.id);
          return (
            <button key={s.id} type="button" className={`chip${on ? ' is-selected' : ''}`} aria-pressed={on} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== s.id) : [...p, s.id]))}>
              {s.label}
            </button>
          );
        })}
      </div>
      <h3 className="eyebrow mt-3" id="group-gender">
        <span>For</span>
        <span className="ko">{t('누구 옷', 'Who it’s for')}</span>
      </h3>
      <div className="chip-row" role="group" aria-labelledby="group-gender">
        {GENDER_OPTIONS.map((o) => (
          <button key={o.id} type="button" className={`chip${gender === o.id ? (o.id === 'any' ? ' is-default' : ' is-selected') : ''}`} aria-pressed={gender === o.id} onClick={() => setGender(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      <h3 className="eyebrow mt-3" id="group-budget">
        <span>Budget</span>
        <span className="ko">{t('예산', 'Your budget')}</span>
      </h3>
      <div className="chip-row" role="group" aria-labelledby="group-budget">
        {BUDGETS().map((b) => (
          <button key={b.id} type="button" className={`chip${budget === b.id ? (b.id === 'any' ? ' is-default' : ' is-selected') : ''}`} aria-pressed={budget === b.id} onClick={() => setBudget(b.id)}>
            {b.label}
          </button>
        ))}
      </div>
      <p className="hint">{t('누구 옷이 서로 다르면 둘 다 볼 수 있게 상관없이, 예산은 더 아끼는 쪽에 맞춰요.', 'If you shop for different people, the route covers both; the budget follows whoever wants to spend less.')}</p>
      {joinState.error && (
        <p className="field-error" role="alert">
          {joinState.error.message}
        </p>
      )}
      <button type="submit" className="btn-ink mt-3" disabled={joinState.loading}>
        <span>{joinState.loading ? t('같이 짜는 중…', 'Planning together…') : t('내 취향 넣고 같이 짜기', 'Add my taste and plan together')}</span>
        <ArrowRight size={20} aria-hidden />
      </button>
      {g.resultCourseId && (
        <button type="button" className="btn-line mt-2" onClick={() => onJoined(g.resultCourseId!)}>
          {t('지금까지 같이 짠 코스 보기', 'See the route planned so far')}
        </button>
      )}
    </form>
  );
}
