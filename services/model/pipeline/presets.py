"""Pipeline step: ready-made course ideas for the first screen ("성수 미니멀 산책", "동묘 빈티지 디깅" …).

For every region and style set, count the shops that fit: a real style score of 6+ (step ⑤), or, for shops not scored
yet, the same category guess the API uses (CATEGORY_PRIOR in apps/api/src/course/course.service.ts). A region gets up
to two presets, for the style sets it has plenty of and that stand out against all regions (lift). Ranking leans on
real scores over guesses, so re-run this as step ⑤ covers more regions. AI then names each preset from the region and
the fitting shops. Re-running replaces all presets.

Usage: python -m pipeline.presets [--per-region 2] [--min-fit 8] [--dry-run]
"""

import argparse
import json
import math
from collections import defaultdict

from pydantic import BaseModel, Field

from ai import AIError, generate
from app.catalog import load_catalog
from pipeline.db import connect, pipeline_run

CATALOG = load_catalog()
STYLE_LABEL = {s.id: s.label for s in CATALOG.styles}

# Same guesses as the API's CATEGORY_PRIOR (0-10), for shops step ⑤ hasn't scored yet.
CATEGORY_PRIOR: dict[str, dict[str, int]] = {
    "vintage": {"vintage": 8, "secondhand": 8, "amekaji": 4, "workwear": 4, "street": 3},
    "select_shop": {"designer": 6, "street": 5, "minimal": 5, "casual": 4},
    "brand": {"casual": 5, "minimal": 3},
    "spa": {"casual": 7, "minimal": 5},
    "general": {"casual": 4},
    "complex": {"casual": 6, "minimal": 4, "designer": 4},
}
FIT_SCORE = 6
# A preset should say something about the place: the style set must be this much more common there than overall.
MIN_LIFT = 1.2

# What a preset can be about. 빈티지 and 구제 are shopped together, so they are one idea.
STYLE_SETS: list[tuple[str, ...]] = [
    ("vintage", "secondhand"), ("street",), ("minimal",), ("amekaji",), ("gorpcore",), ("y2k",), ("designer",), ("workwear",), ("casual",),
]
# 캐주얼 fits nearly everywhere, so it only wins where nothing more particular does.
SET_WEIGHT = {("casual",): 0.5}

SYSTEM = """너는 서울 옷가게 코스 앱의 에디터다. 지역과 스타일 조합마다 "이런 코스 어때요" 카드에 쓸 제목과 소개를 쓴다.
지역 이름, 지역 소개, 스타일, 맞는 가게 수, 가게 예시(이름과 한 줄 소개)를 준다.

- title: 카드 제목. 지역 이름을 넣고 14자 안팎. 예: "동묘 빈티지 디깅", "한남 디자이너 편집숍 산책", "성수 미니멀 한 바퀴"
  "추천", "최고", "핫플" 같은 말은 쓰지 않는다. 카드끼리 제목이 겹치지 않게 한다.
- intro: 한 문장, 40자 안팎. 가게 예시와 지역 소개에 있는 내용만 근거로 쓴다. 가게 이름은 많아야 하나.
  scored_share가 낮으면(가게 소개가 거의 없으면) 구체적인 이야기를 지어내지 말고 지역 소개 수준으로 쓴다."""


class PresetText(BaseModel):
    key: int
    title: str
    intro: str = Field(description="한 문장")


class PresetTexts(BaseModel):
    presets: list[PresetText]


def fits(category: str, scores: dict[str, int] | None, style_set: tuple[str, ...]) -> bool:
    source = scores if scores is not None else CATEGORY_PRIOR.get(category, {})
    return any(source.get(s, 0) >= FIT_SCORE for s in style_set)


def pick(per_region: int, min_fit: int) -> list[dict]:
    with connect() as conn:
        regions = {rid: {"name": name, "intro": intro} for rid, name, intro in conn.execute("SELECT id, name, intro FROM regions")}
        rows = conn.execute(
            """SELECT g.id, s.id, s.category, s.scored_at IS NOT NULL, s.summary, s.name
               FROM regions g JOIN shops s ON ST_Intersects(g.polygon, s.geom)
               WHERE s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'"""
        ).fetchall()
        scored_ids = [sid for _, sid, _, scored, _, _ in rows if scored]
        scores: dict[int, dict[str, int]] = defaultdict(dict)
        for sid, style, score in conn.execute(
            "SELECT shop_id, style_id, score FROM shop_style_scores WHERE shop_id = ANY(%s)", (scored_ids,)
        ):
            scores[sid][style] = score

    # fit[region][style set] = [(shop id, scored?, summary, name)]
    fit: dict[int, dict[tuple, list]] = defaultdict(lambda: defaultdict(list))
    size: dict[int, int] = defaultdict(int)
    for rid, sid, category, scored, summary, name in rows:
        size[rid] += 1
        for ss in STYLE_SETS:
            if fits(category, scores.get(sid, {}) if scored else None, ss):
                fit[rid][ss].append((sid, scored, summary, name))

    total = sum(size.values())
    overall = {ss: sum(len(fit[r][ss]) for r in fit) / total for ss in STYLE_SETS}

    picked = []
    for rid, by_set in fit.items():
        options = []
        for ss, shops in by_set.items():
            n = len(shops)
            if n < min_fit or not overall[ss]:
                continue
            lift = (n / size[rid]) / overall[ss]
            if lift < MIN_LIFT:
                continue
            scored_share = sum(1 for s in shops if s[1]) / n
            # Enough shops matters, standing out matters more; real scores count more than category guesses.
            rank = math.sqrt(n) * lift * (0.6 + 0.4 * scored_share) * SET_WEIGHT.get(ss, 1.0)
            options.append({"styles": list(ss), "fit": n, "lift": lift, "scored_share": scored_share, "rank": rank, "shops": shops})
        options.sort(key=lambda o: -o["rank"])
        for o in options[:per_region]:
            # Examples for the writer: scored shops with a summary first.
            examples = sorted(o["shops"], key=lambda s: (not s[1], s[2] is None))[:6]
            picked.append({
                "region_id": rid, "region": regions[rid]["name"], "region_intro": regions[rid]["intro"],
                "styles": o["styles"], "stop_count": 5 if o["fit"] >= 25 else 4, "fit": o["fit"],
                "lift": round(o["lift"], 2), "scored_share": round(o["scored_share"], 2), "rank": round(o["rank"], 3),
                "examples": [{"name": s[3], "summary": s[2]} for s in examples],
            })
    picked.sort(key=lambda p: -p["rank"])
    return picked


def done_today() -> bool:
    """Presets were rebuilt in the last 20 hours: the region loop asks after every region, once a day is plenty."""
    with connect() as conn:
        return conn.execute(
            "SELECT EXISTS (SELECT 1 FROM pipeline_runs WHERE step = 'presets' AND status = 'ok' AND finished_at > now() - interval '20 hours')"
        ).fetchone()[0]


def run(per_region: int, min_fit: int, dry_run: bool) -> dict:
    presets = pick(per_region, min_fit)
    if dry_run:
        return {"presets": [{k: p[k] for k in ("region", "styles", "fit", "lift", "scored_share", "rank")} for p in presets]}

    with connect() as conn, pipeline_run(conn, "presets") as stats:
        texts: dict[int, PresetText] = {}
        # When the AI can't write today, a card keeps the title it had (same area and styles), else a plain one: the
        # picks are still refreshed, and one busy model no longer fails the whole step.
        before = {
            (rid, tuple(sorted(styles))): (title, intro)
            for rid, styles, title, intro in conn.execute("SELECT region_id, styles, title, intro FROM presets")
        }
        stats["ai_failed"] = 0
        for i in range(0, len(presets), 15):
            chunk = [
                {"key": i + j, "region": p["region"], "region_intro": p["region_intro"],
                 "styles": [STYLE_LABEL[s] for s in p["styles"]], "fit_count": p["fit"], "scored_share": p["scored_share"],
                 "examples": p["examples"]}
                for j, p in enumerate(presets[i : i + 15])
            ]
            try:
                result = generate(
                    purpose="name_presets", system=SYSTEM,
                    prompt="각 카드의 제목과 소개를 써라.\n\n" + json.dumps(chunk, ensure_ascii=False, indent=1),
                    schema=PresetTexts, tier="smart", conn=conn, run_id=stats["run_id"],
                )
            except AIError as e:
                stats["ai_failed"] += 1
                print(f"  presets: AI unavailable for cards {i}-{i + len(chunk) - 1}, keeping earlier titles ({e!s:.120})", flush=True)
                continue
            texts.update({t.key: t for t in result.presets})

        with conn.transaction():
            conn.execute("DELETE FROM presets")
            for key, p in enumerate(presets):
                t = texts.get(key)
                old = before.get((p["region_id"], tuple(sorted(p["styles"]))))
                title = t.title if t else old[0] if old else f"{p['region']} {' · '.join(STYLE_LABEL[s] for s in p['styles'])} 코스"
                intro = t.intro if t else old[1] if old else None
                conn.execute(
                    """INSERT INTO presets (region_id, styles, stop_count, title, intro, fit_count, scored_share, rank)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                    (p["region_id"], p["styles"], p["stop_count"], title, intro, p["fit"], p["scored_share"], p["rank"]),
                )
        stats["presets"] = [{"title": t, "fit": f} for t, f in conn.execute("SELECT title, fit_count FROM presets ORDER BY rank DESC")]
    return stats


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-region", type=int, default=2)
    ap.add_argument("--min-fit", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true", help="pick and print, no AI call, nothing saved")
    a = ap.parse_args()
    print(json.dumps(run(a.per_region, a.min_fit, a.dry_run), ensure_ascii=False, indent=2))
