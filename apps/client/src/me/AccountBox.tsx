import { loginUrl, logoutUrl, useAccount } from './useAccount';
import { anonIdPersists } from './anonId';

/** Kakao's speech-bubble symbol (Kakao login button guide: black symbol on #FEE500). */
export function KakaoSymbol() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#000"
        d="M12 3C6.48 3 2 6.48 2 10.78c0 2.78 1.86 5.21 4.66 6.59l-.95 3.48c-.08.3.26.54.52.37l4.13-2.73c.54.07 1.08.11 1.64.11 5.52 0 10-3.48 10-7.82S17.52 3 12 3z"
      />
    </svg>
  );
}

/** Top of "내 가게": who the records belong to, and the Kakao login / logout. */
export function AccountBox({ notice }: { notice: string | null }) {
  const account = useAccount();
  return (
    <div className="account-box">
      {notice && (
        <p className="account-notice" role="status">
          {notice}
        </p>
      )}
      {account?.loggedIn ? (
        <p className="hint mt-0">
          <strong>{account.nickname ?? '카카오 계정'}</strong>님 계정에 저장돼요. 다른 기기에서 로그인해도 이어져요.{' '}
          <a className="btn-text p-0" style={{ minHeight: 0 }} href={logoutUrl()}>
            로그아웃
          </a>
          {account.isAdmin && (
            <>
              {' · '}
              <a className="btn-text p-0" style={{ minHeight: 0 }} href="/admin">
                관리자 화면
              </a>
            </>
          )}
        </p>
      ) : (
        <>
          <p className="hint mt-0">
            {anonIdPersists()
              ? '지금은 이 브라우저에만 저장돼요. 카카오로 로그인하면 다른 기기에서도 이어져요.'
              : '이 브라우저는 저장소를 막고 있어서, 창을 닫으면 기록이 사라져요. 로그인하면 계정에 남아요.'}
          </p>
          <a className="kakao-login" href={loginUrl()}>
            <KakaoSymbol />
            카카오 로그인
          </a>
        </>
      )}
    </div>
  );
}
