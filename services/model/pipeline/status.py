"""Progress of the evidence → score → verify run, per region, and of the scheduled refresh (pipeline.refresh).
Usage: python -m pipeline.status"""

from pipeline.db import connect


def main() -> None:
    with connect() as conn:
        rows = conn.execute(
            """SELECT coalesce(g.name, '(지역 밖)') AS region, count(*) AS shops,
                      count(*) FILTER (WHERE s.evidence_at IS NOT NULL) AS evidence,
                      count(*) FILTER (WHERE s.matched_posts > 0) AS with_posts,
                      count(*) FILTER (WHERE s.scored_at IS NOT NULL) AS scored,
                      count(*) FILTER (WHERE s.confidence IS NOT NULL) AS verified,
                      count(*) FILTER (WHERE s.confidence >= 0.6) AS high
               FROM shops s
               LEFT JOIN LATERAL (SELECT name, shop_count FROM regions r WHERE ST_Intersects(r.polygon, s.geom) LIMIT 1) g ON true
               WHERE s.kind = 'store' AND s.status = 'candidate' AND s.category IS NOT NULL AND s.category <> 'excluded'
               GROUP BY g.name, g.shop_count ORDER BY g.shop_count DESC NULLS LAST"""
        ).fetchall()
        calls = conn.execute(
            """SELECT count(*), count(*) FILTER (WHERE NOT ok) FROM llm_calls
               WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'"""
        ).fetchone()
        last = dict(conn.execute(
            """SELECT step, max(finished_at AT TIME ZONE 'Asia/Seoul') FROM pipeline_runs
               WHERE status = 'ok' AND step IN ('refresh_weekly', 'refresh_monthly', 'kakao_grid', 'import_sbiz') GROUP BY step"""
        ).fetchall())
        states = dict(conn.execute(
            "SELECT status, count(*) FROM shops WHERE status IN ('suspended', 'closed') GROUP BY status"
        ).fetchall())
    print(f"{'지역':<14}{'가게':>7}{'근거수집':>9}{'근거있음':>9}{'채점':>7}{'검증':>7}{'신뢰높음':>9}")
    total = [0] * 6
    for name, *nums in rows:
        print(f"{name:<14}" + "".join(f"{n:>9,}" if i in (1, 2, 5) else f"{n:>7,}" for i, n in enumerate(nums)))
        total = [a + b for a, b in zip(total, nums)]
    print(f"{'합계':<14}" + "".join(f"{n:>9,}" if i in (1, 2, 5) else f"{n:>7,}" for i, n in enumerate(total)))
    print(f"\n오늘 AI 호출 {calls[0]:,}회 (실패 {calls[1]:,})")

    def when(step: str) -> str:
        return f"{last[step]:%m-%d %H:%M}" if last.get(step) else "아직 없음"

    monthly = max(filter(None, [last.get("refresh_monthly"), last.get("kakao_grid")]), default=None)
    print(f"정기 갱신: 매주 {when('refresh_weekly')} · 매달(카카오 새 가게) {f'{monthly:%m-%d %H:%M}' if monthly else '아직 없음'}")
    print(f"공공데이터 반영 {when('import_sbiz')} (분기마다 새 파일을 내려받아 pipeline.sbiz)")
    print(f"신고·점검으로 숨긴 가게 {states.get('suspended', 0):,}곳 · 폐업 확정 {states.get('closed', 0):,}곳")


if __name__ == "__main__":
    main()
