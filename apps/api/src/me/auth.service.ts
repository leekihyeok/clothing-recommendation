import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../infra/db.service';

export const SESSION_COOKIE = 'route_session';
export const SESSION_DAYS = 60;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

interface KakaoProfile {
  id: number;
  nickname: string | null;
}

/**
 * Kakao login (REST, server side): authorization code → access token → profile → our user row, then a session.
 * The access token is only used once to read the profile and isn't kept.
 */
@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  get enabled(): boolean {
    return !!this.config.get<string>('KAKAO_REST_API_KEY');
  }

  get redirectUri(): string {
    return this.config.get<string>('KAKAO_REDIRECT_URI') ?? 'http://localhost:5180/auth/kakao/callback';
  }

  authorizeUrl(state: string): string {
    const q = new URLSearchParams({
      client_id: this.config.get<string>('KAKAO_REST_API_KEY')!,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      state,
    });
    return `https://kauth.kakao.com/oauth/authorize?${q}`;
  }

  /** Code from the callback → the user id, with this browser's anonymous records moved onto the account. */
  async login(code: string, anonKey: string | null): Promise<string> {
    const profile = await this.profile(await this.token(code));
    return this.attach(profile, anonKey);
  }

  async startSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.pool.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
      [hash(token), userId, SESSION_DAYS],
    );
    return token;
  }

  async sessionUser(token: string): Promise<string | null> {
    const r = await this.db.pool.query<{ user_id: string }>(
      'SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()',
      [hash(token)],
    );
    return r.rows[0]?.user_id ?? null;
  }

  async endSession(token: string): Promise<void> {
    await this.db.pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash(token)]);
  }

  private async token(code: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.get<string>('KAKAO_REST_API_KEY')!,
      redirect_uri: this.redirectUri,
      code,
    });
    const secret = this.config.get<string>('KAKAO_CLIENT_SECRET');
    if (secret) body.set('client_secret', secret);
    const res = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; error_code?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      // KOE010: the app has a client secret switched on but KAKAO_CLIENT_SECRET isn't set (or is wrong).
      throw new Error(`kakao token ${res.status} ${json.error_code ?? ''} ${json.error_description ?? ''}`.trim());
    }
    return json.access_token;
  }

  private async profile(accessToken: string): Promise<KakaoProfile> {
    const res = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`kakao profile ${res.status}`);
    const json = (await res.json()) as {
      id: number;
      properties?: { nickname?: string };
      kakao_account?: { profile?: { nickname?: string } };
    };
    return { id: json.id, nickname: json.kakao_account?.profile?.nickname ?? json.properties?.nickname ?? null };
  }

  /**
   * The account's user row. A first login turns this browser's anonymous row into the account; a later login (another
   * device, or after logging out) moves that browser's anonymous records onto the existing account.
   * The account row never keeps an anon key, so logging out leaves the browser anonymous and empty.
   */
  private async attach(p: KakaoProfile, anonKey: string | null): Promise<string> {
    const client = await this.db.pool.connect();
    try {
      await client.query('BEGIN');
      const account = (await client.query<{ id: string }>('SELECT id FROM users WHERE kakao_id = $1 FOR UPDATE', [p.id])).rows[0];
      const anon = anonKey
        ? (await client.query<{ id: string }>(`SELECT id FROM users WHERE anon_key = $1 AND kind = 'anon' FOR UPDATE`, [anonKey])).rows[0]
        : undefined;
      let userId: string;
      if (account) {
        userId = account.id;
        if (anon) {
          await client.query('UPDATE user_shop_events SET user_id = $1 WHERE user_id = $2', [userId, anon.id]);
          await client.query('UPDATE courses SET user_id = $1 WHERE user_id = $2', [userId, anon.id]);
          await client.query('DELETE FROM users WHERE id = $1', [anon.id]);
        }
        // A nickname the person changed on my page stays; otherwise follow Kakao's.
        await client.query(
          'UPDATE users SET nickname = CASE WHEN nickname_custom THEN nickname ELSE coalesce($2, nickname) END, last_seen_at = now() WHERE id = $1',
          [userId, p.nickname],
        );
      } else if (anon) {
        userId = anon.id;
        await client.query(
          `UPDATE users SET kind = 'kakao', kakao_id = $2, nickname = $3, anon_key = NULL, last_seen_at = now() WHERE id = $1`,
          [userId, p.id, p.nickname],
        );
      } else {
        userId = (
          await client.query<{ id: string }>(`INSERT INTO users (kind, kakao_id, nickname) VALUES ('kakao', $1, $2) RETURNING id`, [p.id, p.nickname])
        ).rows[0].id;
      }
      await client.query('COMMIT');
      this.log.log(`kakao login: user ${userId}${anon ? ' (anonymous records merged)' : ''}`);
      return userId;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
