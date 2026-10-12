"""Shared AI client. Every model call in the service goes through `generate()`.

The caller passes a prompt and a Pydantic output schema and gets back a validated object. Which provider answers is
chosen by AI_PROVIDER in .env (only 'gemini' is implemented yet; the Claude adapter slots in behind the same function).
Each call is logged to llm_calls so the cost of switching providers can be estimated from real token counts.
"""

import re
import threading
import time
from typing import Literal, TypeVar

import psycopg
from pydantic import BaseModel

from app.settings import settings

T = TypeVar("T", bound=BaseModel)
Tier = Literal["fast", "smart", "check"]

# fast: bulk, simple judgements (classification). smart: harder judgements, few calls.
# Each tier lists fallbacks: the free tier often answers 503 "high demand" for one model while another is fine.
GEMINI_MODELS: dict[Tier, list[str]] = {
    "fast": ["gemini-flash-lite-latest", "gemini-3.1-flash-lite"],
    "smart": ["gemini-flash-latest", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-flash-lite-latest"],
    # A second opinion on "fast" output: a different light model, so the checker isn't the writer. The bigger Flash
    # models answered verify calls with 503 almost every time on the free tier (2026-10-07).
    "check": ["gemini-3.1-flash-lite", "gemini-flash-lite-latest"],
}
_unavailable: set[str] = set()  # models that answered 404 (retired for this key) — skipped for the rest of the process
# Lower thinking keeps latency sane for classification-style prompts (a "smart" call took 200s+ at the default).
THINKING: dict[Tier, str] = {"fast": "MINIMAL", "smart": "LOW", "check": "LOW"}

# Free-tier quotas are per minute; keep a gap between calls instead of bursting into 429s.
MIN_INTERVAL_S = 4.5
MAX_ATTEMPTS = 5

# Free-tier quotas are also per model per day (about 500 for the light models, 2026-10-08), shared by the batch
# pipeline and people using the app. Batch calls stop at AI_BATCH_DAILY_CAP per model so the rest stays for people;
# the day resets at midnight Pacific time, like the quota.
QUOTA_DAY_TZ = "America/Los_Angeles"

# User-facing calls: never sit in long back-offs. Try every model of the tier, then the bigger models (their quota is
# separate and mostly unused), and give up within this many seconds.
LIVE_DEADLINE_S = 20
LIVE_FALLBACK = ["gemini-flash-latest", "gemini-3.7-flash", "gemini-3.5-flash"]
# Those bigger models allow only ~20 calls a day each on the free tier (2026-10-12), so they are kept for people:
# batch (paced) calls never use them, whatever tier they ask for.
LIVE_RESERVE = set(LIVE_FALLBACK)

# A 429 that says "Please retry in 16h28m…" is a used-up daily quota, not a per-minute burst: that model is skipped
# until then instead of being asked again and again. Shorter waits are left to the normal back-off.
COOLDOWN_MIN_S = 5 * 60
_cooldown: dict[str, float] = {}  # model → time.monotonic() when it may be tried again
_RETRY_IN = re.compile(r"retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?", re.I)


def _retry_after_s(message: str | None) -> float:
    m = _RETRY_IN.search(message or "")
    if not m or not any(m.groups()):
        return 0.0
    h, mi, se = m.groups()
    return int(h or 0) * 3600 + int(mi or 0) * 60 + float(se or 0)


def _cooling(model: str) -> bool:
    until = _cooldown.get(model)
    return until is not None and time.monotonic() < until


class AIError(RuntimeError):
    pass


class _Pacer:
    def __init__(self, interval: float):
        self.interval = interval
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            if now < self.next_at:
                time.sleep(self.next_at - now)
            self.next_at = time.monotonic() + self.interval


_pacer = _Pacer(MIN_INTERVAL_S)
_gemini_client = None


def _gemini():
    global _gemini_client
    if _gemini_client is None:
        from google import genai

        if not settings.gemini_api_key:
            raise AIError("GEMINI_API_KEY is not set (.env)")
        _gemini_client = genai.Client(api_key=settings.gemini_api_key)
    return _gemini_client


def generate(
    *,
    purpose: str,
    prompt: str | list,  # a list mixes text and images (Gemini Part objects)
    schema: type[T],
    system: str | None = None,
    tier: Tier = "fast",
    conn: psycopg.Connection | None = None,
    run_id: int | None = None,
    paced: bool = True,
) -> T:
    """paced=False for user-facing calls: batch jobs keep a gap between calls for the free-tier per-minute quota,
    but a person typing a request shouldn't queue behind them."""
    if settings.ai_provider != "gemini":
        raise AIError(f"AI_PROVIDER={settings.ai_provider!r} is not implemented yet")
    return _generate_gemini(purpose, prompt, schema, system, tier, conn, run_id, paced)


def batch_used_today(conn, model: str) -> int:
    """Successful batch (pipeline) calls to `model` since the quota day began."""
    return conn.execute(
        """SELECT count(*) FROM llm_calls
           WHERE ok AND run_id IS NOT NULL AND requested_model = %s
             AND created_at >= date_trunc('day', now() AT TIME ZONE %s) AT TIME ZONE %s""",
        (model, QUOTA_DAY_TZ, QUOTA_DAY_TZ),
    ).fetchone()[0]


def _generate_gemini(purpose, prompt, schema, system, tier, conn, run_id, paced=True):
    from google.genai import errors, types

    models = [m for m in GEMINI_MODELS[tier] if m not in _unavailable and not _cooling(m)]
    if paced:
        models = [m for m in models if m not in LIVE_RESERVE]
    if paced and conn is not None:
        models = [m for m in models if batch_used_today(conn, m) < settings.ai_batch_daily_cap]
        if not models:
            raise AIError(f"daily batch budget ({settings.ai_batch_daily_cap}/model) used for tier {tier!r}; the rest is kept for users until midnight Pacific")
    if not paced:
        models += [m for m in LIVE_FALLBACK if m not in models and m not in _unavailable and not _cooling(m)]
    if not models:
        raise AIError(f"no available Gemini model for tier {tier!r} (daily quota used up until midnight Pacific)")
    deadline = time.monotonic() + LIVE_DEADLINE_S
    config = types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json",
        response_schema=schema,
        temperature=0,
        thinking_config=types.ThinkingConfig(thinking_level=THINKING[tier]),
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )
    config_no_thinking_level = config.model_copy(update={"thinking_config": None})
    last_error: Exception | None = None
    model_idx = 0
    for attempt in range(MAX_ATTEMPTS * len(models)):
        if not paced and time.monotonic() > deadline:
            break
        model = models[model_idx % len(models)]
        if paced:
            _pacer.wait()
        started = time.monotonic()
        try:
            res = _gemini().models.generate_content(model=model, contents=prompt, config=config)
        except errors.APIError as e:
            latency = int((time.monotonic() - started) * 1000)
            _log(conn, run_id, purpose, model, None, latency, ok=False, error=f"{e.code} {e.message}", requested=model)
            last_error = e
            if e.code == 400 and "thinking" in (e.message or "").lower() and config.thinking_config is not None:
                config = config_no_thinking_level  # older models reject thinking_level; retry without it
                continue
            if e.code == 404 and len(models) > 1:
                _unavailable.add(model)
                models = [m for m in models if m != model]
                continue
            if e.code == 429 and _retry_after_s(e.message) >= COOLDOWN_MIN_S:
                # This model's daily quota is gone: drop it for this call and for later ones until it resets.
                _cooldown[model] = time.monotonic() + _retry_after_s(e.message)
                models = [m for m in models if m != model]
                if not models:
                    raise AIError(f"every {tier!r} model's daily quota used up until midnight Pacific: {e.message!s:.160}") from e
                continue
            if e.code in (429, 503) or (e.code or 0) >= 500:
                model_idx += 1  # this model is overloaded or out of quota: try the next one, backing off per round
                if model_idx % len(models) == 0:
                    # A person is waiting: a short pause only, the deadline above ends it.
                    time.sleep(2 if not paced else min(60, 10 * 2 ** (model_idx // len(models))))
                continue
            raise AIError(f"Gemini {e.code}: {e.message}") from e
        latency = int((time.monotonic() - started) * 1000)
        parsed = res.parsed
        if isinstance(parsed, schema):
            _log(conn, run_id, purpose, res.model_version or model, res.usage_metadata, latency, ok=True, requested=model)
            return parsed
        last_error = AIError(f"unparseable response: {(res.text or '')[:200]}")
        _log(conn, run_id, purpose, res.model_version or model, res.usage_metadata, latency, ok=False, error=str(last_error), requested=model)
    raise AIError(f"gave up after {attempt + 1} attempts: {last_error}")


def _log(conn, run_id, purpose, model, usage, latency_ms, *, ok: bool, error: str | None = None, requested: str | None = None) -> None:
    if conn is None:
        # A call from the app (a person waiting): logged on its own short connection, so the status can show how
        # much of each model's daily quota people used. A logging failure never fails their request.
        try:
            with psycopg.connect(settings.database_url, connect_timeout=3) as own:
                _log(own, run_id, purpose, model, usage, latency_ms, ok=ok, error=error, requested=requested)
        except Exception:
            pass
        return
    input_tokens = output_tokens = cached = None
    if usage is not None:
        input_tokens = usage.prompt_token_count
        output_tokens = (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0)
        cached = usage.cached_content_token_count
    conn.execute(
        """INSERT INTO llm_calls (run_id, purpose, provider, model, input_tokens, output_tokens, cached_tokens,
                                  cost_usd, latency_ms, ok, error, requested_model)
           VALUES (%s, %s, 'gemini', %s, %s, %s, %s, 0, %s, %s, %s, %s)""",
        (run_id, purpose, model, input_tokens, output_tokens, cached, latency_ms, ok, error, requested),
    )
    conn.commit()
