import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { graphql } from '../gql';
import type { CourseEditInput } from '../gql/graphql';
import type { PlannedCourse } from './usePlanner';

const EditDoc = graphql(`
  mutation EditCourse($courseId: ID!, $variant: Int!, $edit: CourseEditInput!, $stopIds: [ID!]) {
    editCourse(courseId: $courseId, variant: $variant, edit: $edit, stopIds: $stopIds) {
      courseId
      message
      variant {
        variant label totalDistanceM walkMin totalMin note breaks { kind afterOrder name lat lng address placeUrl category minutes detourM }
        stops {
          order reason
          legFromPrev { distanceM durationMin path { lat lng } }
          shop {
            id name kind category lat lng roadAddress placeUrl summary priceRange littleKnown hoursToday
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
      variant {
        variant label totalDistanceM walkMin totalMin note breaks { kind afterOrder name lat lng address placeUrl category minutes detourM }
        stops {
          order reason
          legFromPrev { distanceM durationMin path { lat lng } }
          shop {
            id name kind category lat lng roadAddress placeUrl summary priceRange littleKnown hoursToday
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
      variant {
        variant label totalDistanceM walkMin totalMin note breaks { kind afterOrder name lat lng address placeUrl category minutes detourM }
        stops {
          order reason
          legFromPrev { distanceM durationMin path { lat lng } }
          shop {
            id name kind category lat lng roadAddress placeUrl summary priceRange littleKnown hoursToday
            topStyles { style score }
          }
        }
      }
    }
  }
`);

type Variant = PlannedCourse['variants'][number];

/**
 * Edits on the course on screen: buttons and the assistant. Keeps an undo stack per variant and the shops the user
 * already swapped away, so "다른 가게로" doesn't offer them again.
 */
export function useCourseEdit(course: PlannedCourse | null, variantIndex: number, onChange: (course: PlannedCourse) => void) {
  const [edit, editState] = useMutation(EditDoc);
  const [editByText, textState] = useMutation(EditByTextDoc);
  const [setBreakMutation, breakState] = useMutation(BreakDoc);
  const [history, setHistory] = useState<Record<number, Variant[]>>({});
  const [rejected, setRejected] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [passedBreaks, setPassedBreaks] = useState<Record<string, string[]>>({});

  // Editing a course opened from a share link edits the server's new copy of it (courseId), which is now mine.
  function replaceVariant(v: Variant, pushUndo = true, courseId = course?.id) {
    if (!course || !courseId) return;
    const prev = course.variants[variantIndex];
    if (pushUndo) setHistory((h) => ({ ...h, [variantIndex]: [...(h[variantIndex] ?? []), prev] }));
    const copied = courseId !== course.id;
    onChange({ ...course, id: courseId, shared: copied ? false : course.shared, variants: course.variants.map((x, i) => (i === variantIndex ? v : x)) });
  }

  async function apply(input: CourseEditInput) {
    if (!course) return;
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
    replaceVariant(data.editCourse.variant, true, data.editCourse.courseId);
    setMessage(data.editCourse.message ?? null);
  }

  async function say(text: string) {
    if (!course || !text.trim()) return;
    setMessage(null);
    const stopIds = course.variants[variantIndex].stops.map((s) => s.shop.id);
    const { data } = await editByText({ variables: { courseId: course.id, variant: variantIndex, text, stopIds } }).catch(() => ({
      data: undefined,
    }));
    if (!data) return;
    const changed = JSON.stringify(data.editCourseByText.variant.stops.map((s) => s.shop.id)) !==
      JSON.stringify(course.variants[variantIndex].stops.map((s) => s.shop.id));
    if (changed) replaceVariant(data.editCourseByText.variant, true, data.editCourseByText.courseId);
    setMessage(data.editCourseByText.message ?? null);
  }

  /** "카페 넣기" / "맛집 넣기": one break of that kind in the course, or out of it. */
  async function setBreak(kind: 'cafe' | 'food', on: boolean, another = false) {
    if (!course) return;
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

  // Undo is local: the previous variant comes back on screen. Every edit sends the stops on screen (stopIds), so the
  // next edit starts from what the user sees; the server keeps the edit log as it happened.
  function undo() {
    const stack = history[variantIndex] ?? [];
    const last = stack[stack.length - 1];
    if (!last) return;
    setHistory((h) => ({ ...h, [variantIndex]: stack.slice(0, -1) }));
    replaceVariant(last, false);
    setMessage('되돌렸어요');
  }

  return {
    apply,
    say,
    setBreak,
    breakBusy: breakState.loading,
    undo,
    canUndo: (history[variantIndex]?.length ?? 0) > 0,
    busy: editState.loading || textState.loading || breakState.loading,
    thinking: textState.loading,
    message,
    error: (editState.error ?? textState.error ?? breakState.error)?.message ?? null,
    reset: () => {
      setHistory({});
      setRejected([]);
      setPassedBreaks({});
      setMessage(null);
    },
  };
}

export type CourseEditor = ReturnType<typeof useCourseEdit>;
