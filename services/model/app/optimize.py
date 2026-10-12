"""Course optimisation: pick and order shops for a walking course (an open orienteering problem).

Each candidate has a value (0-1, computed by the API from style fit, popularity and confidence) and a dwell time.
We maximise   sum(value) − distance_weight × walked km
subject to    walk minutes + dwell minutes (+ waits) ≤ time budget,  at most stop_count stops,
              each shop reached while it is open (when its hours are known),
starting from the origin and ending at the last shop — or walking on to a chosen end point (a station, a meeting
place), whose last leg then counts like any other.

Candidates are few (≤ 60) and stops ≤ 6, so a greedy insertion from several starting shops followed by local search
(swap a stop for an unused shop, 2-opt on the order) gets close to optimal in milliseconds.
"""

import math
from dataclasses import dataclass, field

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
    # Opening hours as minutes after the course starts (None = unknown, or open all along). Reached before open_from,
    # the walk waits (up to MAX_WAIT_MIN); it must arrive with MIN_BROWSE_MIN left before open_until.
    open_from: float | None = None
    open_until: float | None = None


class OptimizeRequest(BaseModel):
    origin: LatLng
    candidates: list[Candidate]
    stop_count: int = Field(ge=1, le=25)
    time_budget_min: float = Field(gt=0)
    exact_count: bool = False  # the user chose the number: fill it if the time allows, even if a stop adds little
    end: LatLng | None = None  # finish here (walk on from the last shop); None = the course ends at its last shop
    # Rain, snow, heat or cold: walking costs this many times more in every variant (shorter walks between shops).
    distance_scale: float = Field(1.0, ge=0.5, le=5)


class Leg(BaseModel):
    distance_m: float
    duration_min: float


class CourseResult(BaseModel):
    variant: str  # recommended | nearby | taste
    stop_ids: list[str]
    legs: list[Leg]  # legs[i] arrives at stop_ids[i]
    end_leg: Leg | None = None  # last shop → end point, when there is one
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

# Hours: standing at a closed door longer than this isn't a plan; arriving with less than this before closing isn't either.
MAX_WAIT_MIN = 30.0
# Value lost per minute spent waiting for a shop to open (an hour ≈ a good shop).
WAIT_WEIGHT = 0.01
MIN_BROWSE_MIN = 15.0
ALWAYS = (0.0, math.inf)


def street_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1, lat2, lng2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h)) * DETOUR


@dataclass
class Problem:
    dist: list[list[float]]  # index 0 = origin, 1.. = candidates, then the end point if any
    value: list[float]  # per node, origin (and end) 0
    dwell: list[float]
    stop_count: int
    budget: float
    km_weight: float
    exact_count: bool = False
    window: list[tuple[float, float]] | None = None  # per node (open_from, open_until) in course minutes
    end: int | None = None  # node index of the end point (last row of dist), if any
    # Pinned shops: the walk may wait longer than MAX_WAIT_MIN for them to open (the user asked for them; the card
    # says when it opens) instead of dropping them.
    patient: frozenset[int] = frozenset()
    _walks: dict = field(default_factory=dict, repr=False)

    def shops(self) -> range:
        """Candidate nodes (not the origin, not the end point)."""
        return range(1, len(self.value) - (self.end is not None))

    def length_m(self, route: list[int]) -> float:
        prev, total = 0, 0.0
        for n in route:
            total += self.dist[prev][n]
            prev = n
        if self.end is not None:
            total += self.dist[prev][self.end]
        return total

    def _walk(self, route: list[int]) -> tuple[float, float] | None:
        """(minutes from the start to the end of the course, of which waiting for shops to open), or None when a shop
        would be reached closed. Cached per route: feasible() and objective() ask about the same routes over and over."""
        key = tuple(route)
        if key in self._walks:
            return self._walks[key]
        out = self._walk_uncached(route)
        if len(self._walks) < 200_000:
            self._walks[key] = out
        return out

    def _walk_uncached(self, route: list[int]) -> tuple[float, float] | None:
        t, waited, prev = 0.0, 0.0, 0
        for n in route:
            t += self.dist[prev][n] / WALK_M_PER_MIN
            if self.window:
                lo, hi = self.window[n]
                if t < lo:
                    if lo - t > MAX_WAIT_MIN and n not in self.patient:
                        return None
                    waited += lo - t
                    t = lo
                if t + MIN_BROWSE_MIN > hi:
                    return None
            t += self.dwell[n]
            prev = n
        if self.end is not None:
            t += self.dist[prev][self.end] / WALK_M_PER_MIN
        return t, waited

    def timeline(self, route: list[int]) -> float | None:
        """Minutes from the start to the end of the course (walks, browsing, waits for a shop to open), or None when a
        shop would be reached closed."""
        w = self._walk(route)
        return None if w is None else w[0]

    def minutes(self, route: list[int]) -> float:
        t = self.timeline(route)
        return math.inf if t is None else t

    def feasible(self, route: list[int]) -> bool:
        return len(route) <= self.stop_count and self.minutes(route) <= self.budget + 1e-9

    def objective(self, route: list[int]) -> float:
        # Standing at a closed door counts against a route too, so a shop that opens later is visited later.
        w = self._walk(route) if self.window else None
        waited = w[1] if w else 0.0
        return sum(self.value[n] for n in route) - self.km_weight * self.length_m(route) / 1000 - WAIT_WEIGHT * waited


def best_insertion(p: Problem, route: list[int], node: int) -> tuple[float, list[int]] | None:
    """The best place to put `node` in `route` (score, new route), or None when it fits nowhere. Same answer as
    trying every position with feasible() / objective(), without building and re-walking a list per position: the
    added length is the detour at that spot, and without opening hours the time follows from the length."""
    if len(route) + 1 > p.stop_count:
        return None
    dist, n = p.dist, len(route)
    base_len = p.length_m(route)
    base_value = sum(p.value[x] for x in route) + p.value[node]
    dwell = sum(p.dwell[x] for x in route) + p.dwell[node]
    best_score, best_pos = -math.inf, -1
    for pos in range(n + 1):
        prev = route[pos - 1] if pos else 0
        nxt = route[pos] if pos < n else p.end
        added = dist[prev][node] + (dist[node][nxt] - dist[prev][nxt] if nxt is not None else 0.0)
        length = base_len + added
        score = base_value - p.km_weight * length / 1000
        if p.window is None:
            if length / WALK_M_PER_MIN + dwell > p.budget + 1e-9:
                continue
        else:
            if score <= best_score:
                continue  # waiting only lowers the score: this spot can't win
            w = p._walk(route[:pos] + [node] + route[pos:])
            if w is None or w[0] > p.budget + 1e-9:
                continue
            score -= WAIT_WEIGHT * w[1]
        if score > best_score:
            best_score, best_pos = score, pos
    if best_pos < 0:
        return None
    return best_score, route[:best_pos] + [node] + route[best_pos:]


def greedy(p: Problem, start: list[int]) -> list[int]:
    route = list(start)
    unused = [n for n in p.shops() if n not in route]
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
                # Better by the same measure local_search uses (shorter, or less waiting for a shop to open — judging
                # by length alone undid what local_search chose and the two looped forever); never reaching one closed.
                if p.feasible(cand) and p.objective(cand) > p.objective(route) + 1e-9:
                    route, improved = cand, True
    return route


def local_search(p: Problem, route: list[int]) -> list[int]:
    route = two_opt(p, route)
    improved = True
    while improved:
        improved = False
        current = p.objective(route)
        unused = [n for n in p.shops() if n not in route]
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
    if not len(p.shops()):
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
            for node in p.shops():
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
    if not routes:
        return []  # nothing reachable while open
    if p.exact_count:
        # Prefer routes with exactly the asked number of stops; fall back to the longest feasible ones.
        longest = max(len(r) for r in routes)
        routes = [r for r in routes if len(r) == min(p.stop_count, longest)]
    top = sorted(routes, key=p.objective, reverse=True)[:polish]
    polished = [local_search(p, r) for r in top]
    if p.exact_count:
        polished = [r for r in polished if len(r) == len(top[0])] or top  # local search must not drop stops
    best = max(polished, key=p.objective, default=[])
    # A course whose walking outweighs its shops (rain makes every metre count 2.5x for "nearby") is still a course:
    # an empty one only when nothing at all can be reached.
    return best


def optimize(req: OptimizeRequest) -> OptimizeResponse:
    points = [(req.origin.lat, req.origin.lng)] + [(c.lat, c.lng) for c in req.candidates]
    end = None
    if req.end is not None:
        points.append((req.end.lat, req.end.lng))
        end = len(points) - 1
    dist = [[street_m(a, b) for b in points] for a in points]
    timed = any(c.open_from is not None or c.open_until is not None for c in req.candidates)
    window = None
    if timed:
        window = [ALWAYS] + [(c.open_from or 0.0, math.inf if c.open_until is None else c.open_until) for c in req.candidates]
        if end is not None:
            window.append(ALWAYS)
    tail = [0.0] if end is not None else []
    courses: list[CourseResult] = []
    seen: set[tuple[str, ...]] = set()
    for variant, km_weight in VARIANTS.items():
        p = Problem(
            dist=dist,
            value=[0.0] + [c.value + (MUST_BONUS if c.must else 0.0) for c in req.candidates] + tail,
            dwell=[0.0] + [c.dwell_min for c in req.candidates] + tail,
            stop_count=req.stop_count,
            budget=req.time_budget_min,
            km_weight=km_weight * req.distance_scale,
            exact_count=req.exact_count,
            window=window,
            end=end,
            patient=frozenset(i + 1 for i, c in enumerate(req.candidates) if c.must),
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
        end_leg = None
        if end is not None and route:
            end_leg = Leg(distance_m=round(dist[prev][end]), duration_min=round(dist[prev][end] / WALK_M_PER_MIN, 1))
        note = None
        if len(route) < req.stop_count:
            note = f"시간 안에 {len(route)}곳까지 돌 수 있어요" if route else "조건에 맞는 가게가 없어요"
        courses.append(
            CourseResult(
                variant=variant,
                stop_ids=[req.candidates[n - 1].id for n in route],
                legs=legs,
                end_leg=end_leg,
                total_distance_m=round(p.length_m(route)),
                walk_min=round(p.length_m(route) / WALK_M_PER_MIN, 1),
                total_min=round(p.minutes(route), 1) if route else 0.0,
                value=round(sum(req.candidates[n - 1].value for n in route), 3),
                note=note,
            )
        )
    return OptimizeResponse(courses=courses)
