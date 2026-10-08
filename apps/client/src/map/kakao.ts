// Loads the Kakao Maps JavaScript SDK once. There are no official TypeScript types, so the surface we use is
// declared loosely here.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Kakao = any;

declare global {
  interface Window {
    kakao?: Kakao;
  }
}

let loading: Promise<Kakao> | null = null;

export function loadKakaoMaps(): Promise<Kakao> {
  if (loading) return loading;
  const key = import.meta.env.VITE_KAKAO_MAP_JS_KEY as string | undefined;
  if (!key) return Promise.reject(new Error('.env의 VITE_KAKAO_MAP_JS_KEY가 비어 있습니다'));

  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${key}&autoload=false&libraries=clusterer`;
    script.async = true;
    script.onload = () => window.kakao!.maps.load(() => resolve(window.kakao));
    script.onerror = () => {
      loading = null;
      reject(new Error('카카오맵을 불러오지 못했습니다. 카카오 개발자 콘솔의 Web 도메인에 이 주소가 등록됐는지 확인하세요'));
    };
    document.head.appendChild(script);
  });
  return loading;
}
