from fastapi.testclient import TestClient

from app.catalog import load_catalog
from app.main import app

client = TestClient(app)


def test_health_reports_catalog_version():
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["catalogVersion"] == load_catalog().version


def test_catalog_defaults_are_valid_options():
    catalog = load_catalog()
    assert catalog.defaults.stopCount in catalog.stopCountOptions
    assert catalog.defaults.timeBudgetMin in catalog.timeBudgetOptionsMin
    assert catalog.defaults.budget in {b.id for b in catalog.budgets}
    assert len(catalog.style_ids) == len(catalog.styles), "style ids must be unique"
