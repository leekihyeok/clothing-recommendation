import { useMutation, useQuery } from '@apollo/client';
import { graphql } from '../gql';
import type { MyShopsQuery } from '../gql/graphql';

export const StatesDoc = graphql(`
  query MyShopStates($shopIds: [ID!]!) {
    myShopStates(shopIds: $shopIds) { shopId saved visits rating purchased views closedReported }
  }
`);

export const MyShopsDoc = graphql(`
  query MyShops {
    myShops {
      saved { shop { id name kind category lat lng roadAddress inMarket placeUrl prominence labeled status } state { shopId saved visits rating purchased views closedReported lastVisitAt } }
      visited { shop { id name kind category lat lng roadAddress inMarket placeUrl prominence labeled status } state { shopId saved visits rating purchased views closedReported lastVisitAt } }
      frequent { shop { id name kind category lat lng roadAddress inMarket placeUrl prominence labeled status } state { shopId saved visits rating purchased views closedReported lastVisitAt } }
    }
  }
`);

const RecordDoc = graphql(`
  mutation RecordShop($shopId: ID!, $action: String!, $courseId: ID) {
    recordShop(shopId: $shopId, action: $action, courseId: $courseId) { shopId saved visits rating purchased views closedReported }
  }
`);

export const SavedGroupsDoc = graphql(`
  query MySavedGroups {
    mySavedGroups { name regionId center { lat lng } shops { id name } }
  }
`);

const ForgetDoc = graphql(`
  mutation ForgetMe {
    forgetMe
  }
`);

export type MyShopItem = MyShopsQuery['myShops']['saved'][number];
export type ShopAction = 'save' | 'unsave' | 'visit' | 'unvisit' | 'like' | 'dislike' | 'unrate' | 'purchase' | 'closed' | 'view';

/** My state for a set of shops (♡, visited, rating). States are cached per shopId, so a record updates every card. */
export function useShopStates(shopIds: string[]) {
  const { data } = useQuery(StatesDoc, { variables: { shopIds }, skip: !shopIds.length });
  return new Map((data?.myShopStates ?? []).map((s) => [s.shopId, s]));
}

export function useRecordShop() {
  const [record, { loading }] = useMutation(RecordDoc, {
    // "내 가게" lists change with saves and visits.
    refetchQueries: [MyShopsDoc, SavedGroupsDoc],
  });
  return {
    busy: loading,
    record: (shopId: string, action: ShopAction, courseId?: string) =>
      record({ variables: { shopId, action, courseId } }).catch(() => undefined),
  };
}

export function useMyShops(skip = false) {
  return useQuery(MyShopsDoc, { skip, fetchPolicy: 'cache-and-network' });
}

export function useSavedGroups(skip = false) {
  return useQuery(SavedGroupsDoc, { skip, fetchPolicy: 'cache-and-network' });
}

export function useForgetMe() {
  return useMutation(ForgetDoc);
}
