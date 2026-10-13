import { useApolloClient, useMutation, useQuery } from '@apollo/client';
import { graphql } from '../gql';
import type { MyCoursesQuery } from '../gql/graphql';
import { t } from '../i18n';
import type { PlannedCourse } from './usePlanner';

// Same fields as PlanCourse, so a reopened course is a PlannedCourse.
const CourseDoc = graphql(`
  query SavedCourse($id: ID!) {
    course(id: $id) {
      id
      shared link { prevCourseId prevName fromShop transit { found minutes fare transfers walkM kakaoUrl note steps { mode line from to minutes stops } } }
      origin { lat lng }
      startName
      end { lat lng }
      endName
      request { styles stopCount maxStops timeBudgetMin budget items regionName regionId defaultedFields tasteNote withCafe withFood gender startAt endBy roundTrip brands { key name } mustShops { id name } skipVisited bounds { swLat swLng neLat neLng } ignoreWeather groupId groupNames regionPicked brandRegions { id name brands shops } }
      weather { condition summary rainChance tempC applied note }
      variants {
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

const MyCoursesDoc = graphql(`
  query MyCourses {
    myCourses(limit: 8) {
      id createdAt startName
      request { styles regionName }
      variants { stops { order } }
    }
  }
`);

const ShareDoc = graphql(`
  mutation ShareCourse($courseId: ID!, $variant: Int!, $stopIds: [ID!]) {
    shareCourse(courseId: $courseId, variant: $variant, stopIds: $stopIds)
  }
`);

export type RecentCourse = MyCoursesQuery['myCourses'][number];

/** The share link's query parameter: /?c=<course id>. */
export const SHARE_PARAM = 'c';
/** A shop detail page: /?shop=<shop id>. */
export const SHOP_PARAM = 'shop';

export function useLoadCourse() {
  const client = useApolloClient();
  return async (id: string): Promise<PlannedCourse | null> => {
    const { data } = await client.query({ query: CourseDoc, variables: { id }, fetchPolicy: 'network-only' }).catch(() => ({ data: undefined }));
    return data?.course ?? null;
  };
}

export function useMyCourses(skip = false) {
  return useQuery(MyCoursesDoc, { skip, fetchPolicy: 'cache-and-network' });
}

/**
 * Freezes the variant on screen and hands the link over: the phone's share sheet where there is one, otherwise the
 * clipboard. Returns what happened, for a one-line status.
 */
export function useShareCourse() {
  const [share, { loading }] = useMutation(ShareDoc);
  return {
    busy: loading,
    share: async (course: PlannedCourse, variantIndex: number, title: string): Promise<string | null> => {
      const stopIds = course.variants[variantIndex].stops.map((s) => s.shop.id);
      const { data } = await share({ variables: { courseId: course.id, variant: variantIndex, stopIds } }).catch(() => ({ data: undefined }));
      if (!data) return t('링크를 만들지 못했어요. 잠시 뒤 다시 해 주세요', "Couldn't make the link. Please try again in a moment");
      const url = `${window.location.origin}/?${SHARE_PARAM}=${data.shareCourse}`;
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        try {
          await navigator.share({ title: `ROUTE 01 · ${title}`, url });
          return null;
        } catch (e) {
          if ((e as DOMException).name === 'AbortError') return null; // closed the share sheet
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        return t('링크를 복사했어요', 'Link copied');
      } catch {
        window.prompt(t('이 링크를 복사해 보내세요', 'Copy this link and send it'), url);
        return null;
      }
    },
  };
}

const SavedIdsDoc = graphql(`
  query SavedCourseIds {
    savedCourseIds
  }
`);

const SavedCoursesDoc = graphql(`
  query SavedCourses {
    savedCourses {
      id createdAt startName
      request { styles regionName }
      variants { stops { order shop { name } } }
    }
  }
`);

const SaveCourseDoc = graphql(`
  mutation SaveCourse($courseId: ID!) {
    saveCourse(courseId: $courseId)
  }
`);

const UnsaveCourseDoc = graphql(`
  mutation UnsaveCourse($courseId: ID!) {
    unsaveCourse(courseId: $courseId)
  }
`);

export function useSavedCourses(skip = false) {
  return useQuery(SavedCoursesDoc, { skip, fetchPolicy: 'cache-and-network' });
}

/**
 * The course's "저장" toggle. Saving needs a login (the API's 401 opens the login dialog). Saving someone else's or a
 * shared course saves my own copy: `onNewId` gets its id so the page switches to it.
 */
export function useCourseSave(courseId: string, onNewId: (id: string) => void) {
  const ids = useQuery(SavedIdsDoc, { fetchPolicy: 'cache-and-network' }).data?.savedCourseIds ?? [];
  const refetchQueries = [SavedIdsDoc, SavedCoursesDoc];
  const [save, saving] = useMutation(SaveCourseDoc, { refetchQueries });
  const [unsave, unsaving] = useMutation(UnsaveCourseDoc, { refetchQueries });
  const saved = ids.includes(courseId);
  return {
    saved,
    busy: saving.loading || unsaving.loading,
    toggle: async () => {
      if (saved) {
        await unsave({ variables: { courseId } }).catch(() => undefined);
        return;
      }
      const res = await save({ variables: { courseId } }).catch(() => null);
      const id = res?.data?.saveCourse;
      if (id && id !== courseId) onNewId(id);
    },
  };
}
