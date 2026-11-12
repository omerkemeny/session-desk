#!/usr/bin/env python3
"""Correctness at size: parity against the synthetic folder, warm restart equals cold start, 1,000 random changes then equal to a fresh server, no 500s, health ok."""
import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import scale  # noqa: E402
import scale_home  # noqa: E402


def listing(home, state):
    """Start a server, return (list, health, non-200 counts after opening every listed session), stop it."""
    proc, port, _ = scale.start(home, state)
    c = scale.Client(port)
    try:
        lst = c.json("/api/sessions")
        for o in lst:
            c.get(f"/api/session?id={o['id']}")
        c.get("/api/sessions?ids=" + ",".join(o["id"] for o in lst[:100]))
        c.get("/api/stats")
        h = c.json("/api/health")
        lst2 = c.json("/api/sessions")
        return lst2, h, dict(c.bad)
    finally:
        scale.stop(proc)


def same(a, b):
    """(equal, rows that differ by id and field names)."""
    da, db = {o["id"]: o for o in a}, {o["id"]: o for o in b}
    diff = sorted(set(da) ^ set(db))
    for k in set(da) & set(db):
        f = [x for x in da[k] if da[k][x] != db[k].get(x)]
        if f:
            diff.append(f"{k[:8]}:{','.join(f)}")
    return a == b, diff[:10], [o["id"] for o in a] == [o["id"] for o in b]


def main():
    """Command line: scale_check.py --sessions N --live L --waiting W --big MB --projects P [--changes 1000]."""
    ap = argparse.ArgumentParser(description=__doc__)
    for k, d in (("--sessions", 5000), ("--live", 60), ("--waiting", 30), ("--big", 100), ("--projects", 40), ("--subagents", 50), ("--changes", 1000)):
        ap.add_argument(k, type=int, default=d)
    ap.add_argument("--auto", type=float, default=0.6)
    a = ap.parse_args()
    home = tempfile.mkdtemp(prefix="desk-scale-check-")
    out = {}
    procs, temps = [], []
    try:
        shape = scale_home.build(home, a.sessions, a.live, a.waiting, a.big, a.projects, a.subagents, a.auto)
        procs = scale_home.relive(home, a.live, a.waiting)
        r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "parity.py"), "--home", home], capture_output=True, text=True, cwd=ROOT, timeout=3600)
        out["parity"] = [ln for ln in r.stdout.splitlines() if ln.strip()][-4:] + ([f"exit {r.returncode}"] if r.returncode else [])
        state = tempfile.mkdtemp(prefix="desk-scale-cs-")
        temps.append(state)
        cold, h1, bad1 = listing(home, state)
        time.sleep(1)
        warm, h2, bad2 = listing(home, state)
        out["warmEqualsCold"] = same(cold, warm)
        rnd, n, made = random.Random(11), a.sessions, 0
        regs = sorted(os.listdir(os.path.join(home, "sessions")))
        for i in range(a.changes):
            x = rnd.random()
            if x < 0.6:
                scale.append(scale.path_of(home, scale_home.sid_of(rnd.randrange(min(n, a.live + 50)))))
            elif x < 0.85:
                scale.append(scale.path_of(home, scale_home.sid_of(rnd.randrange(n))))
            elif x < 0.95 and regs:
                p = os.path.join(home, "sessions", rnd.choice(regs))
                with open(p) as fh:
                    d = json.load(fh)
                d["status"], d["statusUpdatedAt"] = rnd.choice(["busy", "idle"]), int(time.time() * 1000)
                with open(p + ".tmp", "w") as fh:
                    json.dump(d, fh)
                os.replace(p + ".tmp", p)
            else:
                made += 1
                proj = os.path.join(home, "projects", f"-scale-p{rnd.randrange(a.projects)}")
                scale_home.transcript(os.path.join(proj, scale_home.sid_of(10**6 + made) + ".jsonl"), rnd, "/scale/new", time.time(), 6000, rnd.random() < 0.5)
        after, h3, bad3 = listing(home, state)
        temps.append(tempfile.mkdtemp(prefix="desk-scale-cf-"))
        fresh, h4, bad4 = listing(home, temps[-1])
        out["afterChangesEqualsFresh"] = same(after, fresh)
        out["rows"] = [len(cold), len(after)]
        out["health"] = [(h.get("ok"), h.get("formatWarnings")) for h in (h1, h2, h3, h4)]
        out["anomalies"] = (h4.get("formatChecked") or {}).get("anomalies")
        out["non200"] = [bad1, bad2, bad3, bad4]
        out["newSessions"] = made
        out["shapeMb"] = round(shape["bytes"] / 2**20)
    finally:
        for p in procs:
            p.kill()
            p.wait()
        for d in [home] + temps:
            shutil.rmtree(d, ignore_errors=True)
    print(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
