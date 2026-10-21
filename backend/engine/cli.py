"""Command-line worker. The API launches this as a subprocess; you can also run it directly.

  python -m engine.cli all --download      # fetch nflverse CSVs, import, build, validate, predict
  python -m engine.cli all                 # offline: use CSVs already in data/raw
  python -m engine.cli sync|build|backtest|predict|status
  python -m engine.cli smoke-test          # parser invariants (no data needed)
"""
from __future__ import annotations

import argparse
import json
import sys

from . import db, paths, pipeline, status


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="engine.cli")
    ap.add_argument("command", choices=["all", "sync", "build", "backtest", "predict", "status", "smoke-test"])
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--week", type=int, help="predict a single week (default: all weeks of the season)")
    ap.add_argument("--download", action="store_true", help="download missing nflverse CSVs into data/raw")
    ap.add_argument("--force", action="store_true", help="re-download / re-import even if unchanged")
    a = ap.parse_args(argv)

    def log(m):
        print(m, flush=True)

    if a.command == "smoke-test":
        from tests.test_parser import run_all as smoke  # noqa: PLC0415
        smoke()
        print("PASS: parser invariants (scoring, end-zone proxy, exclusions, embargo)")
        return 0
    if a.command == "all":
        try:
            pipeline.run_all(a.season, a.download, a.force, log=log)
            return 0
        except Exception:  # noqa: BLE001 - message already logged and written to build_status.json
            return 2
    c = db.connect(paths.db_path())
    try:
        if a.command == "sync":
            pipeline.run_sync(c, a.season, a.download, a.force, log)
        elif a.command == "build":
            pipeline.run_build(c, a.season, log)
        elif a.command == "backtest":
            r = pipeline.run_backtest(c, a.season, log)
            print(json.dumps({"run_id": r["run_id"], "promoted": r["gate"]["promoted"]}, indent=2))
        elif a.command == "predict":
            weeks = [(a.season, a.week)] if a.week else None
            for r in pipeline.run_predict(c, a.season, weeks, log):
                print(r)
        st = status.write_build_status(c, a.season)
        if a.command == "status":
            print(json.dumps({k: v for k, v in st.items() if k not in ("sources",)}, indent=2, default=str))
        return 0
    except Exception as ex:  # noqa: BLE001
        status.write_build_status(c, a.season, error=str(ex))
        print(f"ERROR: {ex}", file=sys.stderr)
        return 2
    finally:
        c.close()


if __name__ == "__main__":
    sys.exit(main())
