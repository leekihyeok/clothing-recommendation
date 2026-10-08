"""Loads packages/shared/catalog.json, the style/item list shared with the TypeScript side."""

import json
from functools import lru_cache

from pydantic import BaseModel

from app.settings import REPO_ROOT

CATALOG_PATH = REPO_ROOT / "packages" / "shared" / "catalog.json"


class Option(BaseModel):
    id: str
    label: str


class Defaults(BaseModel):
    stopCount: int
    timeBudgetMin: int
    travelMode: str
    budget: str


class Catalog(BaseModel):
    version: int
    styles: list[Option]
    items: list[Option]
    budgets: list[Option]
    stopCountOptions: list[int]
    timeBudgetOptionsMin: list[int]
    defaults: Defaults

    @property
    def style_ids(self) -> set[str]:
        return {s.id for s in self.styles}


@lru_cache
def load_catalog() -> Catalog:
    return Catalog.model_validate(json.loads(CATALOG_PATH.read_text(encoding="utf-8")))
