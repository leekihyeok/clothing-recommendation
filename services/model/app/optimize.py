"""Course optimisation: pick and order shops for a walking course (an open orienteering problem).

Each candidate has a value (0-1, computed by the API from style fit, popularity and confidence) and a dwell time.
We maximise   sum(value) − distance_weight × walked km
subject to    walk minutes + dwell minutes ≤ time budget,  at most stop_count stops,
starting from the origin and ending at the last shop.

Candidates are few (≤ 60) and stops ≤ 6, so a greedy insertion from several starting shops followed by local search
(swap a stop for an unused shop, 2-opt on the order) gets close to optimal in milliseconds.
"""

import math
from dataclasses import dataclass

from pydantic import BaseModel, Field

WALK_M_PER_MIN = 70.0  # ~4.2 km/h, browsing pace
DETOUR = 1.3  # straight line → street distance


class LatLng(BaseModel):
    lat: float
    lng: float


class Candidate(BaseModel):
    id: str
    lat: float
    lng: float
    value: float = Field(ge=0, le=1)
    dwell_min: float = 15
    must: bool = False  # the user asked for this shop ("꼭 넣어 줘", or kept from the last course): in whenever it fits


class OptimizeRequest(BaseModel):
    origin: LatLng
    candidates: list[Candidate]
    stop_count: int = Field(ge=1, le=25)
    time_budget_min: float = Field(gt=0)
    exact_count: bool = False  # the user chose the number: fill it if the time allows, even if a stop adds little


class Leg(BaseModel):
    distance_m: float
    duration_min: float


class CourseResult(BaseModel):
    variant: str  # recommended | nearby | taste
    stop_ids: list[str]
    legs: list[Leg]  # legs[i] arrives at stop_ids[i]
    total_distance_m: float
    walk_min: float
    total_min: float
    value: float
    note: str | None = None


class OptimizeResponse(BaseModel):
    courses: list[CourseResult]


# variant → value lost per km walked. "nearby" hates walking, "taste" hardly cares.
VARIANTS = {"recommended": 0.25, "nearby": 0.8, "taste": 0.06}


# Outweighs any mix of other shops and walking, so a must-have shop is always in a feasible course.
MUST_BONUS = 100.0


def street_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1, lat2, lng2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h)) * DETOUR


@dataclass
class Problem:
    dist: list[list[float]]  # index 0 = origin, 1.. = candidates
    value: list[float]  # per node, origin 0
    dwell: list[float]
    stop_count: int
    budget: float
    km_weight: float
    exact_count: bool = False

    def length_m(self, route: list[int]) -> float:
        prev, total = 0, 0.0
        for n in route:
            total += self.dist[prev][n]
            prev = n
        return total

    def minutes(self, route: list[int]) -> float:
        return self.length_m(route) / WALK_M_PER_MIN + sum(self.dwell[n] for n in route)

    def feasible(self, route: list[int]) -> bool:
        return len(route) <= self.stop_count and self.minutes(route) <= self.budget + 1e-9

    def objective(self, route: list[int]) -> float:
        return sum(self.value[n] for n in route) - self.km_weight * self.length_m(route) / 1000


def best_insertion(p: Problem, route: list[int], node: int) -> tuple[float, list[int]] | None:
    best = None
    for pos in range(len(route) + 1):
        cand = route[:pos] + [node] + route[pos:]
        if p.feasible(cand):
            score = p.objective(cand)
            if best is None or score > best[0]:
                best = (score, cand)
    return best


def greedy(p: Problem, start: list[int]) -> list[int]:
    route = list(start)
    unused = [n for n in range(1, len(p.value)) if n not in route]
    while len(route) < p.stop_count:
        options = [r for n in unused if (r := best_insertion(p, route, n))]
        if not options:
            break
        score, cand = max(options, key=lambda o: o[0])
        if route and score <= p.objective(route):
            break  # adding any more stops makes the course worse
        added = next(n for n in cand if n not in route)
        unused.remove(added)
        route = cand
    return route


def two_opt(p: Problem, route: list[int]) -> list[int]:
    improved = True
    while improved:
        improved = False
        for i in range(len(route) - 1):
            for j in range(i + 1, len(route)):
                cand = route[:i] + route[i : j + 1][::-1] + route[j + 1 :]
                if p.length_m(cand) < p.length_m(route) - 1e-6:
                    route, improved = cand, True
    return route


def local_search(p: Problem, route: list[int]) -> list[int]:
    route = two_opt(p, route)
    improved = True
    while improved:
        improved = False
        current = p.objective(route)
        unused = [n for n in range(1, len(p.value)) if n not in route]
        for out in list(route):
            base = [n for n in route if n != out]
            for new in unused:
                r = best_insertion(p, base, new)
                if r and r[0] > current + 1e-9:
                    route, improved = two_opt(p, r[1]), True
                    break
            if improved:
                break
        if not improved and len(route) < p.stop_count:
            # Drop one stop and refill greedily: frees time to fit two closer shops instead of one far one.
            for out in [None, *route]:
                grown = greedy(p, [n for n in route if n != out])
                if p.objective(grown) > current + 1e-9:
                    route, improved = two_opt(p, grown), True
                    break
    return route


def solve(p: Problem, beam: int | None = None, polish: int = 5) -> list[int]:
    """Beam search over growing routes (each step: best insertion of every unused shop into every kept route),
    then local search on the best few. One-at-a-time greedy misses cases where a far shop should give way to two
    near ones; keeping a beam of partial routes catches those."""
    n = len(p.value) - 1
    if n == 0:
        return []
    if beam is None:
        # Long courses: a narrower beam keeps it under a second or two (a full day of 20+ stops: about 1.5 s).
        beam = 30 if p.stop_count <= 6 else 10 if p.stop_count <= 12 else 4
    if p.stop_count > 12:
        polish = min(polish, 2)  # fewer local-search rounds on the best routes of a long course
    level = [[]]
    found: dict[frozenset, list[int]] = {}
    for _ in range(p.stop_count):
        nxt: dict[frozenset, list[int]] = {}
        for route in level:
            for node in range(1, n + 1):
                if node in route:
                    continue
                r = best_insertion(p, route, node)
                if r is None:
                    continue
                key = frozenset(r[1])
                if key not in nxt or p.objective(r[1]) > p.objective(nxt[key]):
                    nxt[key] = r[1]
        if not nxt:
            break
        level = sorted(nxt.values(), key=p.objective, reverse=True)[:beam]
        found.update({frozenset(r): r for r in level})
    routes = list(found.values())
    if p.exact_count:
        # Prefer routes with exactly the asked number of stops; fall back to the longest feasible ones.
        longest = max(len(r) for r in routes)
        routes = [r for r in routes if len(r) == min(p.stop_count, longest)]
    top = sorted(routes, key=p.objective, reverse=True)[:polish]
    polished = [local_search(p, r) for r in top]
    if p.exact_count:
        polished = [r for r in polished if len(r) == len(top[0])] or top  # local search must not drop stops
    best = max(polished, key=p.objective, default=[])
    return best if p.exact_count or p.objective(best) > 0 else []


def optimize(req: OptimizeRequest) -> OptimizeResponse:
    points = [(req.origin.lat, req.origin.lng)] + [(c.lat, c.lng) for c in req.candidates]
    dist = [[street_m(a, b) for b in points] for a in points]
    courses: list[CourseResult] = []
    seen: set[tuple[str, ...]] = set()
    for variant, km_weight in VARIANTS.items():
        p = Problem(
            dist=dist,
            value=[0.0] + [c.value + (MUST_BONUS if c.must else 0.0) for c in req.candidates],
            dwell=[0.0] + [c.dwell_min for c in req.candidates],
            stop_count=req.stop_count,
            budget=req.time_budget_min,
            km_weight=km_weight,
            exact_count=req.exact_count,
        )
        route = solve(p)
        key = tuple(route)
        if variant != "recommended" and key in seen:
            continue  # same as a course we already have
        seen.add(key)
        legs, prev = [], 0
        for n in route:
            legs.append(Leg(distance_m=round(dist[prev][n]), duration_min=round(dist[prev][n] / WALK_M_PER_MIN, 1)))
            prev = n
        note = None
        if len(route) < req.stop_count:
            note = f"시간 안에 {len(route)}곳까지 돌 수 있어요" if route else "조건에 맞는 가게가 없어요"
        courses.append(
            CourseResult(
                variant=variant,
                stop_ids=[req.candidates[n - 1].id for n in route],
                legs=legs,
                total_distance_m=round(p.length_m(route)),
                walk_min=round(p.length_m(route) / WALK_M_PER_MIN, 1),
                total_min=round(p.minutes(route), 1),
                value=round(sum(req.candidates[n - 1].value for n in route), 3),
                note=note,
            )
        )
    return OptimizeResponse(courses=courses)
