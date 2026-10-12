"""The AI client keeps the bigger models for people and stops asking a model whose daily quota is gone."""

import time
from types import SimpleNamespace

import pytest

from ai import client
from ai.client import AIError


def test_retry_after_reads_gemini_wait():
    assert client._retry_after_s("Please retry in 16h28m58.8s.") == pytest.approx(16 * 3600 + 28 * 60 + 58.8)
    assert client._retry_after_s("Please retry in 41.2s.") == pytest.approx(41.2)
    assert client._retry_after_s("high demand") == 0


@pytest.fixture
def fake_gemini(monkeypatch):
    """A Gemini that answers 429 'retry in 16h' for every model, recording what was asked."""
    from google.genai import errors

    asked: list[str] = []

    class Err(errors.APIError):
        def __init__(self, code, message):
            Exception.__init__(self, message)
            self.code, self.message = code, message

    def generate_content(model, contents, config):
        asked.append(model)
        raise Err(429, "Quota exceeded. Please retry in 16h28m58s.")

    monkeypatch.setattr(client, "_gemini", lambda: SimpleNamespace(models=SimpleNamespace(generate_content=generate_content)))
    monkeypatch.setattr(client, "_cooldown", {})
    monkeypatch.setattr(client._pacer, "wait", lambda: None)
    monkeypatch.setattr(client, "_log", lambda *a, **k: None)  # no rows in the real llm_calls
    return asked


def test_batch_never_uses_reserved_models(fake_gemini):
    with pytest.raises(AIError):
        client._generate_gemini("t", "x", dict, None, "smart", None, None, paced=True)
    assert fake_gemini and not set(fake_gemini) & client.LIVE_RESERVE


def test_daily_quota_model_is_skipped_until_reset(fake_gemini):
    with pytest.raises(AIError, match="daily quota used up"):
        client._generate_gemini("t", "x", dict, None, "fast", None, None, paced=False)
    first = list(fake_gemini)
    # Each model asked once, not again and again for the whole deadline.
    assert len(first) == len(set(first))
    fake_gemini.clear()
    started = time.monotonic()
    with pytest.raises(AIError, match="daily quota used up"):
        client._generate_gemini("t", "x", dict, None, "fast", None, None, paced=False)
    assert fake_gemini == [] and time.monotonic() - started < 1
