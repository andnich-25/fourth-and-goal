"""Background import jobs. The API never runs ingestion inline: it launches the CLI worker
as a subprocess (argument list, no shell) and streams its log into the jobs table."""
from __future__ import annotations

import json
import subprocess
import sys
import threading
import uuid
from pathlib import Path

from engine import db, paths
from engine.util import utcnow

BACKEND_DIR = Path(__file__).resolve().parents[1]
_lock = threading.Lock()


def running_job(c):
    return c.execute("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").fetchone()


def start(season: int, download: bool, force: bool) -> dict:
    with _lock:
        c = db.connect(paths.db_path())
        try:
            r = running_job(c)
            if r:
                return {"job_id": r["job_id"], "status": r["status"], "already_running": True}
            job_id = "job-" + uuid.uuid4().hex[:10]
            args = [sys.executable, "-m", "engine.cli", "all", "--season", str(int(season))]
            if download:
                args.append("--download")
            if force:
                args.append("--force")
            with c:
                c.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)",
                          (job_id, "refresh", "queued", utcnow(), None, None, json.dumps(args[2:]), "", None))
        finally:
            c.close()
    threading.Thread(target=_run, args=(job_id, args), daemon=True).start()
    return {"job_id": job_id, "status": "queued", "already_running": False}


def _run(job_id: str, args: list[str]):
    c = db.connect(paths.db_path())
    lines: list[str] = []
    try:
        with c:
            c.execute("UPDATE jobs SET status='running', started_at=? WHERE job_id=?", (utcnow(), job_id))
        proc = subprocess.Popen(args, cwd=BACKEND_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        assert proc.stdout is not None
        for line in proc.stdout:
            lines.append(line.rstrip())
            if len(lines) % 5 == 0:
                with c:
                    c.execute("UPDATE jobs SET log=? WHERE job_id=?", ("\n".join(lines[-400:]), job_id))
        code = proc.wait()
        status = "succeeded" if code == 0 else "failed"
        err = None if code == 0 else next((ln for ln in reversed(lines) if "STOPPED" in ln or "ERROR" in ln), f"exit code {code}")
        with c:
            c.execute("UPDATE jobs SET status=?, finished_at=?, log=?, error=? WHERE job_id=?",
                      (status, utcnow(), "\n".join(lines[-400:]), err, job_id))
    except Exception as ex:  # noqa: BLE001
        with c:
            c.execute("UPDATE jobs SET status='failed', finished_at=?, error=?, log=? WHERE job_id=?",
                      (utcnow(), str(ex), "\n".join(lines[-400:]), job_id))
    finally:
        c.close()
