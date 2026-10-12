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
    ownerClaims(status: $status) { id status businessNo ownerName contact message nts createdAt reviewNote shopId shopName roadAddress nickname hasDocument }
  }
`);

const ReviewDoc = graphql(`
  mutation ReviewOwnerClaim($id: ID!, $approve: Boolean!, $note: String) {
    reviewOwnerClaim(id: $id, approve: $approve, note: $note)
  }
`);

const ClaimDocumentDoc = graphql(`
  query OwnerClaimDocument($id: ID!) {
    ownerClaimDocument(id: $id)
  }
`);

/** Admin: one claim's 사업자등록증 photo (data URL), asked for only when opened. */
export function useClaimDocument(id: string | null) {
  return useQuery(ClaimDocumentDoc, { variables: { id: id ?? '' }, skip: !id, fetchPolicy: 'network-only' });
}

export function useMyOwnerStatus(skip = false) {
  return useQuery(MineDoc, { skip, fetchPolicy: 'cache-and-network' });
}

export function useOwnerClaims(status: string) {
  return useQuery(ClaimsDoc, { variables: { status }, fetchPolicy: 'network-only' });
}

export function useReviewClaim() {
  return useMutation(ReviewDoc, { refetchQueries: [ClaimsDoc] });
}
