from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    database_url: str = ""
    ai_provider: str = "gemini"
    gemini_api_key: str = ""
    # Batch (pipeline) calls per model per day; the rest of the free quota (~500) is kept for people using the app.
    ai_batch_daily_cap: int = 420
    anthropic_api_key: str = ""
    kakao_rest_api_key: str = ""
    naver_search_client_id: str = ""
    naver_search_client_secret: str = ""


settings = Settings()
