import { X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { KakaoSymbol } from './AccountBox';
import { loginUrl } from './useAccount';

const EVENT = 'route01:login-required';

/**
 * Ask for a login from anywhere: a button that knows why (찜, 후기, 코스 저장), or the Apollo link when the API answers
 * UNAUTHENTICATED (main.tsx).
 */
export function requireLogin(reason?: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: reason }));
}

/**
 * The login dialog. A native <dialog> opened with showModal(): focus stays inside, Esc and the scrim close it, focus
 * returns to the button that opened it. Kakao is the only way in, so the dialog is one clear action plus "나중에".
 */
export function LoginModal() {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    const open = (e: Event) => {
      setReason((e as CustomEvent<string | undefined>).detail ?? null);
      if (!ref.current?.open) ref.current?.showModal();
    };
    window.addEventListener(EVENT, open);
    return () => window.removeEventListener(EVENT, open);
  }, []);

  const close = () => ref.current?.close();

  return (
    <dialog
      ref={ref}
      className="login-modal"
      aria-labelledby="login-title"
      onClick={(e) => {
        if (e.target === ref.current) close(); // a click on the scrim, outside the box
      }}
    >
      <div className="login-box">
        <button type="button" className="icon-btn login-close" aria-label="닫기" onClick={close}>
          <X size={20} />
        </button>
        <p className="eyebrow mb-2">
          <span>Login</span>
        </p>
        <h2 id="login-title" className="course-title">
          로그인이 필요해요
        </h2>
        <p className="login-reason">{reason ?? '찜, 후기, 코스 저장은 로그인하면 할 수 있어요.'}</p>
        <ul className="login-perks">
          <li>찜한 가게와 저장한 코스가 다른 기기에서도 이어져요</li>
          <li>후기와 별점을 남길 수 있어요</li>
          <li>좋아한 가게로 취향을 배워 다음 코스를 더 잘 골라요</li>
        </ul>
        {/* autoFocus: the dialog's one real action gets focus when it opens */}
        <a className="kakao-login" href={loginUrl()} autoFocus>
          <KakaoSymbol />
          카카오로 계속하기
        </a>
        <button type="button" className="btn-text w-100 justify-content-center mt-1" onClick={close}>
          나중에
        </button>
        <p className="login-note">로그인 전 이 브라우저에 남긴 기록도 계정으로 옮겨져요.</p>
      </div>
    </dialog>
  );
}
