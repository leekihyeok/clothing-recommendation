import { useQuery } from '@apollo/client';
import { graphql } from '../gql';
import { anonId } from './anonId';

const AccountDoc = graphql(`
  query Account {
    me { loggedIn nickname }
    isAdmin
  }
`);

export function useAccount() {
  const data = useQuery(AccountDoc).data;
  return data ? { ...data.me, isAdmin: data.isAdmin } : null;
}

const here = () => window.location.pathname + window.location.search;

/**
 * Full-page navigations to the API (/auth is proxied): Kakao's consent screen, then back here. The browser id goes
 * along so its saved shops and courses move onto the account.
 */
export const loginUrl = () => `/auth/kakao/login?anon=${encodeURIComponent(anonId())}&next=${encodeURIComponent(here())}`;
export const logoutUrl = (next = here()) => `/auth/logout?next=${encodeURIComponent(next)}`;

let loginResult: string | null | undefined;

/**
 * ?login=ok|cancel|fail on the way back from Kakao → a line to show, and the parameter taken off the URL.
 * Read once per page load (StrictMode calls state initialisers twice).
 */
export function takeLoginResult(): string | null {
  if (loginResult === undefined) loginResult = readLoginResult();
  return loginResult;
}

function readLoginResult(): string | null {
  const url = new URL(window.location.href);
  const result = url.searchParams.get('login');
  if (!result) return null;
  url.searchParams.delete('login');
  window.history.replaceState(null, '', url);
  if (result === 'ok') return '카카오 계정으로 로그인했어요. 이 브라우저의 기록도 계정으로 옮겼어요';
  if (result === 'cancel') return '로그인을 취소했어요';
  if (result === 'out') return '로그아웃했어요. 이제 이 브라우저에만 저장돼요';
  return '로그인하지 못했어요. 잠시 뒤 다시 해 주세요';
}
