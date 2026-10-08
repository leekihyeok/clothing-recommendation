import itertools
import random

from fastapi.testclient import TestClient

from app.main import app
from app.optimize import Candidate, LatLng, OptimizeRequest, Problem, optimize, solve, street_m

ORIGIN = LatLng(lat=37.5446, lng=127.0560)  # 성수역


def cand(i: int, dlat: float, dlng: float, value: float, dwell: float = 15) -> Candidate:
    return Candidate(id=str(i), lat=ORIGIN.lat + dlat, lng=ORIGIN.lng + dlng, value=value, dwell_min=dwell)


def problem(req: OptimizeRequest, km_weight: float) -> Problem:
    pts = [(req.origin.lat, req.origin.lng)] + [(c.lat, c.lng) for c in req.candidates]
    return Problem(
        dist=[[street_m(a, b) for b in pts] for a in pts],
        value=[0.0] + [c.value for c in req.candidates],
        dwell=[0.0] + [c.dwell_min for c in req.candidates],
        stop_count=req.stop_count,
        budget=req.time_budget_min,
        km_weight=km_weight,
    )


def brute_force(p: Problem) -> float:
    n = len(p.value) - 1
    best = 0.0
    for k in range(1, p.stop_count + 1):
        for combo in itertools.permutations(range(1, n + 1), k):
            if p.feasible(list(combo)):
                best = max(best, p.objective(list(combo)))
    return best


def test_matches_brute_force_on_small_random_cases():
    rng = random.Random(7)
    for _ in range(25):
        cands = [cand(i, rng.uniform(-0.006, 0.006), rng.uniform(-0.008, 0.008), rng.random()) for i in range(8)]
        req = OptimizeRequest(origin=ORIGIN, candidates=cands, stop_count=3, time_budget_min=rng.choice([60, 90, 120]))
        p = problem(req, 0.25)
        route = solve(p)
        assert p.feasible(route)
        assert p.objective(route) >= brute_force(p) - 1e-6


def test_respects_time_budget_and_says_so():
    # Four great shops 1.5 km away in different directions; one hour can't fit them all.
    cands = [cand(i, d[0], d[1], 0.9) for i, d in enumerate([(0.013, 0), (-0.013, 0), (0, 0.017), (0, -0.017)])]
    res = optimize(OptimizeRequest(origin=ORIGIN, candidates=cands, stop_count=4, time_budget_min=60))
    main = res.courses[0]
    assert main.total_min <= 60
    assert len(main.stop_ids) < 4 and main.note


def test_order_follows_the_street_not_the_value():
    # Three shops in a line east of the origin: visit them near → far.
    cands = [cand(i, 0, 0.002 * (i + 1), v) for i, v in enumerate([0.5, 0.9, 0.7])]
    res = optimize(OptimizeRequest(origin=ORIGIN, candidates=cands, stop_count=3, time_budget_min=120))
    assert res.courses[0].stop_ids == ["0", "1", "2"]


def test_nearby_variant_walks_less_than_taste():
    rng = random.Random(3)
    cands = [cand(i, rng.uniform(-0.01, 0.01), rng.uniform(-0.012, 0.012), rng.random()) for i in range(30)]
    res = optimize(OptimizeRequest(origin=ORIGIN, candidates=cands, stop_count=5, time_budget_min=240))
    by = {c.variant: c for c in res.courses}
    assert "recommended" in by
    if "nearby" in by and "taste" in by:
        assert by["nearby"].total_distance_m <= by["taste"].total_distance_m
        assert by["taste"].value >= by["nearby"].value


def test_endpoint():
    client = TestClient(app)
    body = {
        "origin": ORIGIN.model_dump(),
        "candidates": [c.model_dump() for c in [cand(1, 0.001, 0.001, 0.8), cand(2, -0.001, 0.002, 0.6)]],
        "stop_count": 2,
        "time_budget_min": 60,
    }
    res = client.post("/optimize", json=body)
    assert res.status_code == 200
    assert set(res.json()["courses"][0]["stop_ids"]) == {"1", "2"}


def test_exact_count_fills_the_asked_number():
    # Ten weak shops spread out: left alone the optimiser stops early because walking costs more than they add.
    cands = [cand(i, 0.0015 * i, 0.002 * (i % 3), 0.05) for i in range(1, 11)]
    loose = optimize(OptimizeRequest(origin=ORIGIN, candidates=cands, stop_count=8, time_budget_min=720))
    exact = optimize(OptimizeRequest(origin=ORIGIN, candidates=cands, stop_count=8, time_budget_min=720, exact_count=True))
    assert len(loose.courses[0].stop_ids) < 8
    assert all(len(c.stop_ids) == 8 for c in exact.courses)


def test_must_shop_is_kept_even_if_far():
    from app.optimize import Candidate, LatLng, OptimizeRequest, optimize

    near = [Candidate(id=f"n{i}", lat=37.5445 + i * 0.0005, lng=127.056, value=0.9) for i in range(6)]
    far = Candidate(id="far", lat=37.552, lng=127.064, value=0.2, must=True)
    res = optimize(OptimizeRequest(origin=LatLng(lat=37.5445, lng=127.056), candidates=near + [far], stop_count=4, time_budget_min=240))
    assert all("far" in c.stop_ids for c in res.courses)
    assert res.courses[0].value < 4  # reported value is the real one, not the bonus
