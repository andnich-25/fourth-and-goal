"""Pre-render every API response the interface needs into JSON files for static hosting.

  python -m engine.export_static            # writes ../site-data/
  cd ../frontend && VITE_STATIC=1 npm run build && cp -r ../site-data dist/data

The static build (VITE_STATIC=1) reads these files instead of calling the API. Filtering,
sorting, paging and Top 3 exclusions then run in the browser; locked picks are saved in the
browser's local storage. Nothing is computed here that the live API would not return.
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from fastapi.testclient import TestClient

KEY_PARAMS = ("season", "week", "window", "model", "market")


def key(path: str, params: dict | None = None) -> str:
    """Must match staticKey() in frontend/src/lib/api.ts."""
    parts = [f"{k}-{params[k]}" for k in KEY_PARAMS if params and params.get(k) not in (None, "")]
    return path.strip("/") + ("/" + "_".join(parts) if parts else "/index") + ".json"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "site-data"))
    ap.add_argument("--player-weeks", type=int, default=1, help="how many most recent weeks get player pages")
    a = ap.parse_args(argv)
    import main as api_main  # noqa: PLC0415

    out = Path(a.out)
    if out.exists():
        shutil.rmtree(out)
    client = TestClient(api_main.app)
    n = 0

    def save(path, params=None, query=None):
        nonlocal n
        q = {k: v for k, v in {**(params or {}), **(query or {})}.items() if v is not None}
        r = client.get("/api" + path, params=q)
        if r.status_code != 200:
            print(f"  skipped {path} {q}: HTTP {r.status_code}")
            return None
        f = out / key(path, params)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(r.json(), separators=(",", ":")))
        n += 1
        return r.json()

    for p in ("/health", "/data/status", "/parlay/model", "/odds/record", "/tendencies", "/backtest/confidence", "/backtest/due", "/backtest/tuning", "/backtest/summary", "/backtest/weeks", "/backtest/calibration", "/feature-glossary"):
        save(p)
    wk = save("/weeks")
    pm = save("/props/markets")
    for m in (pm or {}).get("markets", []):
        save("/props/backtest", {"market": m["market"]})
        save("/props", {"season": wk["current_season"], "week": wk["current_week"], "market": m["market"]})
    save("/odds", {"season": wk["current_season"], "week": wk["current_week"]})
    save("/scoring-trends", {"season": wk["current_season"]})
    bt = client.get("/api/backtest/summary").json()
    for m in list(bt.get("overall", {})) + ["baseline-opportunity"]:
        save("/backtest/picks", {"model": m})
    for season in wk["seasons"]:
        weeks = save("/weeks", {"season": season})
        done = [w["week"] for w in weeks["weeks"] if w["has_predictions"]]
        for week in done:
            sw = {"season": season, "week": week}
            save("/overview", sw)
            save("/weekly-top3", sw)
            save("/rankings", sw, {"eligible_only": False, "page_size": 2000})
            for win in (None, 6, 3):
                save("/defenses", {**sw, "window": win})
            if season == wk["current_season"]:
                for t in client.get("/api/defenses", params=sw).json()["teams"]:
                    save(f"/defenses/{t['defense']}", sw)
        if season == wk["current_season"]:
            for week in done[-a.player_weeks:]:
                sw = {"season": season, "week": week}
                ranks = client.get("/api/rankings", params={**sw, "eligible_only": False, "page_size": 2000}).json()
                for r in ranks["rows"]:
                    save(f"/players/{r['player_id']}", sw)
    (out / "manifest.json").write_text(json.dumps({"files": n, "current_season": wk["current_season"],
                                                   "current_week": wk["current_week"],
                                                   "generated_at": client.get("/api/data/status").json().get("generated_at")}))
    print(f"static export: {n} files -> {out}")


if __name__ == "__main__":
    main()
