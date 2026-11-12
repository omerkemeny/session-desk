#!/usr/bin/env python3
"""Measure the change feed alone on a synthetic folder: subprocess spawns, stat calls, folder listings, file opens, signature passes and CPU per wall second,
idle and with one append a second."""
import argparse
import builtins
import json
import os
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


def main():
    """Command line: feed_cost.py HOME [--seconds N]; prints one JSON line (counts and timings only)."""
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("home")
    ap.add_argument("--seconds", type=float, default=10)
    ap.add_argument("--live", type=int, default=5, help="registry entries pointed at this process")
    a = ap.parse_args()
    if os.path.realpath(a.home) == os.path.realpath(os.path.expanduser("~/.claude")):
        sys.exit("refusing to measure the real ~/.claude")
    os.environ["DESK_CLAUDE_DIR"] = a.home
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import bench_home
    bench_home.relive(a.home, a.live)
    from desk import config, events, transcripts as tx
    config.HOME = a.home
    counts = {"stat": 0, "passes": 0, "spawn": 0, "list": 0, "open": 0}
    real_stat, real_sig = os.stat, events.snapshot

    def counted(kind, real):
        """A wrapper of `real` that counts its calls under `kind`."""
        def call(*x, **k):
            """Count, then call."""
            counts[kind] += 1
            return real(*x, **k)
        return call
    stat = counted("stat", real_stat)
    os.scandir, os.listdir = counted("list", os.scandir), counted("list", os.listdir)
    builtins.open, os.open = counted("open", builtins.open), counted("open", os.open)

    class Popen(subprocess.Popen):
        """Counting subprocess start."""

        def __init__(self, *x, **k):
            counts["spawn"] += 1
            super().__init__(*x, **k)
    subprocess.Popen = Popen

    def sig():
        """Counting signature."""
        counts["passes"] += 1
        return real_sig()
    os.stat, events.snapshot = stat, sig
    n = events.subscribe()
    got = []
    threading.Thread(target=lambda: [got.append((time.monotonic(), events.wait(got[-1][1] if got else n, 30))) for _ in iter(int, 1)], daemon=True).start()
    time.sleep(2.5)
    out = {"files": len(tx.session_paths()), "live": a.live}
    for phase in ("idle", "busy"):
        c0, base, t0 = time.process_time(), dict(counts), time.monotonic()
        lat, target = [], sorted(tx.session_paths())[len(tx.session_paths()) // 2]
        while time.monotonic() - t0 < a.seconds:
            if phase == "busy":
                k = len(got)
                t = time.monotonic()
                with open(target, "a") as fh:
                    fh.write('{"type":"custom-title","customTitle":"x","sessionId":"y"}\n')
                while len(got) == k and time.monotonic() - t < 5:
                    time.sleep(0.002)
                lat.append(time.monotonic() - t)
                time.sleep(max(0.0, 1.0 - (time.monotonic() - t)))
            else:
                time.sleep(0.2)
        wall = time.monotonic() - t0
        rate = lambda k: round((counts[k] - base[k]) / wall, 2)  # noqa: E731
        out[phase] = {"cpuPerSec": round((time.process_time() - c0) / wall, 4), "spawnPerSec": rate("spawn"), "statPerSec": rate("stat"),
                      "listPerSec": rate("list"), "openPerSec": rate("open"), "passesPerSec": rate("passes")}
        if lat:
            lat.sort()
            out[phase]["latencyMsMedian"], out[phase]["latencyMsMax"] = round(lat[len(lat) // 2] * 1000), round(lat[-1] * 1000)
    events.unsubscribe()
    print(json.dumps(out))


if __name__ == "__main__":
    main()
