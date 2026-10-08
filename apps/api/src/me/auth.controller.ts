import { randomBytes } from 'node:crypto';
import { Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
import { EventsService } from '../infra/events.service';
import { AuthService, SESSION_COOKIE, SESSION_DAYS } from './auth.service';
import { cookie, isAnonKey, type Request } from './me.service';

/** The parts of the Express response used here (no @types/express in this workspace). */
interface Response {
  cookie(name: string, value: string, options: CookieOptions): void;
  clearCookie(name: string, options: CookieOptions): void;
  redirect(url: string): void;
  status(code: number): { send(body: string): void };
}
type CookieOptions = { httpOnly?: boolean; sameSite?: 'lax'; secure?: boolean; maxAge?: number; path?: string };

const STATE_COOKIE = 'route_oauth';
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/** Only same-site paths: "/?c=…" yes, "//evil.com" or "https://…" no. */
function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

function withParam(path: string, key: string, value: string): string {
  const url = new URL(path, 'http://x');
  url.searchParams.set(key, value);
  return url.pathname + url.search;
}

/**
 * Kakao login, server side. /auth is proxied by Vite in development, so the cookies are first-party for the page.
 *   GET /auth/kakao/login?anon=<browser id>&next=<path>  → Kakao's consent screen
 *   GET /auth/kakao/callback?code&state                   → session cookie, back to `next` with ?login=ok|cancel|fail
 *   GET /auth/logout?next=<path>                         → back to `next` with ?login=out
 */
@Controller('auth')
export class AuthController {
  private readonly log = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly events: EventsService,
  ) {}

  private opts(maxAge?: number): CookieOptions {
    return { httpOnly: true, sameSite: 'lax', secure: this.auth.redirectUri.startsWith('https:'), path: '/', maxAge };
  }

  @Get('kakao/login')
  login(@Query('anon') anon: string | undefined, @Query('next') next: string | undefined, @Res() res: Response) {
    if (!this.auth.enabled) return res.status(503).send('카카오 로그인이 설정되지 않았어요 (KAKAO_REST_API_KEY)');
    const state = randomBytes(16).toString('hex');
    const payload = { state, anon: anon && isAnonKey(anon) ? anon.toLowerCase() : null, next: safeNext(next) };
    res.cookie(STATE_COOKIE, JSON.stringify(payload), this.opts(STATE_MAX_AGE_MS));
    res.redirect(this.auth.authorizeUrl(state));
  }

  @Get('kakao/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    let saved: { state?: string; anon?: string | null; next?: string } = {};
    try {
      saved = JSON.parse(cookie(req, STATE_COOKIE) ?? '{}');
    } catch {
      // a mangled cookie is the same as none
    }
    res.clearCookie(STATE_COOKIE, this.opts());
    const next = safeNext(saved.next);
    if (error) return res.redirect(withParam(next, 'login', error === 'access_denied' ? 'cancel' : 'fail'));
    if (!code || !state || state !== saved.state) {
      this.log.warn('kakao callback: missing code or state mismatch');
      return res.redirect(withParam(next, 'login', 'fail'));
    }
    try {
      const userId = await this.auth.login(code, saved.anon ?? null);
      this.events.record('login', { userId, data: { withBrowserRecords: !!saved.anon } });
      const old = cookie(req, SESSION_COOKIE);
      if (old) await this.auth.endSession(old);
      res.cookie(SESSION_COOKIE, await this.auth.startSession(userId), this.opts(SESSION_DAYS * 24 * 3600 * 1000));
      res.redirect(withParam(next, 'login', 'ok'));
    } catch (e) {
      this.log.error(`kakao login failed: ${e instanceof Error ? e.message : e}`);
      res.redirect(withParam(next, 'login', 'fail'));
    }
  }

  @Get('logout')
  async logout(@Query('next') next: string | undefined, @Req() req: Request, @Res() res: Response) {
    const token = cookie(req, SESSION_COOKIE);
    if (token) await this.auth.endSession(token);
    res.clearCookie(SESSION_COOKIE, this.opts());
    res.redirect(withParam(safeNext(next), 'login', 'out'));
  }
}
