import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { graphql } from '../gql';
import type { CourseEditInput } from '../gql/graphql';
import { t } from '../i18n';
import type { PlannedCourse } from './usePlanner';

const EditDoc = graphql(`
  mutation EditCourse($courseId: ID!, $variant: Int!, $edit: CourseEditInput!, $stopIds: [ID!]) {
    editCourse(courseId: $courseId, variant: $variant, edit: $edit, stopIds: $stopIds) {
      courseId
      message
      mustShops { id name }
      variant {
        variant label totalDistanceM walkMin totalMin note finishAt breaks { kind afterOrder name lat lng address placeUrl category minutes detourM }
        endLeg { distanceM durationMin path { lat lng } }
        stops {
          order reason arriveAt brands
          legFromPrev { distanceM durationMin path { lat lng } }
          shop {
            id name kind category lat lng roadAddress placeUrl summary priceRange littleKnown hoursToday hoursSource hoursWarning newsTag
            topStyles { style score }
          }
        }
      }
    }
  }
`);

const EditByTextDoc = graphql(`
  mutation EditCourseByText($courseId: ID!, $variant: Int!, $text: String!, $stopIds: [ID!]) {
    editCourseByText(courseId: $courseId, variant: $variant, text: $text, stopIds: $stopIds) {
      courseId
      message
      mustShops { id name }
      variant {
        variant label totalDistanceM walkMin totalMin note finishAt breaks { kind afterOrder name lat lng address placeUrl category minutes detourM }
        endLeg { distanceM durationMin path { lat lng } }
        stops {
          order reason arriveAt brands
          legFromPrev { distanceM durationMin path { lat lng } }
          shop {
            id name kind category lat lng roadAddress placeUrl summary priceRange littleKnown hoursToday hoursSource hoursWarning newsTag
            topStyles { style score }
          }
        }
      }
    }
  }
`);

const BreakDoc = graphql(`
  mutation SetCourseBreak($courseId: ID!, $variant: Int!, $kind: String!, $on: Boolean!, $stopIds: [ID!], $avoid: [String!]) {
    setCourseBreak(courseId: $courseId, variant: $variant, kind: $kind, on: $on, stopIds: $stopIds, avoid: $avoid) {
      courseId
      message
      mustShops { id name }
      variant {
        variant label totalDistanceM walkMin totalMin note finishAt breaks { kind afterOrder name lat lng address placeUrl category minutes detourM }
        endLeg { distanceM durationMin path { lat lng } }
        stops {
          order reason arriveAt brands
          legFromPrev { distanceM durationMin path { lat lng } }
          shop {
            id name kind category lat lng roadAddress placeUrl summary priceRange littleKnown hoursToday hoursSource hoursWarning newsTag
            topStyles { style score }
          }
        }
      }
    }
  }
`);

const UndoDoc = graphql(`
  mutation UndoCourseEdit($courseId: ID!, $variant: Int!) {
    undoCourseEdit(courseId: $courseId, variant: $variant) {
      courseId
      message
      mustShops { id name }
      variant {
        variant label totalDistanceM walkMin totalMin note finishAt breaks { kind afterOrder name lat lng address placeUrl category minutes detourM }
        endLeg { distanceM durationMin path { lat lng } }
        stops {
          order reason arriveAt brands
          legFromPrev { distanceM durationMin path { lat lng } }
          shop {
            id name kind category lat lng roadAddress placeUrl summary priceRange littleKnown hoursToday hoursSource hoursWarning newsTag
            topStyles { style score }
          }
        }
      }
    }
  }
`);

const PinDoc = graphql(`
  mutation PinCourseShop($courseId: ID!, $shopId: ID!, $on: Boolean!) {
    pinCourseShop(courseId: $courseId, shopId: $shopId, on: $on) { courseId mustShops { id name } }
  }
`);

type Variant = PlannedCourse['variants'][number];

/** What an edit can change (shops in order, breaks); the same rule as the API's routeKey, so both undo stacks agree. */
const routeKey = (v: Variant | undefined) =>
  v ? JSON.stringify([v.stops.map((s) => s.shop.id), (v.breaks ?? []).map((b) => `${b.kind}:${b.name}:${b.afterOrder}`)]) : '';
type Pin = PlannedCourse['request']['mustShops'][number];

/**
 * Edits on the course on screen: buttons and the assistant. Keeps an undo stack per variant and the shops the user
 * already swapped away, so "다른 가게로" doesn't offer them again.
 */
export function useCourseEdit(course: PlannedCourse | null, variantIndex: number, onChange: (course: PlannedCourse) => void) {
  const [edit, editState] = useMutation(EditDoc);
  const [editByText, textState] = useMutation(EditByTextDoc);
  const [setBreakMutation, breakState] = useMutation(BreakDoc);
  const [pinMutation, pinState] = useMutation(PinDoc);
  const [undoMutation, undoState] = useMutation(UndoDoc);
  const [history, setHistory] = useState<Record<number, Variant[]>>({});
  const [rejected, setRejected] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [passedBreaks, setPassedBreaks] = useState<Record<string, string[]>>({});
  // The last edit asked for, to send again from "다시 시도".
  const [lastEdit, setLastEdit] = useState<(() => Promise<void>) | null>(null);

  // Editing a course opened from a share link edits the server's new copy of it (courseId), which is now mine.
  // Pins come back with every edit (a shop put in by hand is pinned, one taken out is unpinned).
  function replaceVariant(v: Variant, pushUndo = true, courseId = course?.id, pins?: Pin[]) {
    if (!course || !courseId) return;
    const prev = course.variants[variantIndex];
    // Only a change can be undone (the server keeps its stack the same way).
    if (pushUndo && routeKey(prev) !== routeKey(v)) setHistory((h) => ({ ...h, [variantIndex]: [...(h[variantIndex] ?? []), prev] }));
    const copied = courseId !== course.id;
    onChange({
      ...course, id: courseId, shared: copied ? false : course.shared,
      request: pins ? { ...course.request, mustShops: pins } : course.request,
      variants: course.variants.map((x, i) => (i === variantIndex ? v : x)),
    });
  }

  /** Each edit starts without the error of the one before (or of another course). */
  function clearErrors() {
    editState.reset();
    textState.reset();
    breakState.reset();
    pinState.reset();
    undoState.reset();
  }

  /** The card's pin: this shop stays in the next course ("다른 코스", 누구 옷 …). */
  async function pin(shopId: string, on: boolean) {
    if (!course) return;
    clearErrors();
    setMessage(null);
    const name = course.variants[variantIndex].stops.find((s) => s.shop.id === shopId)?.shop.name ?? '';
    const { data } = await pinMutation({ variables: { courseId: course.id, shopId, on } }).catch(() => ({ data: undefined }));
    if (!data) return;
    const r = data.pinCourseShop;
    onChange({ ...course, id: r.courseId, shared: r.courseId !== course.id ? false : course.shared, request: { ...course.request, mustShops: r.mustShops } });
    setMessage(on ? t(`${name} 고정 · 다른 코스에서도 남겨요`, `${name} pinned · it stays in other routes too`) : t(`${name} 고정을 풀었어요`, `${name} unpinned`));
  }

  async function apply(input: CourseEditInput) {
    if (!course) return;
    setLastEdit(() => () => apply(input));
    clearErrors();
    setMessage(null);
    const current = course.variants[variantIndex];
    const out = input.op === 'replace' && input.order ? current.stops[input.order - 1]?.shop.id : undefined;
    const { data } = await edit({
      variables: {
        courseId: course.id,
        variant: variantIndex,
        edit: { ...input, avoid: rejected.length ? rejected : undefined },
        stopIds: current.stops.map((s) => s.shop.id),
      },
    }).catch(() => ({ data: undefined }));
    if (!data) return;
    if (out) setRejected((r) => [...r, out]);
    replaceVariant(data.editCourse.variant, true, data.editCourse.courseId, data.editCourse.mustShops);
    setMessage(data.editCourse.message ?? null);
  }

  async function say(text: string) {
    if (!course || !text.trim()) return;
    setLastEdit(() => () => say(text));
    clearErrors();
    setMessage(null);
    const stopIds = course.variants[variantIndex].stops.map((s) => s.shop.id);
    const { data } = await editByText({ variables: { courseId: course.id, variant: variantIndex, text, stopIds } }).catch(() => ({
      data: undefined,
    }));
    if (!data) return;
    const changed = JSON.stringify(data.editCourseByText.variant.stops.map((s) => s.shop.id)) !==
      JSON.stringify(course.variants[variantIndex].stops.map((s) => s.shop.id));
    if (changed) replaceVariant(data.editCourseByText.variant, true, data.editCourseByText.courseId, data.editCourseByText.mustShops);
    setMessage(data.editCourseByText.message ?? null);
  }

  /** "카페 넣기" / "맛집 넣기": one break of that kind in the course, or out of it. */
  async function setBreak(kind: 'cafe' | 'food', on: boolean, another = false) {
    if (!course) return;
    setLastEdit(() => () => setBreak(kind, on, another));
    clearErrors();
    setMessage(null);
    const stopIds = course.variants[variantIndex].stops.map((s) => s.shop.id);
    // "다른 곳으로": the one shown now joins the places turned down, so the next answer is always new.
    const current = course.variants[variantIndex].breaks?.find((b) => b.kind === kind)?.name;
    const avoid = another ? [...(passedBreaks[kind] ?? []), ...(current ? [current] : [])] : [];
    if (another && current) setPassedBreaks((p) => ({ ...p, [kind]: avoid }));
    const { data } = await setBreakMutation({ variables: { courseId: course.id, variant: variantIndex, kind, on, stopIds, avoid: avoid.length ? avoid : null } }).catch(() => ({ data: undefined }));
    if (!data) return;
    replaceVariant(data.setCourseBreak.variant, true, data.setCourseBreak.courseId);
    setMessage(data.setCourseBreak.message ?? null);
  }

  // Undo on the server too (its own stack of earlier versions), so a reload shows the course as undone.
  async function undo() {
    if (!course) return;
    const stack = history[variantIndex] ?? [];
    if (!stack.length) return;
    setLastEdit(() => () => undo());
    clearErrors();
    setMessage(null);
    const { data } = await undoMutation({ variables: { courseId: course.id, variant: variantIndex } }).catch(() => ({ data: undefined }));
    if (!data) return;
    setHistory((h) => ({ ...h, [variantIndex]: stack.slice(0, -1) }));
    const r = data.undoCourseEdit;
    replaceVariant(r.variant, false, r.courseId, r.mustShops);
    setMessage(r.message ?? t('되돌렸어요', 'Undone'));
  }

  return {
    apply,
    say,
    setBreak,
    pin,
    pinBusy: pinState.loading,
    breakBusy: breakState.loading,
    undo,
    canUndo: (history[variantIndex]?.length ?? 0) > 0,
    busy: editState.loading || textState.loading || breakState.loading || undoState.loading,
    // "고치는 중…" for every kind of edit (buttons too), not only the assistant.
    thinking: editState.loading || textState.loading || breakState.loading || undoState.loading,
    message,
    error: (editState.error ?? textState.error ?? breakState.error ?? pinState.error ?? undoState.error)?.message ?? null,
    /** Send the edit that just failed again. */
    retry: lastEdit,
    reset: () => {
      clearErrors();
      setLastEdit(null);
      setHistory({});
      setRejected([]);
      setPassedBreaks({});
      setMessage(null);
    },
  };
}

export type CourseEditor = ReturnType<typeof useCourseEdit>;
