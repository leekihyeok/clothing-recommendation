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


def test_end_point_pulls_the_course_towards_it():
    # Shops on both sides of the start; finishing to the north should pick the northern ones and end near the end point.
    north = [cand(i, 0.002 * i, 0.0, 0.5) for i in range(1, 4)]
    south = [cand(10 + i, -0.002 * i, 0.0, 0.5) for i in range(1, 4)]
    end = LatLng(lat=ORIGIN.lat + 0.008, lng=ORIGIN.lng)
    res = optimize(OptimizeRequest(origin=ORIGIN, candidates=north + south, stop_count=3, time_budget_min=180, end=end))
    best = res.courses[0]
    assert set(best.stop_ids) == {"1", "2", "3"}
    assert best.end_leg is not None
    # The walk to the end point is part of the course's distance (legs are rounded one by one).
    assert abs(best.total_distance_m - (sum(l.distance_m for l in best.legs) + best.end_leg.distance_m)) <= 2


def test_end_leg_counts_against_the_time_budget():
    # One shop next to the start, the end point a long walk away: without the end the shop fits easily, with it nothing fits.
    shop = [cand(1, 0.0005, 0.0, 0.9)]
    far_end = LatLng(lat=ORIGIN.lat + 0.03, lng=ORIGIN.lng)  # ~4.3 km by street ≈ 62 min
    assert optimize(OptimizeRequest(origin=ORIGIN, candidates=shop, stop_count=1, time_budget_min=40)).courses[0].stop_ids == ["1"]
    assert optimize(OptimizeRequest(origin=ORIGIN, candidates=shop, stop_count=1, time_budget_min=40, end=far_end)).courses[0].stop_ids == []


def test_closed_shops_are_skipped_and_order_follows_opening():
    # A: right next to the start but opens in 2 hours (too long to wait). B, C: open now.
    a = cand(1, 0.0003, 0.0, 0.9).model_copy(update={"open_from": 120})
    b = cand(2, 0.001, 0.0, 0.5)
    c = cand(3, 0.002, 0.0, 0.5)
    best = optimize(OptimizeRequest(origin=ORIGIN, candidates=[a, b, c], stop_count=3, time_budget_min=90)).courses[0]
    assert "1" not in best.stop_ids

    # D closes 30 minutes from now (about 6 min away, 15 min to browse): it has to come first even though E is nearer.
    d = cand(4, 0.003, 0.0, 0.6).model_copy(update={"open_until": 30})
    e = cand(5, 0.0008, 0.0, 0.6)
    best = optimize(OptimizeRequest(origin=ORIGIN, candidates=[d, e], stop_count=2, time_budget_min=120, exact_count=True)).courses[0]
    assert best.stop_ids == ["4", "5"]


def test_short_wait_for_opening_is_allowed_and_counted():
    # Opens 20 minutes after the start, 3 minutes' walk away: the course waits and the total time shows it.
    shop = cand(1, 0.0015, 0.0, 0.9).model_copy(update={"open_from": 20})
    best = optimize(OptimizeRequest(origin=ORIGIN, candidates=[shop], stop_count=1, time_budget_min=60)).courses[0]
    assert best.stop_ids == ["1"]
    assert best.total_min == 35.0  # waits until minute 20, then 15 minutes inside


def test_rainy_nearby_course_is_not_empty():
    # Low-value shops a few hundred metres apart: with rain (distance_scale 2.5) the "nearby" weighting makes every
    # route's walk outweigh its shops, but a course is still better than none.
    cands = [cand(i, 0.004 * i, 0.003 * i, 0.15) for i in range(1, 6)]
    req = OptimizeRequest(origin=ORIGIN, candidates=cands, stop_count=3, time_budget_min=240, distance_scale=2.5)
    courses = optimize(req).courses
    assert courses and all(c.stop_ids for c in courses)


def test_pinned_shop_waits_for_its_opening():
    # A pinned shop next to the start that opens in 2 hours isn't the first stop of the walk.
    late = Candidate(id="late", lat=ORIGIN.lat + 0.0005, lng=ORIGIN.lng, value=0.5, dwell_min=15, must=True, open_from=120, open_until=600)
    others = [cand(i, 0.002 * i, 0.0, 0.6) for i in range(1, 6)]
    req = OptimizeRequest(origin=ORIGIN, candidates=[late, *others], stop_count=4, time_budget_min=300, exact_count=True)
    rec = optimize(req).courses[0]
    assert "late" in rec.stop_ids and rec.stop_ids[0] != "late"
