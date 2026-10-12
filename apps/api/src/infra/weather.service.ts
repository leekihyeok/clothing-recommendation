import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from './db.service';
import { RedisService } from './redis.service';
import { kmaGrid, kmaHourly } from './kma';

type LatLng = { lat: number; lng: number };

/** What the forecast says for the hours of a course. */
export interface CourseWeatherInfo {
  /** fine | rain | snow | hot | cold */
  condition: 'fine' | 'rain' | 'snow' | 'hot' | 'cold';
  /** highest chance of rain in the window, % */
  rainChance: number;
  /** rain + snow over the window, mm */
  precipMm: number;
  /** temperature at the start, °C */
  tempC: number;
  /** "feels like" range over the window */
  feelsMin: number;
  feelsMax: number;
  /** "비 70% · 18°" */
  summary: string;
}

interface Hourly {
  time: string[];
  temperature_2m: number[];
  apparent_temperature: number[];
  precipitation_probability: (number | null)[];
  precipitation: number[];
  weather_code: number[];
}

// KMA (기상청) short-term forecast when DATA_GO_KR_SERVICE_KEY is set and the service is approved (next ~3 days,
// hourly); Open-Meteo for the days after, or without the key — free and keyless for non-commercial use only.
const URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_MIN = 30;
// The areas' forecasts are fetched ahead (on start, then this often), so the first course of the day in an area
// doesn't wait ~1 s for the forecast service. Points outside the areas still ask on demand.
const WARM_EVERY_MIN = 25;
// Bad weather: rain likely (or enough of it), snow, heat or cold you feel.
const RAIN_CHANCE = 60;
const RAIN_MM = 1;
const HOT_FEELS = 31;
const COLD_FEELS = -5;
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

/** Hourly forecast around a point (cached per ~5 km and half hour), and the verdict for a course's hours. */
@Injectable()
export class WeatherService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(WeatherService.name);
  private warmTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly db: DbService,
  ) {}

  onModuleInit() {
    if (this.config.get<string>('WEATHER_WARM') === '0') return;
    const warm = () => this.warmAreas().catch((e) => this.log.warn(`weather warm-up failed: ${e instanceof Error ? e.message : e}`));
    setTimeout(warm, 5_000).unref();
    this.warmTimer = setInterval(warm, WARM_EVERY_MIN * 60_000);
    this.warmTimer.unref();
  }

  onModuleDestroy() {
    if (this.warmTimer) clearInterval(this.warmTimer);
  }

  /** One forecast per KMA grid cell (5 km) that an area's centre falls in, one after another. */
  private async warmAreas(): Promise<void> {
    const r = await this.db.pool.query<{ lat: number; lng: number }>('SELECT ST_Y(center::geometry) AS lat, ST_X(center::geometry) AS lng FROM regions');
    const cells = new Map<string, LatLng>();
    for (const p of r.rows) {
      const g = kmaGrid(p.lat, p.lng);
      cells.set(`${g.nx},${g.ny}`, p);
    }
    for (const p of cells.values()) await this.hourly(p);
  }

  /** KMA hours first, Open-Meteo for the rest of the 16 days (or all of it without a key). */
  private async hourly(p: LatLng): Promise<Hourly | null> {
    const [kma, om] = await Promise.all([this.kma(p), this.openMeteo(p)]);
    if (!kma) return om;
    if (!om) return kma;
    const last = kma.time[kma.time.length - 1];
    const later = om.time.map((t, i) => [t, i] as const).filter(([t]) => t > last).map(([, i]) => i);
    return {
      time: [...kma.time, ...later.map((i) => om.time[i])],
      temperature_2m: [...kma.temperature_2m, ...later.map((i) => om.temperature_2m[i])],
      apparent_temperature: [...kma.apparent_temperature, ...later.map((i) => om.apparent_temperature[i])],
      precipitation_probability: [...kma.precipitation_probability, ...later.map((i) => om.precipitation_probability[i])],
      precipitation: [...kma.precipitation, ...later.map((i) => om.precipitation[i])],
      weather_code: [...kma.weather_code, ...later.map((i) => om.weather_code[i])],
    };
  }

  private async kma(p: LatLng): Promise<Hourly | null> {
    const serviceKey = this.config.get<string>('DATA_GO_KR_SERVICE_KEY');
    if (!serviceKey) return null;
    const { nx, ny } = kmaGrid(p.lat, p.lng);
    const cacheKey = `weather:kma:v2:${nx},${ny}`;
    try {
      if (this.redis.client.status === 'wait') await this.redis.client.connect();
      const hit = await this.redis.client.get(cacheKey);
      if (hit) return JSON.parse(hit) as Hourly;
    } catch {
      /* no cache */
    }
    try {
      const h = await kmaHourly(serviceKey, p.lat, p.lng);
      if (h) this.redis.client.set(cacheKey, JSON.stringify(h), 'EX', CACHE_MIN * 60).catch(() => undefined);
      else this.log.warn('KMA forecast unavailable (key not approved for 단기예보?) — using Open-Meteo');
      return h;
    } catch (e) {
      this.log.warn(`KMA forecast failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  private async openMeteo(p: LatLng): Promise<Hourly | null> {
    const lat = Math.round(p.lat * 20) / 20;
    const lng = Math.round(p.lng * 20) / 20;
    const key = `weather:v1:${lat},${lng}`;
    try {
      if (this.redis.client.status === 'wait') await this.redis.client.connect();
      const hit = await this.redis.client.get(key);
      if (hit) return JSON.parse(hit) as Hourly;
    } catch {
      /* no cache, ask */
    }
    const q = new URLSearchParams({
      latitude: String(lat), longitude: String(lng), timezone: 'Asia/Seoul', forecast_days: '16',
      hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code',
    });
    try {
      const res = await fetch(`${URL}?${q}`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const h = ((await res.json()) as { hourly: Hourly }).hourly;
      this.redis.client.set(key, JSON.stringify(h), 'EX', CACHE_MIN * 60).catch(() => undefined);
      return h;
    } catch (e) {
      this.log.warn(`weather unavailable: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /**
   * The forecast for a course: from its start (Seoul date + minutes) for its length. null when there's no forecast
   * that far ahead or the service is down — the course is then planned as on a fine day.
   */
  async forCourse(p: LatLng, date: string, startMin: number, lengthMin: number): Promise<CourseWeatherInfo | null> {
    const h = await this.hourly(p);
    if (!h) return null;
    const first = Math.floor(startMin / 60);
    const last = Math.floor((startMin + Math.max(60, lengthMin)) / 60);
    const idx: number[] = [];
    for (let hr = first; hr <= last; hr++) {
      const d = new Date(`${date}T00:00:00+09:00`);
      d.setUTCHours(d.getUTCHours() + hr);
      const local = new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 13); // "2026-10-17T14"
      const i = h.time.findIndex((t) => t.startsWith(local));
      if (i >= 0) idx.push(i);
    }
    if (!idx.length) return null;
    const rainChance = Math.max(...idx.map((i) => h.precipitation_probability[i] ?? 0));
    const precipMm = Math.round(idx.reduce((a, i) => a + (h.precipitation[i] ?? 0), 0) * 10) / 10;
    const feels = idx.map((i) => h.apparent_temperature[i]);
    const feelsMin = Math.round(Math.min(...feels));
    const feelsMax = Math.round(Math.max(...feels));
    const tempC = Math.round(h.temperature_2m[idx[0]]);
    const snow = idx.some((i) => SNOW_CODES.has(h.weather_code[i]));
    const condition: CourseWeatherInfo['condition'] = snow
      ? 'snow'
      : rainChance >= RAIN_CHANCE || precipMm >= RAIN_MM
        ? 'rain'
        : feelsMax >= HOT_FEELS
          ? 'hot'
          : feelsMin <= COLD_FEELS
            ? 'cold'
            : 'fine';
    const what = { snow: `눈 ${rainChance}%`, rain: `비 ${rainChance}%`, hot: `체감 ${feelsMax}°`, cold: `체감 ${feelsMin}°`, fine: rainChance >= 30 ? `비 ${rainChance}%` : '맑거나 흐림' }[condition];
    return { condition, rainChance, precipMm, tempC, feelsMin, feelsMax, summary: `${what} · ${tempC}°` };
  }
}
