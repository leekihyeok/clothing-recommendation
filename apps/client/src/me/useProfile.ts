import { useMutation, useQuery } from '@apollo/client';
import { graphql } from '../gql';

const ProfileDoc = graphql(`
  query MyProfile {
    myProfile { nickname avatarUrl joinedAt savedCourses reviews }
  }
`);

const MyReviewsDoc = graphql(`
  query MyReviews {
    myReviews { id rating body updatedAt shopId shopName category }
  }
`);

const NicknameDoc = graphql(`
  mutation UpdateNickname($nickname: String!) {
    updateNickname(nickname: $nickname)
  }
`);

const AvatarDoc = graphql(`
  mutation UpdateAvatar($imageBase64: String!) {
    updateAvatar(imageBase64: $imageBase64)
  }
`);

const RemoveAvatarDoc = graphql(`
  mutation RemoveAvatar {
    removeAvatar
  }
`);

const DeleteAccountDoc = graphql(`
  mutation DeleteAccount {
    deleteAccount { kakaoUnlinked }
  }
`);

const TasteDoc = graphql(`
  query MyTaste {
    myTaste { likes { style weight } avoids { style weight } signals active price }
  }
`);

export function useTaste() {
  return useQuery(TasteDoc, { fetchPolicy: 'cache-and-network' });
}

export function useProfile() {
  return useQuery(ProfileDoc, { fetchPolicy: 'cache-and-network' });
}

export function useMyReviews(skip = false) {
  return useQuery(MyReviewsDoc, { skip, fetchPolicy: 'cache-and-network' });
}

export function useProfileEdits() {
  const refetchQueries = [ProfileDoc, 'Account', 'ShopDetail', 'ShopReviews'];
  const [nickname, n] = useMutation(NicknameDoc, { refetchQueries });
  const [avatar, a] = useMutation(AvatarDoc, { refetchQueries });
  const [removeAvatar, r] = useMutation(RemoveAvatarDoc, { refetchQueries });
  const [deleteAccount, d] = useMutation(DeleteAccountDoc);
  return {
    setNickname: (value: string) => nickname({ variables: { nickname: value } }),
    nicknameState: n,
    setAvatar: async (file: File) => avatar({ variables: { imageBase64: await squareJpeg(file, 256) } }),
    avatarState: a,
    removeAvatar: () => removeAvatar(),
    removeState: r,
    deleteAccount: () => deleteAccount(),
    deleteState: d,
  };
}

/** Centre-crop to a square and shrink to `size` px as JPEG (base64 without the data: prefix). */
async function squareJpeg(file: File, size: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return url.slice(url.indexOf(',') + 1);
}
