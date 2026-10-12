import { Injectable, Logger } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { RedisService } from './redis.service';

/** The request bits a limit is counted by. */
export type LimitRequest = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
};

export const TOO_MANY = '요청이 너무 많아요. 잠시 뒤 다시 해 주세요';

/** One limit: at most `max` calls per `windowSec`, counted per person (user / browser) or per IP address. */
interface Rule {
  per: 'id' | 'ip';
  max: number;
  windowSec: number;
}

/**
 * How often each kind of call may be made. AI calls share one bucket (text, photo, chat edits): the free daily
 * Gemini quota is shared by everyone, so one script mustn't drain it; the rest guard Kakao / T map / ODsay quota and
 * spam. Generous for a person using the app, tight for a loop.
 */
export const LIMITS: Record<string, Rule[]> = {
  ai: [{ per: 'id', max: 20, windowSec: 600 }, { per: 'ip', max: 60, windowSec: 600 }],
  plan: [{ per: 'id', max: 40, windowSec: 600 }, { per: 'ip', max: 150, windowSec: 600 }],
  edit: [{ per: 'id', max: 150, windowSec: 600 }, { per: 'ip', max: 400, windowSec: 600 }],
  transit: [{ per: 'id', max: 60, windowSec: 600 }, { per: 'ip', max: 200, windowSec: 600 }],
  group: [{ per: 'id', max: 10, windowSec: 3600 }, { per: 'ip', max: 30, windowSec: 3600 }],
  claim: [{ per: 'id', max: 5, windowSec: 86400 }, { per: 'ip', max: 10, windowSec: 86400 }],
  review: [{ per: 'id', max: 30, windowSec: 86400 }],
  record: [{ per: 'id', max: 400, windowSec: 3600 }, { per: 'ip', max: 1500, windowSec: 3600 }],
};

/**
 * Per-person and per-IP call limits in Redis (a counter per window). If Redis is down the call goes through: the
 * limits protect quotas, they aren't worth breaking the app for.
 */
@Injectable()
export class RateLimitService {
  private readonly log = new Logger(RateLimitService.name);

  constructor(private readonly redis: RedisService) {}

  /** The caller's address: behind a reverse proxy (TRUST_PROXY=1) its first forwarded hop, else the socket's. */
  private ip(req: LimitRequest | undefined): string {
    if (process.env.TRUST_PROXY === '1') {
      const fwd = req?.headers?.['x-forwarded-for'];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req?.socket?.remoteAddress ?? 'unknown';
  }

  /**
   * Counts one call of `kind` for this person (`id`: user id, else the browser's anonymous key, else the IP) and
   * address; throws TOO_MANY_REQUESTS "요청이 너무 많아요" when a limit is passed.
   */
  async hit(kind: keyof typeof LIMITS, req: LimitRequest | undefined, id: string | null): Promise<void> {
    const ip = this.ip(req);
    const anon = req?.headers?.['x-route-anon'];
    const who = id ?? (typeof anon === 'string' && anon ? `anon:${anon}` : `ip:${ip}`);
    try {
      if (this.redis.client.status === 'wait') await this.redis.client.connect();
      for (const rule of LIMITS[kind]) {
        const bucket = Math.floor(Date.now() / 1000 / rule.windowSec);
        const key = `rl:${kind}:${rule.per}:${rule.per === 'id' ? who : ip}:${bucket}`;
        const n = await this.redis.client.incr(key);
        if (n === 1) await this.redis.client.expire(key, rule.windowSec);
        if (n > rule.max) {
          this.log.warn(`rate limit ${kind}/${rule.per} for ${rule.per === 'id' ? who : ip}`);
          throw new GraphQLError(TOO_MANY, { extensions: { code: 'TOO_MANY_REQUESTS', http: { status: 429 } } });
        }
      }
    } catch (e) {
      if (e instanceof GraphQLError) throw e;
      // Redis unavailable: let it through.
    }
  }
}
