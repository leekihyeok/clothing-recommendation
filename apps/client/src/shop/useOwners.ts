import { useMutation, useQuery } from '@apollo/client';
import { graphql } from '../gql';

const MineDoc = graphql(`
  query MyOwnerStatus {
    ownedShops { shopId shopName }
    myClaims { id status reviewNote createdAt shopId shopName }
  }
`);

const ClaimsDoc = graphql(`
  query OwnerClaims($status: String!) {
    ownerClaims(status: $status) { id status businessNo ownerName contact message nts createdAt reviewNote shopId shopName roadAddress nickname }
  }
`);

const ReviewDoc = graphql(`
  mutation ReviewOwnerClaim($id: ID!, $approve: Boolean!, $note: String) {
    reviewOwnerClaim(id: $id, approve: $approve, note: $note)
  }
`);

export function useMyOwnerStatus(skip = false) {
  return useQuery(MineDoc, { skip, fetchPolicy: 'cache-and-network' });
}

export function useOwnerClaims(status: string) {
  return useQuery(ClaimsDoc, { variables: { status }, fetchPolicy: 'network-only' });
}

export function useReviewClaim() {
  return useMutation(ReviewDoc, { refetchQueries: [ClaimsDoc] });
}
