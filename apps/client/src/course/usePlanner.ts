import { useMutation, useQuery } from '@apollo/client';
import { useRef, useState } from 'react';
import { graphql } from '../gql';
import type { ParsePromptMutation, PlanCourseMutation } from '../gql/graphql';

const CatalogDoc = graphql(`
  query CourseCatalog {
    catalog {
      styles { id label }
      items { id label }
      budgets { id label }
      stopCountOptions
      timeBudgetOptionsMin
      defaults { stopCount timeBudgetMin }
    }
  }
`);

const PlanDoc = graphql(`
  mutation PlanCourse($request: CourseRequestInput!) {
    planCourse(request: $request) {
      id
      shared link { prevCourseId prevName fromShop transit { found minutes fare transfers walkM kakaoUrl note steps { mode line from to minutes stops } } }
      origin { lat lng }
      startName
      request { styles stopCount maxStops timeBudgetMin budget items regionName regionId defaultedFields tasteNote withCafe withFood gender }
      variants {
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

const ParsePromptDoc = graphql(`
  mutation ParsePrompt($text: String!) {
    parsePrompt(text: $text) {
      regionId regionName point { lat lng } placeName
      styles { id weight }
      stopCount maxStops timeBudgetMin budget items wantsCafe wantsFood unsupported summary
      mustShops { id name } mustNotFound gender
    }
  }
`);

const ParsePhotoDoc = graphql(`
  mutation ParsePhoto($imageBase64: String!, $mimeType: String!) {
    parsePhoto(imageBase64: $imageBase64, mimeType: $mimeType) {
      styles { id weight }
      items
      description
    }
  }
`);

export type PlannedCourse = PlanCourseMutation['planCourse'];
export type ParsedPrompt = ParsePromptMutation['parsePrompt'];
export type LatLng = { lat: number; lng: number };
export type Origin = { regionId?: string; point?: LatLng; gps?: LatLng; label?: string; bounds?: { swLat: number; swLng: number; neLat: number; neLng: number } };
/** How a course was asked for, for the usage numbers (apps/api INPUT_MODES). */
export type InputMode = 'buttons' | 'here' | 'point' | 'text' | 'photo' | 'preset' | 'again';

/** Everything the form holds. A parse result or a re-run passes a full copy, since state updates land later. */
interface Form {
  styles: string[];
  stopCount: number | null;
  maxStops: boolean;
  timeBudget: number | null;
  budget: string;
  items: string[];
  skipVisited: boolean;
  /** A café break in the middle of the course. */
  withCafe: boolean;
  /** A meal on the way. */
  withFood: boolean;
  /** "꼭 넣을 가게": always in the course when it fits (chosen by name, or from the text). */
  mustShops: MustShop[];
  /** "누구 옷": any | men | women. */
  gender: Gender;
}

export type Gender = 'any' | 'men' | 'women';

export type MustShop = { id: string; name: string };

/** Rough minutes for n stops: 15 min browsing each + about 5 min walking between. Same dwell as the API. */
export const estimateMin = (stops: number) => stops * 20;

// Matches MIN_STOPS / MAX_STOPS in apps/api/src/course/course.service.ts.
export const MIN_STOPS = 2;
export const MAX_STOPS = 20;

/** The request form state, the planCourse call, and the AI helpers that fill the form from text or a photo. */
export function usePlanner(onPlanned: (course: PlannedCourse) => void) {
  const catalog = useQuery(CatalogDoc).data?.catalog;
  const [styles, setStyles] = useState<string[]>([]);
  const [stopCount, setStopCount] = useState<number | null>(null);
  const [maxStops, setMaxStops] = useState(false);
  const [timeBudget, setTimeBudget] = useState<number | null>(null);
  const [budget, setBudget] = useState('any');
  const [items, setItems] = useState<string[]>([]);
  const [skipVisited, setSkipVisited] = useState(false);
  const [withCafe, setWithCafe] = useState(false);
  const [withFood, setWithFood] = useState(false);
  const [mustShops, setMustShops] = useState<MustShop[]>([]);
  const [gender, setGender] = useState<Gender>('any');
  const [locating, setLocating] = useState(false);
  const [plan, { loading, error, reset }] = useMutation(PlanDoc);
  const [parsePrompt, parseState] = useMutation(ParsePromptDoc);
  const [parsePhoto, photoState] = useMutation(ParsePhotoDoc);
  const lastOrigin = useRef<Origin | null>(null);
  const lastForm = useRef<Form | null>(null);
  // Shops already shown, per set of conditions: planning the same conditions again pushes them back for a new course.
  const seen = useRef(new Map<string, Set<string>>());
  // A photo only fills the chips; the course planned next from the buttons counts as a photo request.
  const fromPhotoNext = useRef(false);

  const current = (): Form => ({ styles, stopCount, maxStops, timeBudget, budget, items, skipVisited, withCafe, withFood, mustShops, gender });

  function apply(f: Form) {
    setStyles(f.styles);
    setStopCount(f.stopCount);
    setMaxStops(f.maxStops);
    setTimeBudget(f.timeBudget);
    setBudget(f.budget);
    setItems(f.items);
    setSkipVisited(f.skipVisited);
    setWithCafe(f.withCafe);
    setWithFood(f.withFood);
    setMustShops(f.mustShops);
    setGender(f.gender);
  }

  async function run(origin: Origin, form: Form = current(), mode?: InputMode, extra: { continueFrom?: string; keepShopIds?: string[] } = {}) {
    reset();
    const inputMode: InputMode = mode ?? (fromPhotoNext.current ? 'photo' : origin.gps ? 'here' : origin.point ? 'point' : 'buttons');
    fromPhotoNext.current = false;
    lastOrigin.current = origin;
    lastForm.current = form;
    const key = conditionsKey(origin, form);
    const seenIds = seen.current.get(key);
    const { data } = await plan({
      variables: {
        request: {
          origin,
          styles: form.styles.map((id) => ({ id, weight: 1 })),
          stopCount: form.maxStops ? undefined : form.stopCount ?? undefined,
          maxStops: form.maxStops || undefined,
          timeBudgetMin: form.timeBudget ?? undefined,
          budget: form.budget === 'any' ? undefined : form.budget,
          items: form.items.length ? form.items : undefined,
          skipVisited: form.skipVisited || undefined,
          withCafe: form.withCafe || undefined,
          withFood: form.withFood || undefined,
          seenShopIds: seenIds?.size ? [...seenIds] : undefined,
          keepShopIds: extra.keepShopIds?.length ? extra.keepShopIds : undefined,
          mustShopIds: form.mustShops.length ? form.mustShops.map((m) => m.id) : undefined,
          gender: form.gender === 'any' ? undefined : form.gender,
          inputMode,
          continueFrom: extra.continueFrom,
        },
      },
    }).catch(() => ({ data: undefined })); // the error is shown from `error`
    if (!data) return;
    const ids = seenIds ?? new Set<string>();
    for (const v of data.planCourse.variants) for (const s of v.stops) ids.add(s.shop.id);
    seen.current.set(key, ids);
    onPlanned(data.planCourse);
  }

  /** Plan from the device position; falls back to the map centre when permission is refused. */
  async function runHere(fallback: LatLng | null) {
    setLocating(true);
    try {
      const pos = await new Promise<GeolocationPosition>((ok, fail) =>
        navigator.geolocation.getCurrentPosition(ok, fail, { timeout: 8000, maximumAge: 60_000 }),
      );
      await run({ gps: { lat: pos.coords.latitude, lng: pos.coords.longitude } });
    } catch {
      if (fallback) await run({ point: fallback });
    } finally {
      setLocating(false);
    }
  }

  /**
   * Text → form. What the text doesn't mention keeps its current value (so "3시간으로" after picking 빈티지 keeps
   * 빈티지). Returns the parse and the filled form so the caller can plan right away.
   */
  async function fromText(text: string): Promise<{ parsed: ParsedPrompt; form: Form } | null> {
    const { data } = await parsePrompt({ variables: { text } }).catch(() => ({ data: undefined }));
    if (!data) return null;
    const p = data.parsePrompt;
    const form: Form = {
      styles: p.styles.length ? p.styles.map((s) => s.id) : styles,
      stopCount: p.stopCount ?? (p.maxStops ? null : stopCount),
      maxStops: p.maxStops || (p.stopCount == null && maxStops),
      timeBudget: p.timeBudgetMin ?? timeBudget,
      budget: p.budget !== 'any' ? p.budget : budget,
      items: p.items.length ? p.items : items,
      skipVisited,
      withCafe: p.wantsCafe || withCafe,
      withFood: p.wantsFood || withFood,
      // Shops named in the text join the ones already picked.
      gender: p.gender === 'men' || p.gender === 'women' ? p.gender : gender,
      mustShops: [...mustShops, ...p.mustShops.filter((m) => !mustShops.some((x) => x.id === m.id)).map((m) => ({ id: m.id, name: m.name }))],
    };
    apply(form);
    return { parsed: p, form };
  }

  /** A preset card: its region, styles and stop count; everything else back to defaults. */
  function runPreset(p: { regionId: string; styles: string[]; stopCount: number }) {
    const form: Form = { styles: p.styles, stopCount: p.stopCount, maxStops: false, timeBudget: null, budget: 'any', items: [], skipVisited, withCafe, withFood, mustShops: [], gender };
    apply(form);
    return run({ regionId: p.regionId }, form, 'preset');
  }

  /**
   * A course opened from a share link or "지난 코스": its conditions fill the form and become the last request, so
   * "같은 조건으로 다른 코스" works from there too.
   */
  function adopt(c: PlannedCourse) {
    const q = c.request;
    const chosen = (field: string) => !q.defaultedFields.includes(field);
    const form: Form = {
      styles: q.styles,
      stopCount: !q.maxStops && chosen('stopCount') ? q.stopCount : null,
      maxStops: q.maxStops,
      timeBudget: chosen('timeBudgetMin') ? q.timeBudgetMin : null,
      budget: q.budget,
      items: q.items,
      skipVisited: false,
      withCafe: q.withCafe === true,
      withFood: q.withFood === true,
      mustShops: [],
      gender: q.gender === 'men' || q.gender === 'women' ? q.gender : 'any',
    };
    apply(form);
    lastForm.current = form;
    lastOrigin.current = q.regionId ? { regionId: q.regionId } : { point: c.origin, label: c.startName ?? undefined };
    const ids = new Set<string>();
    for (const v of c.variants) for (const s of v.stops) ids.add(s.shop.id);
    seen.current.set(conditionsKey(lastOrigin.current, form), ids);
  }

  /** Photo → style chips (the photo isn't stored). */
  async function fromPhoto(file: File): Promise<string | null> {
    const { base64, mimeType } = await shrink(file);
    const { data } = await parsePhoto({ variables: { imageBase64: base64, mimeType } }).catch(() => ({ data: undefined }));
    if (!data) return null;
    const found = data.parsePhoto.styles.map((s) => s.id);
    if (found.length) setStyles(found);
    if (data.parsePhoto.items.length) setItems(data.parsePhoto.items);
    fromPhotoNext.current = found.length > 0;
    return data.parsePhoto.description;
  }

  return {
    catalog,
    styles,
    toggleStyle: (id: string) => setStyles((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id])),
    stopCount,
    setStopCount,
    maxStops,
    setMaxStops,
    timeBudget,
    setTimeBudget,
    budget,
    setBudget,
    items,
    toggleItem: (id: string) => setItems((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id])),
    skipVisited,
    setSkipVisited,
    withCafe,
    setWithCafe,
    withFood,
    setWithFood,
    mustShops,
    gender,
    setGender,
    addMustShop: (m: MustShop) => setMustShops((s) => (s.some((x) => x.id === m.id) ? s : [...s, m].slice(0, 8))),
    removeMustShop: (id: string) => setMustShops((s) => s.filter((x) => x.id !== id)),
    busy: loading || locating || parseState.loading || photoState.loading,
    locating,
    loading,
    reading: parseState.loading || photoState.loading,
    error: (error ?? parseState.error ?? photoState.error)?.message ?? null,
    run,
    runHere,
    runPreset,
    adopt,
    fromText,
    fromPhoto,
    /**
     * Same conditions, a different course: the shops shown drop back, but the best few of `shown` (and any the user
     * saved) stay, so a good course isn't thrown away whole.
     */
    again: (shown: string[] = []) =>
      lastOrigin.current && lastForm.current ? run(lastOrigin.current, lastForm.current, 'again', { keepShopIds: shown }) : undefined,
    /** Plan the last request again without a time limit, so every chosen stop fits. */
    /**
     * "누구 옷" changed on a course: plan again for it, keeping the shown shops that still fit (the API drops the rest
     * before choosing what to keep).
     */
    changeGender: (g: Gender, shown: string[]) => {
      const form = { ...current(), gender: g };
      setGender(g);
      if (lastOrigin.current) return run(lastOrigin.current, form, 'again', { keepShopIds: shown });
    },
    rerunWithoutTimeLimit: () => {
      const form = { ...current(), timeBudget: null };
      setTimeBudget(null);
      if (lastOrigin.current) return run(lastOrigin.current, form, 'again');
    },
  };
}

export type Planner = ReturnType<typeof usePlanner>;

/** Same place + same choices = same key. A point is rounded to ~50 m so a re-tap nearby counts as the same. */
function conditionsKey(o: Origin, f: Form): string {
  const at = o.regionId ? `r${o.regionId}` : o.point ?? o.gps ? `p${(o.point ?? o.gps)!.lat.toFixed(3)},${(o.point ?? o.gps)!.lng.toFixed(3)}` : '';
  return JSON.stringify([at, [...f.styles].sort(), f.stopCount, f.maxStops, f.timeBudget, f.budget, [...f.items].sort(), f.skipVisited, f.withCafe, f.withFood, f.mustShops.map((m) => m.id).sort(), f.gender]);
}

/** Resize to at most 768px on the long side as JPEG: plenty for style reading, small to upload. */
async function shrink(file: File): Promise<{ base64: string; mimeType: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 768 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/jpeg' };
}
