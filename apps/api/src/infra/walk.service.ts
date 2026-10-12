import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

type LatLng = { lat: number; lng: number };

export interface WalkLeg {
  distanceM: number;
  durationMin: number;
  path: LatLng[];
}

const URL = 'https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1&format=json';
// Streets don't move: a leg stays cached for 90 days.
const CACHE_DAYS = 90;
const CONCURRENCY = 4;
// T map calls per day (Seoul) before falling back to the straight-line estimate, so the free quota isn't run past.
// TMAP_DAILY_CAP in .env; the count is in Redis (walk:calls:<date>), shown on the admin page.
const DEFAULT_DAILY_CAP = 800;

/**
 * Real walking routes from the T map pedestrian API (PLAN.md 6.5): the street path, distance and time per leg.
 * Each leg is cached in Redis. Without TMAP_APP_KEY, or when a call fails, returns null and callers keep the
 * straight-line estimate (distance × 1.3), so courses always render.
 */
@Injectable()
export class WalkService {
  private readonly log = new Logger(WalkService.name);
  private readonly key: string | undefined;
  private readonly dailyCap: number;
  // The same leg asked for twice at once (the three versions of a course share legs): one T map call.
  private readonly inFlight = new Map<string, Promise<WalkLeg | null>>();

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.key = config.get<string>('TMAP_APP_KEY') || undefined;
    this.dailyCap = Number(config.get<string>('TMAP_DAILY_CAP') ?? DEFAULT_DAILY_CAP);
  }

  get enabled(): boolean {
    return !!this.key;
  }

  /** Routes for consecutive pairs; null entries where no route could be had. */
  async legs(points: LatLng[]): Promise<(WalkLeg | null)[]> {
    if (!this.key || points.length < 2) return points.slice(1).map(() => null);
    const pairs = points.slice(1).map((b, i) => [points[i], b] as const);
    const out: (WalkLeg | null)[] = new Array(pairs.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < pairs.length) {
        const i = next++;
        out[i] = await this.leg(pairs[i][0], pairs[i][1]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, worker));
    return out;
  }

  private leg(a: LatLng, b: LatLng): Promise<WalkLeg | null> {
    // ~10 m: the same shop door, the same station exit.
    const cacheKey = `walk:v2:${a.lat.toFixed(4)},${a.lng.toFixed(4)}:${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
    const running = this.inFlight.get(cacheKey);
    if (running) return running;
    const p = this.fetchLeg(a, b, cacheKey).finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, p);
    return p;
  }

  /** Counts one T map call for today; false once today's cap is reached (Redis down: no cap, as before). */
  private async spend(): Promise<boolean> {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
    try {
      if (this.redis.client.status === 'wait') await this.redis.client.connect();
      const n = await this.redis.client.incr(`walk:calls:${day}`);
      if (n === 1) await this.redis.client.expire(`walk:calls:${day}`, 3 * 86400);
      if (n === this.dailyCap) this.log.warn(`T map daily cap (${this.dailyCap}) reached: straight-line estimates until midnight`);
      return n <= this.dailyCap;
    } catch {
      return true;
    }
  }

  private async fetchLeg(a: LatLng, b: LatLng, cacheKey: string): Promise<WalkLeg | null> {
    const cached = await this.cacheGet(cacheKey);
    if (cached) return cached;
    if (!(await this.spend())) return null; // over today's cap: the caller keeps the estimate
    try {
      const res = await fetch(URL, {
        method: 'POST',
        headers: { appKey: this.key!, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          startX: String(a.lng),
          startY: String(a.lat),
          endX: String(b.lng),
          endY: String(b.lat),
          startName: encodeURIComponent('출발'),
          endName: encodeURIComponent('도착'),
          reqCoordType: 'WGS84GEO',
          resCoordType: 'WGS84GEO',
          searchOption: '0',
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        this.log.warn(`T map ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      const leg = parse((await res.json()) as TmapResponse);
      if (leg) await this.cacheSet(cacheKey, leg);
      return leg;
    } catch (e) {
      this.log.warn(`T map request failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  private async cacheGet(key: string): Promise<WalkLeg | null> {
    try {
      if (this.redis.client.status === 'wait') await this.redis.client.connect();
      const v = await this.redis.client.get(key);
      return v ? (JSON.parse(v) as WalkLeg) : null;
    } catch {
      return null;
    }
  }

  private async cacheSet(key: string, leg: WalkLeg): Promise<void> {
    try {
      await this.redis.client.set(key, JSON.stringify(leg), 'EX', CACHE_DAYS * 86400);
    } catch {
      // no cache: next request asks T map again
    }
  }
}

interface TmapResponse {
  features?: {
    geometry: { type: 'Point' | 'LineString'; coordinates: number[] | number[][] };
    properties: { totalDistance?: number; totalTime?: number };
  }[];
}

/** T map returns GeoJSON: the first feature carries totals (m, s), LineStrings carry the path as [lng, lat]. */
export function parse(r: TmapResponse): WalkLeg | null {
  const features = r.features ?? [];
  const totals = features.find((f) => f.properties?.totalDistance != null)?.properties;
  const path: LatLng[] = [];
  for (const f of features) {
    if (f.geometry?.type !== 'LineString') continue;
    for (const [lng, lat] of f.geometry.coordinates as number[][]) {
      const last = path[path.length - 1];
      if (!last || last.lat !== lat || last.lng !== lng) path.push({ lat, lng });
    }
  }
  if (!totals || path.length < 2) return null;
  return {
    distanceM: Math.round(totals.totalDistance ?? 0),
    durationMin: Math.round(((totals.totalTime ?? 0) / 60) * 10) / 10,
    path,
  };
}
