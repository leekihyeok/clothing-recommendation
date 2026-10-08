import { useApolloClient } from '@apollo/client';
import { ArrowUpRight, Bus, NavigationArrow, PersonSimpleWalk, Train } from '@phosphor-icons/react';
import { useState } from 'react';
import { graphql } from '../gql';
import type { TransitRouteQuery } from '../gql/graphql';

const TransitDoc = graphql(`
  query TransitRoute($from: LatLngInput!, $to: LatLngInput!, $fromName: String, $toName: String) {
    transitRoute(from: $from, to: $to, fromName: $fromName, toName: $toName) {
      found minutes fare transfers walkM kakaoUrl note
      steps { mode line from to minutes stops }
    }
  }
`);

export type Route = TransitRouteQuery['transitRoute'];

const ICON = { subway: Train, bus: Bus, walk: PersonSimpleWalk } as const;
const MODE = { subway: '지하철', bus: '버스', walk: '도보' } as const;

/** One public-transit route: totals, then each leg (line name in words, not colour only), then Kakao Map. */
export function TransitCard({ route, title }: { route: Route; title?: string }) {
  return (
    <div className="transit-card">
      {title && <div className="transit-title">{title}</div>}
      {route.found ? (
        <>
          <p className="transit-sum tabular">
            <strong>{route.minutes}분</strong>
            {route.transfers > 0 ? ` · 환승 ${route.transfers}번` : ' · 환승 없음'}
            {route.fare ? ` · ${route.fare.toLocaleString()}원` : ''}
            {route.walkM ? ` · 걷기 ${route.walkM.toLocaleString()}m` : ''}
          </p>
          <ol className="transit-steps">
            {route.steps.map((s, i) => {
              const mode = (s.mode in ICON ? s.mode : 'walk') as keyof typeof ICON;
              const Icon = ICON[mode];
              return (
                <li key={i}>
                  <Icon size={16} aria-hidden />
                  <span>
                    <strong>{mode === 'walk' ? '걷기' : s.line || MODE[mode]}</strong>
                    {mode !== 'walk' && s.from && s.to && ` ${s.from} → ${s.to}`}
                    {s.stops ? ` (${s.stops}정거장)` : ''}
                  </span>
                  <span className="tabular">{s.minutes}분</span>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        route.note && <p className="hint mt-0">{route.note}</p>
      )}
      <a className="btn-line transit-kakao" href={route.kakaoUrl} target="_blank" rel="noreferrer">
        카카오맵에서 길찾기 <ArrowUpRight size={14} aria-hidden />
      </a>
    </div>
  );
}

/** "출발점까지 가는 길": asks for the position once, then shows the route from here to the course start. */
export function RouteFromHere({ to, toName }: { to: { lat: number; lng: number }; toName: string }) {
  const client = useApolloClient();
  const [route, setRoute] = useState<Route | null>(null);
  const [state, setState] = useState<'idle' | 'locating' | 'loading' | 'denied' | 'error'>('idle');

  async function find() {
    setState('locating');
    const pos = await new Promise<GeolocationPosition | null>((ok) =>
      navigator.geolocation ? navigator.geolocation.getCurrentPosition(ok, () => ok(null), { timeout: 8000, maximumAge: 60_000 }) : ok(null),
    );
    if (!pos) {
      setState('denied');
      return;
    }
    setState('loading');
    const { data } = await client
      .query({
        query: TransitDoc,
        // Only lat/lng: a course origin from the cache also carries __typename, which the input type rejects.
        variables: { from: { lat: pos.coords.latitude, lng: pos.coords.longitude }, to: { lat: to.lat, lng: to.lng }, fromName: '내 위치', toName },
        fetchPolicy: 'network-only',
      })
      .catch(() => ({ data: undefined }));
    if (!data) {
      setState('error');
      return;
    }
    setRoute(data.transitRoute);
    setState('idle');
  }

  if (route) return <TransitCard route={route} title={`내 위치 → ${toName}`} />;
  return (
    <div>
      <button type="button" className="btn-line" disabled={state === 'locating' || state === 'loading'} onClick={find}>
        <NavigationArrow size={16} aria-hidden />
        {state === 'locating' ? '위치 확인 중…' : state === 'loading' ? '길 찾는 중…' : `내 위치에서 ${toName}까지 가는 길`}
      </button>
      {state === 'denied' && <p className="hint">위치를 알 수 없어요. 브라우저에서 위치 권한을 허용하거나, 카카오맵에서 길을 찾아 주세요.</p>}
      {state === 'error' && <p className="hint">길을 불러오지 못했어요. 잠시 뒤 다시 해 주세요.</p>}
    </div>
  );
}
