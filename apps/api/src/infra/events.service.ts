import { Injectable, Logger } from '@nestjs/common';
import { DbService } from './db.service';

export type EventKind = 'plan' | 'parse_text' | 'parse_photo' | 'edit' | 'edit_text' | 'share' | 'share_open' | 'reopen' | 'login' | 'walk';

interface EventFields {
  userId?: string | null;
  courseId?: string | null;
  ms?: number;
  ok?: boolean;
  data?: Record<string, unknown>;
}

/**
 * Usage log for the admin numbers (PLAN.md 13): one row per API action. Writes never block or fail the request.
 * Nothing the user typed is stored, only sizes and outcomes.
 */
@Injectable()
export class EventsService {
  private readonly log = new Logger(EventsService.name);

  constructor(private readonly db: DbService) {}

  record(kind: EventKind, e: EventFields): void {
    this.db.pool
      .query('INSERT INTO app_events (kind, user_id, course_id, ms, ok, data) VALUES ($1, $2, $3, $4, $5, $6)', [
        kind, e.userId ?? null, e.courseId ?? null, e.ms ?? null, e.ok ?? true, JSON.stringify(e.data ?? {}),
      ])
      .catch((err: Error) => this.log.warn(`event ${kind} not recorded: ${err.message}`));
  }

  /** Runs `fn`, timing it; records success (with `after` fields from the result) or failure, and passes it through. */
  async timed<T>(kind: EventKind, base: EventFields, fn: () => Promise<T>, after?: (r: T) => EventFields): Promise<T> {
    const t0 = Date.now();
    try {
      const r = await fn();
      const extra = after?.(r) ?? {};
      this.record(kind, { ...base, ...extra, data: { ...base.data, ...extra.data }, ms: Date.now() - t0 });
      return r;
    } catch (err) {
      this.record(kind, { ...base, ok: false, ms: Date.now() - t0, data: { ...base.data, error: String((err as Error)?.message ?? err).slice(0, 200) } });
      throw err;
    }
  }
}
