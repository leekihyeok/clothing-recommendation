import { t } from '../i18n';
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
          {t('', 'Saved to ')}
          <strong>{account.nickname ?? t('카카오 계정', 'your Kakao account')}</strong>
          {t('님 계정에 저장돼요. 다른 기기에서 로그인해도 이어져요.', "'s account. Log in on any device to pick up where you left off.")}{' '}
          <a className="btn-text p-0" style={{ minHeight: 0 }} href={logoutUrl()}>
            {t('로그아웃', 'Log out')}
          </a>
          {account.isAdmin && (
            <>
              {' · '}
              <a className="btn-text p-0" style={{ minHeight: 0 }} href="/admin">
                {t('관리자 화면', 'Admin')}
              </a>
            </>
          )}
        </p>
      ) : (
        <>
          <p className="hint mt-0">
            {anonIdPersists()
              ? t('지금은 이 브라우저에만 저장돼요. 카카오로 로그인하면 다른 기기에서도 이어져요.', 'For now this is saved in this browser only. Log in with Kakao to keep it on every device.')
              : t(
                  '이 브라우저는 저장소를 막고 있어서, 창을 닫으면 기록이 사라져요. 로그인하면 계정에 남아요.',
                  'This browser blocks storage, so your history goes when you close the window. Log in to keep it in your account.',
                )}
          </p>
          <a className="kakao-login" href={loginUrl()}>
            <KakaoSymbol />
            {t('카카오 로그인', 'Log in with Kakao')}
          </a>
        </>
      )}
    </div>
  );
}
