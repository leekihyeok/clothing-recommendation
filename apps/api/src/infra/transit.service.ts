import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

type LatLng = { lat: number; lng: number };

export interface TransitStep {
  /** subway | bus | walk */
  mode: string;
  /** "2호선", "간선 472", "도보" */
  line: string;
  from?: string;
  to?: string;
  minutes: number;
  stops?: number;
}

export interface TransitRoute {
  minutes: number;
  fare?: number;
  transfers: number;
  walkM: number;
  steps: TransitStep[];
  /** Kakao Map directions for the same trip (always there, also when ODsay is off). */
  kakaoUrl: string;
  /** false: too close for transit (under ~700 m) or no ODsay key / no route; walk or use the Kakao link. */
  found: boolean;
  note?: string;
}

const URL = 'https://api.odsay.com/v1/api/searchPubTransPathT';
const CACHE_HOURS = 12;

/** Kakao Map's public directions link: opens their route search (transit, car, walk) from one point to another. */
export function kakaoDirections(from: LatLng & { name?: string }, to: LatLng & { name?: string }): string {
  const a = `${encodeURIComponent(from.name ?? '출발')},${from.lat},${from.lng}`;
  const b = `${encodeURIComponent(to.name ?? '도착')},${to.lat},${to.lng}`;
  return `https://map.kakao.com/link/from/${a}/to/${b}`;
}

/**
 * Public transit routes from ODsay (subway + bus, best path): getting to a course's start, and between two courses in
 * different areas. Cached in Redis. Without ODSAY_API_KEY every answer is found:false with the Kakao Map link, which
 * opens the same search in Kakao Map.
 */
@Injectable()
export class TransitService {
  private readonly log = new Logger(TransitService.name);
  private readonly key: string | undefined;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.key = config.get<string>('ODSAY_API_KEY') || undefined;
  }

  get enabled(): boolean {
    return !!this.key;
  }

  async route(from: LatLng & { name?: string }, to: LatLng & { name?: string }): Promise<TransitRoute> {
    const kakaoUrl = kakaoDirections(from, to);
    const none = (note: string): TransitRoute => ({ minutes: 0, transfers: 0, walkM: 0, steps: [], kakaoUrl, found: false, note });
    if (!this.key) return none('대중교통 경로는 카카오맵에서 볼 수 있어요');
    const cacheKey = `transit:v1:${from.lat.toFixed(4)},${from.lng.toFixed(4)}:${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
    const cached = await this.cacheGet(cacheKey);
    if (cached) return { ...cached, kakaoUrl };
    try {
      const q = new URLSearchParams({ SX: String(from.lng), SY: String(from.lat), EX: String(to.lng), EY: String(to.lat), apiKey: this.key });
      const res = await fetch(`${URL}?${q}`, { signal: AbortSignal.timeout(6000) });
      const json = (await res.json()) as OdsayResponse;
      const err = json.error;
      if (err) {
        // -98: start and end within 700 m. Other codes: quota, key, no route.
        const code = String(Array.isArray(err) ? err[0]?.code : err.code);
        if (code === '-98') return none('가까워서 걸어가는 게 나아요');
        this.log.warn(`ODsay error ${code}: ${JSON.stringify(err).slice(0, 200)}`);
        return none('대중교통 경로를 찾지 못했어요. 카카오맵에서 확인해 주세요');
      }
      const best = json.result?.path?.[0];
      if (!best) return none('대중교통 경로를 찾지 못했어요. 카카오맵에서 확인해 주세요');
      const route: TransitRoute = {
        minutes: best.info.totalTime,
        fare: best.info.payment || undefined,
        transfers: Math.max(0, best.info.busTransitCount + best.info.subwayTransitCount - 1),
        walkM: best.info.totalWalk,
        steps: best.subPath
          .filter((p) => p.sectionTime > 0 || p.trafficType !== 3)
          .map((p) => ({
            mode: p.trafficType === 1 ? 'subway' : p.trafficType === 2 ? 'bus' : 'walk',
            line: p.trafficType === 3 ? '도보' : (p.lane?.[0]?.name ?? p.lane?.[0]?.busNo ?? '').replace(/^수도권\s*/, ''),
            from: p.startName,
            to: p.endName,
            minutes: p.sectionTime,
            stops: p.stationCount,
          })),
        kakaoUrl,
        found: true,
      };
      await this.cacheSet(cacheKey, route);
      return route;
    } catch (e) {
      this.log.warn(`ODsay request failed: ${e instanceof Error ? e.message : e}`);
      return none('대중교통 경로를 불러오지 못했어요. 카카오맵에서 확인해 주세요');
    }
  }

  private async cacheGet(key: string): Promise<TransitRoute | null> {
    try {
      if (this.redis.client.status === 'wait') await this.redis.client.connect();
      const v = await this.redis.client.get(key);
      return v ? (JSON.parse(v) as TransitRoute) : null;
    } catch {
      return null;
    }
  }

  private async cacheSet(key: string, route: TransitRoute): Promise<void> {
    try {
      await this.redis.client.set(key, JSON.stringify(route), 'EX', CACHE_HOURS * 3600);
    } catch {
      // no cache
    }
  }
}

interface OdsayResponse {
  error?: { code: string | number; msg?: string } | { code: string | number; message?: string }[];
  result?: {
    path?: {
      info: { totalTime: number; payment: number; busTransitCount: number; subwayTransitCount: number; totalWalk: number };
      subPath: {
        trafficType: 1 | 2 | 3;
        sectionTime: number;
        stationCount?: number;
        startName?: string;
        endName?: string;
        lane?: { name?: string; busNo?: string }[];
      }[];
    }[];
  };
}
