"""Usage statistics for the Stats panel: per-file numbers counted in a background thread, cached on disk as counts and ids only."""
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from collections import Counter
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from . import config, durable, transcripts as tx

IL = ZoneInfo("Asia/Jerusalem")  # every day, hour and weekday in the stats is Israel time
STATS_VER = 1
STATS_TTL = 60  # seconds a finished result is served before the next refresh starts
IDLE_CAP = 1800  # a gap inside a turn longer than this (a permission prompt left overnight) counts as this many seconds
PR_CMD = re.compile(r"(?:^|[;&|\s(])gh pr create\b")
COMMIT_CMD = re.compile(r"\bgit\b[^|;&\n]*\bcommit\b")
PR_URL = re.compile(r"https://github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)")
PROGRESS_EVERY = 50  # files between progress lines from the worker
# Kept across code reloads so a running refresh and the last result survive.
_stats = globals().get("_stats") or {"proc": None, "result": None, "busy": False, "done": 0, "total": 0, "at": 0.0, "error": ""}
_stats_lock = globals().get("_stats_lock") or threading.Lock()
ENTRY = (("key", list), ("sub", bool), ("proj", str), ("entry", str), ("remember", bool), ("msgs", dict), ("prompts", dict), ("prs", dict), ("t0", int))  # cached entry shape


def _hid(s):
    """Short one-way id for an edited file path or a PR link, so neither is stored."""
    return hashlib.sha1(str(s).encode()).hexdigest()[:12]


def stat_file(path):
    """Numbers of one transcript: assistant messages with usage and tools, prompts with turn times, PRs opened."""
    out = {"sub": tx.is_subagent(path), "proj": "", "entry": "", "remember": False, "msgs": {}, "prompts": {}, "prs": {}, "t0": 0}
    msgs, prompts = out["msgs"], out["prompts"]
    seen, pending, plan, ticked, turn = set(), {}, [], set(), None

    def close():
        """Store the open turn: start, busy seconds to the last reply (-1 when none), answered, memory-save run."""
        if turn:
            prompts[turn[0]] = [int(turn[1]), int(turn[3]) if turn[6] else -1, turn[4], turn[5]]

    for r in tx.records(path, kinds=("user", "assistant"), results_for=pending):
        kind, t = r.kind, r.epoch
        if t is None:
            continue
        out["proj"] = out["proj"] or os.path.basename(r.cwd.rstrip("/"))
        out["t0"] = min(out["t0"] or t, t)
        parts, main = r.parts(), not r.sidechain
        if kind == "assistant":
            mid = r.msg_id or r.uuid or str(t)
            rec = msgs.setdefault(mid, [int(t), "", 0, 0, 0, 0, {}, 0, [], 0])
            rec[1] = r.model or rec[1]
            u = r.usage()
            if u is not None:
                rec[2:6] = [max(rec[2 + i], u[k]) for i, k in enumerate(tx.USAGE_KEYS)]
            if turn and main:
                turn[2], turn[3], turn[6] = t, turn[3] + min(max(0, t - turn[2]), IDLE_CAP), 1
            for part in parts:
                if part[0] == "text" and part[1].strip() and turn and main:
                    turn[4] = 1
                if part[0] != "tool" or not part[1] or part[1] in seen:
                    continue
                _, tid, name, inp = part
                seen.add(tid)
                rec[6][name] = rec[6].get(name, 0) + 1
                f = tx.edited_file(name, inp, notebooks=True)
                if f:
                    rec[8].append(_hid(f))
                cmd = tx.shell_command(name, inp)
                if PR_CMD.search(cmd):
                    pending[tid] = ("pr", mid, int(t))
                elif tx.opens_pr_tool(name):
                    pending[tid] = ("mcppr", mid, int(t))
                elif COMMIT_CMD.search(cmd):
                    pending[tid] = ("commit", mid, int(t))
                rec[7] += tx.plan_step(plan, ticked, name, inp)
            continue
        results = [p for p in parts if p[0] == "result"]
        for _, tid, text, err in results:
            if tid not in pending:
                continue
            what, mid, when = pending.pop(tid)
            if err or "already exists" in text:
                continue
            if what == "commit" and mid in msgs:
                msgs[mid][9] += 1
            urls = PR_URL.findall(text) if what == "pr" else [(tid, "")]
            if what != "commit" and urls:
                k = _hid("/".join(urls[-1]))
                out["prs"][k] = min(out["prs"].get(k, when), when)
        if results or not main:
            continue
        label, remember = tx.prompt_kind(r)
        if label == "meta":
            out["remember"] = out["remember"] or remember
        elif label == "interrupt":
            if turn:
                turn[4] = 0
            close()
            turn = None
        elif label == "end":
            close()
            turn = None
        elif label == "prompt":
            close()
            turn = [(r.uuid or str(t)).replace("-", "")[:12], t, t, 0, 0, int(remember), 0]
            out["entry"] = out["entry"] or r.entry
    close()
    out["t0"] = int(out["t0"])
    return out


def _pct(xs, q):
    """Nearest-rank percentile of a sorted list, 0 when empty."""
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else 0


def _summary(cut, P, M, S, R, PR):
    """Totals for one period: every list item starts with its Israel day, kept when on or after cut."""
    p, m, s = [x for x in P if x[0] >= cut], [x for x in M if x[0] >= cut], [x for x in S if x[0] >= cut]
    tools, models, mtok, files = Counter(), Counter(), Counter(), set()
    for x in m:
        for name, n in x[6].items():
            tools[tx.short_tool(name)] += n
        if x[1]:
            models[x[1]] += 1
            mtok[x[1]] += x[2] + x[3] + x[4]
        files.update(x[8])
    turns, act = sorted(x[3] for x in p if x[3] >= 0), sorted(x[1] for x in s)
    hours, days = [0] * 24, [0] * 7
    for x in p:
        hours[x[1]] += 1
        days[x[2]] += 1
    big = max(s, key=lambda x: x[1], default=None)
    entry = Counter({"claude-desktop": "desktop", "cli": "terminal"}.get(x[3], "other") for x in s)
    return {
        "sessions": len(s), "memoryRuns": sum(1 for d in R if d >= cut), "prompts": len(p), "answered": sum(1 for x in p if x[4]),
        "planDone": sum(x[7] for x in m), "prs": sum(1 for d in PR if d >= cut), "commits": sum(x[9] for x in m),
        "tokens": {"input": sum(x[2] for x in m), "output": sum(x[3] for x in m), "cacheWrite": sum(x[4] for x in m), "cacheRead": sum(x[5] for x in m)},
        "models": [[k, n, mtok[k]] for k, n in models.most_common(5)],
        "turn": {"median": _pct(turns, .5), "p90": _pct(turns, .9), "n": len(turns)},
        "active": {"median": _pct(act, .5), "total": sum(act)},
        "longest": {"active": big[1], "project": big[2], "day": big[0]} if big else None,
        "tools": tools.most_common(6), "toolCalls": sum(tools.values()), "filesEdited": len(files),
        "commands": tools[tx.RUN_TOOL], "subagents": sum(tools[a] for a in tx.AGENT_TOOLS),
        "hours": hours, "weekdays": days, "projects": Counter(x[2] for x in s).most_common(5),
        "entry": {k: entry[k] for k in ("desktop", "terminal", "other")},
    }


def stats_build(files, now=None):
    """Merge per-file numbers into period totals, a per-day series and streaks; a message or prompt copied into a forked session counts once."""
    msgs, prs, sess, runs, prompts, seen = {}, {}, [], [], [], set()
    for f in sorted(files.values(), key=lambda f: f["t0"]):
        for mid, m in f["msgs"].items():
            msgs.setdefault(mid, m)
        for k, t in f["prs"].items():
            prs[k] = min(prs.get(k, t), t)
        if f["sub"]:
            continue
        own = [p for k, p in f["prompts"].items() if k not in seen]
        seen.update(f["prompts"])
        if any(not p[3] for p in own):
            sess.append((min(p[0] for p in own), sum(p[1] for p in own if p[1] > 0), f["proj"] or "unknown", f["entry"]))
            prompts += own
        elif own or (f["remember"] and not f["prompts"]):
            runs.append(f["t0"])
    local = {}

    def at(t):
        """Israel day, hour and weekday of an epoch second."""
        if t not in local:
            d = datetime.fromtimestamp(t, IL)
            local[t] = (d.date().isoformat(), d.hour, d.weekday())
        return local[t]

    P = [(*at(p[0]), p[1], p[2]) for p in prompts]
    M = [(at(m[0])[0], *m[1:]) for m in msgs.values()]
    S = [(at(x[0])[0], *x[1:]) for x in sess]
    R, PR = [at(t)[0] for t in runs], [at(t)[0] for t in prs.values()]
    today = datetime.fromtimestamp(now if now is not None else time.time(), IL).date()
    cuts = {"today": today, "7d": today - timedelta(days=6), "30d": today - timedelta(days=29), "all": date.min}
    per = {}
    for x in S:
        per.setdefault(x[0], [0, 0, 0, 0])[0] += 1
    for x in P:
        per.setdefault(x[0], [0, 0, 0, 0])[1] += 1
    for x in M:
        row = per.setdefault(x[0], [0, 0, 0, 0])
        row[2] += x[2] + x[3] + x[4]
        row[3] += x[3]
    first = date.fromisoformat(min(per)) if per else today
    series = [[(first + timedelta(days=i)).isoformat(), *per.get((first + timedelta(days=i)).isoformat(), [0, 0, 0, 0])] for i in range((today - first).days + 1)]
    active = {x[0] for x in P}
    cur, d = 0, today if today.isoformat() in active else today - timedelta(days=1)
    while d.isoformat() in active:
        cur, d = cur + 1, d - timedelta(days=1)
    best = run = 0
    for row in series:
        run = run + 1 if row[2] else 0
        best = max(best, run)
    return {
        "today": today.isoformat(), "since": first.isoformat(), "tz": "Asia/Jerusalem", "computedAt": int(time.time() * 1000),
        "periods": {k: _summary(c.isoformat() if c != date.min else "", P, M, S, R, PR) for k, c in cuts.items()},
        "days": series, "streak": {"current": cur, "longest": best},
    }


def _valid(f):
    """True when a cached per-file entry has the shape stats_build reads; anything else is recounted."""
    return (isinstance(f, dict) and all(isinstance(f.get(k), t) for k, t in ENTRY) and len(f["key"]) == 2
            and all(isinstance(m, list) and len(m) == 10 and isinstance(m[6], dict) and isinstance(m[8], list) for m in f["msgs"].values())
            and all(isinstance(p, list) and len(p) == 4 for p in f["prompts"].values()))


def stats_load():
    """Valid per-file numbers saved by an earlier run; {} when missing, unreadable or from another version."""
    path = config.stats_file()
    durable.drop_stale_temps(path)
    try:
        with open(path) as fh:
            data = json.load(fh)
        files = data["files"] if data.get("v") == STATS_VER and isinstance(data.get("files"), dict) else {}
    except (OSError, ValueError, KeyError, AttributeError):
        return {}
    return {p: f for p, f in files.items() if _valid(f)}


def stats_save(files):
    """Write the per-file numbers atomically (one writer at a time, synced temp file, rename), so a crash leaves the old or the new file whole."""
    try:
        durable.write(config.stats_file(), json.dumps({"v": STATS_VER, "files": files}, separators=(",", ":")).encode())
    except OSError:
        pass


def update(files, paths, tick=lambda done, total: None):
    """Per-file numbers for paths: cached ones whose mtime and size still match, the rest recounted; returns (numbers, changed)."""
    fresh, changed = {}, False
    for i, p in enumerate(paths):
        try:
            st = os.stat(p)
            key = [st.st_mtime_ns, st.st_size]
            hit = files.get(p)
            if hit and hit.get("key") == key:
                fresh[p] = hit
            else:
                fresh[p], changed = dict(stat_file(p), key=key), True
        except Exception:
            pass
        tick(i + 1, len(paths))
    return fresh, changed or len(fresh) != len(files)


def batch(home, cache, out=sys.stdout):
    """Worker process body: bring the cache file up to date for one data folder, print progress lines, then the result as JSON."""
    config.HOME, config.STATS_FILE = home, cache
    files = stats_load()
    paths = tx.all_paths()
    print(f"progress 0 {len(paths)}", file=out, flush=True)
    fresh, changed = update(files, paths, lambda d, t: (d % PROGRESS_EVERY == 0 or d == t) and print(f"progress {d} {t}", file=out, flush=True))
    result = stats_build(fresh)
    if changed:
        stats_save(fresh)
    print("result " + json.dumps(result, separators=(",", ":")), file=out, flush=True)


def _read_worker(proc):
    """Follow a worker's output: progress into _stats; returns the result, or None when it ended without one."""
    result = None
    for line in proc.stdout:
        kind, _, rest = line.rstrip("\n").partition(" ")
        if kind == "progress":
            _stats["done"], _stats["total"] = (int(x) for x in rest.split())
        elif kind == "result":
            result = json.loads(rest)
    return result


def stats_refresh():
    """Count in a worker process, so the memory a large count needs goes back to the system when it ends; keeps progress and the result."""
    try:
        cmd = [sys.executable, "-m", __name__, config.HOME, config.stats_file()]
        with subprocess.Popen(cmd, cwd=config.HERE, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True) as proc:
            _stats["proc"] = proc
            result = _read_worker(proc)
        if result is None:
            raise RuntimeError(f"stats worker ended with code {proc.returncode}")
        _stats["result"], _stats["error"] = result, ""
        _stats["runs"] = _stats.get("runs", 0) + 1
    except Exception as e:
        _stats["error"] = str(e)[:200]
        _stats.update(errors=_stats.get("errors", 0) + 1, errorType=type(e).__name__, errorAt=int(time.time() * 1000))
    finally:
        _stats["at"], _stats["busy"], _stats["proc"] = time.time(), False, None


def worker_status():
    """Stats worker for health: running, finished runs, failures, and the last failure's type and time (no message text)."""
    proc = _stats.get("proc")
    return {"running": proc is not None and proc.poll() is None, "runs": _stats.get("runs", 0), "errors": _stats.get("errors", 0),
            "lastError": _stats.get("errorType") if _stats["error"] else None, "lastErrorAt": _stats.get("errorAt")}


def stop_worker(wait=2.0):
    """End a running worker (server shutdown); its cache write is atomic, so a cut never leaves a broken file."""
    proc = _stats.get("proc")
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(wait)
        except subprocess.TimeoutExpired:
            proc.kill()


def stats():
    """Latest usage numbers, returned at once; starts a background refresh when none runs and the last is over STATS_TTL old."""
    with _stats_lock:
        go = not _stats["busy"] and time.time() - _stats["at"] > STATS_TTL
        if go:
            _stats["busy"] = True
    if go:
        threading.Thread(target=stats_refresh, daemon=True).start()
    res, prog = _stats["result"], {"done": _stats["done"], "total": _stats["total"]}
    if res is None:
        return {"ready": False, "updating": _stats["busy"], "progress": prog, "error": _stats["error"]}
    return dict(res, ready=True, updating=_stats["busy"], progress=prog)


if __name__ == "__main__":
    batch(sys.argv[1], sys.argv[2])
