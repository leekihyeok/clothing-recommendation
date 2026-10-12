/**
 * 기상청 단기예보 (VilageFcstInfoService_2.0 / getVilageFcst on data.go.kr): hourly forecast for the next ~3 days on
 * the KMA 5 km grid. Used instead of Open-Meteo when DATA_GO_KR_SERVICE_KEY is set and the service is approved;
 * WeatherService falls back to Open-Meteo for later days or when this fails.
 */

const URL = 'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst';
// Issued at 02, 05, 08, 11, 14, 17, 20, 23 h; available about 10 minutes later.
const BASE_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];

/** Lat/lng → KMA grid (nx, ny): the Lambert conformal conic projection from the KMA's own documentation. */
export function kmaGrid(lat: number, lng: number): { nx: number; ny: number } {
  const RE = 6371.00877 / 5.0; // earth radius / grid size (km)
  const DEG = Math.PI / 180;
  const slat1 = 30 * DEG;
  const slat2 = 60 * DEG;
  const olon = 126 * DEG;
  const olat = 38 * DEG;
  const XO = 43;
  const YO = 136;
  let sn = Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (RE * sf) / Math.pow(ro, sn);
  let ra = Math.tan(Math.PI * 0.25 + lat * DEG * 0.5);
  ra = (RE * sf) / Math.pow(ra, sn);
  let theta = lng * DEG - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;
  return { nx: Math.floor(ra * Math.sin(theta) + XO + 0.5), ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5) };
}

/** The latest issued forecast at a Seoul time: base_date YYYYMMDD and base_time HH00. */
export function kmaBase(now = new Date()): { date: string; time: string } {
  const seoul = new Date(now.getTime() + 9 * 3600_000 - 10 * 60_000); // 10 minutes for it to come out
  let h = seoul.getUTCHours();
  let base = [...BASE_HOURS].reverse().find((b) => b <= h);
  if (base === undefined) {
    // before 02:10: yesterday's 23:00
    seoul.setUTCDate(seoul.getUTCDate() - 1);
    base = 23;
  }
  h = base;
  const date = seoul.toISOString().slice(0, 10).replace(/-/g, '');
  return { date, time: `${String(h).padStart(2, '0')}00` };
}

/** "강수없음" → 0, "1mm 미만" → 0.5, "1.0mm" → 1, "30.0~50.0mm" → 30, "50.0mm 이상" → 50. */
export function kmaRain(v: string): number {
  if (!v || v.includes('없음')) return 0;
  if (v.includes('미만')) return 0.5;
  const m = /([\d.]+)/.exec(v);
  return m ? Number(m[1]) : 0;
}

/**
 * Apparent temperature (Australian BoM / Steadman, shade): from air temperature, humidity and wind — KMA gives no
 * "feels like" in this service. AT = Ta + 0.33·e − 0.70·ws − 4.00, e = water vapour pressure (hPa).
 */
export function apparentC(ta: number, rh: number, ws: number): number {
  const e = (rh / 100) * 6.105 * Math.exp((17.27 * ta) / (237.7 + ta));
  return Math.round((ta + 0.33 * e - 0.7 * ws - 4) * 10) / 10;
}

/** Same shape as the Open-Meteo hourly block WeatherService reads. */
export interface KmaHourly {
  time: string[];
  temperature_2m: number[];
  apparent_temperature: number[];
  precipitation_probability: number[];
  precipitation: number[];
  weather_code: number[];
}

interface Item {
  category: string;
  fcstDate: string;
  fcstTime: string;
  fcstValue: string;
}

/** KMA items → hourly arrays ("2026-10-17T14:00" …). PTY snow (3 rain/snow showers 7) → a snow weather code. */
export function kmaToHourly(items: Item[]): KmaHourly {
  const byHour = new Map<string, Record<string, string>>();
  for (const it of items) {
    const key = `${it.fcstDate.slice(0, 4)}-${it.fcstDate.slice(4, 6)}-${it.fcstDate.slice(6, 8)}T${it.fcstTime.slice(0, 2)}:00`;
    const row = byHour.get(key) ?? {};
    row[it.category] = it.fcstValue;
    byHour.set(key, row);
  }
  const out: KmaHourly = { time: [], temperature_2m: [], apparent_temperature: [], precipitation_probability: [], precipitation: [], weather_code: [] };
  for (const [time, r] of [...byHour.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (r.TMP === undefined) continue;
    const ta = Number(r.TMP);
    out.time.push(time);
    out.temperature_2m.push(ta);
    out.apparent_temperature.push(apparentC(ta, Number(r.REH ?? 60), Number(r.WSD ?? 1)));
    out.precipitation_probability.push(Number(r.POP ?? 0));
    out.precipitation.push(kmaRain(r.PCP ?? '') + kmaRain(r.SNO ?? ''));
    const pty = Number(r.PTY ?? 0);
    out.weather_code.push(pty === 3 || pty === 7 ? 71 : pty === 2 || pty === 6 ? 85 : pty ? 61 : 0);
  }
  return out;
}

/** The forecast for a point, or null (no key, not approved, network). */
export async function kmaHourly(serviceKey: string, lat: number, lng: number): Promise<KmaHourly | null> {
  const { nx, ny } = kmaGrid(lat, lng);
  const base = kmaBase();
  // The key from data.go.kr is already URL-encoded ("Encoding" key) or not ("Decoding"); pass it through as is.
  const q = `serviceKey=${serviceKey.includes('%') ? serviceKey : encodeURIComponent(serviceKey)}&pageNo=1&numOfRows=1000&dataType=JSON&base_date=${base.date}&base_time=${base.time}&nx=${nx}&ny=${ny}`;
  const res = await fetch(`${URL}?${q}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { response?: { header?: { resultCode?: string }; body?: { items?: { item?: Item[] } } } } | null;
  const items = body?.response?.body?.items?.item;
  if (body?.response?.header?.resultCode !== '00' || !items?.length) return null;
  return kmaToHourly(items);
}
