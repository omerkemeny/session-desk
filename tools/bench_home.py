#!/usr/bin/env python3
"""Write a synthetic data folder shaped like ~/.claude for benchmarks: invented sessions only, sized by count and a few large files."""
import argparse
import glob
import json
import os
import subprocess
import time
import uuid

FILLER = "lorem ipsum dolor sit amet " * 8  # invented text, about 220 characters


def rec(kind, uid, parent, ts, cwd, content, mid=None):
    """One user or assistant record in the CLI's compact JSON line form."""
    r = {"parentUuid": parent, "isSidechain": False, "type": kind, "uuid": uid, "timestamp": ts, "userType": "external", "entrypoint": "cli",
         "cwd": cwd, "sessionId": "x", "gitBranch": "main"}
    if kind == "user":
        r["message"] = {"role": "user", "content": content}
    else:
        r["message"] = {"id": mid, "type": "message", "role": "assistant", "model": "model-x", "content": content,
                        "usage": {"input_tokens": 10, "output_tokens": 20, "cache_creation_input_tokens": 30, "cache_read_input_tokens": 40}}
    return json.dumps(r, separators=(",", ":")) + "\n"


def iso(t):
    """Epoch seconds to the CLI's UTC timestamp form."""
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))


def turn(fh, n, t, cwd, parent, result_chars):
    """Write one prompt, a tool call, its result and a reply; returns the last uuid."""
    u, a, r, a2 = (f"{n}-{k}-{uuid.uuid4().hex[:8]}" for k in "uarz")
    fh.write(rec("user", u, parent, iso(t), cwd, f"request {n} {FILLER}"))
    fh.write(rec("assistant", a, u, iso(t + 2), cwd, [{"type": "tool_use", "id": "tu" + a, "name": "Edit",
                                                         "input": {"file_path": f"{cwd}/f{n % 7}.py", "old_string": "a", "new_string": "b"}}], "m" + a))
    body = (FILLER * (result_chars // len(FILLER) + 1))[:result_chars]
    fh.write(rec("user", r, a, iso(t + 3), cwd, [{"type": "tool_result", "tool_use_id": "tu" + a, "content": body, "is_error": False}]))
    fh.write(rec("assistant", a2, r, iso(t + 9), cwd, [{"type": "text", "text": f"reply {n} {FILLER}"}], "m" + a2))
    return a2


def transcript(path, cwd, t0, turns, result_chars):
    """Write one transcript of `turns` turns starting at epoch t0."""
    with open(path, "w") as fh:
        fh.write(json.dumps({"type": "custom-title", "customTitle": f"bench {os.path.basename(path)[:8]}"}) + "\n")
        last = None
        for n in range(turns):
            last = turn(fh, n, t0 + n * 60, cwd, last, result_chars)


def build(out, count, big, big_mb, projects=40, turns=6, subagents=50, live=5):
    """Fill `out` with `count` transcripts across `projects` folders, `big` files of about big_mb MB, subagent files and live registry entries held by this process."""
    now = time.time()
    sids = []
    for i in range(count):
        sid = str(uuid.UUID(int=i + 1, version=4))
        proj = os.path.join(out, "projects", f"-bench-p{i % projects}")
        os.makedirs(proj, exist_ok=True)
        cwd = f"/bench/p{i % projects}"
        t0 = now - (i * 3600 * 24 * 60 / max(count, 1))  # spread over 60 days, newest first
        path = os.path.join(proj, sid + ".jsonl")
        if i < big:
            transcript(path, cwd, t0 - 7200, max(1, big_mb * 2**20 // 40_000), 39_000)
        else:
            transcript(path, cwd, t0, turns, 400)
        mt = now - i * 60
        os.utime(path, (mt, mt))
        sids.append((sid, path))
    for j in range(subagents):
        sid, path = sids[j % len(sids)]
        sub = os.path.join(path[:-6], "subagents")
        os.makedirs(sub, exist_ok=True)
        with open(os.path.join(sub, f"agent-{j}.meta.json"), "w") as fh:
            json.dump({"agentType": "Explore", "description": f"helper {j}", "finished": j % 2 == 0}, fh)
        transcript(os.path.join(sub, f"agent-{j}.jsonl"), "/bench/sub", now - 600, 2, 200)
    relive(out, live)
    return [s for s, _ in sids]


def proc_start(pid):
    """A process's start time as the CLI records it in procStart (`ps` lstart in UTC), or '' when ps cannot tell."""
    try:
        out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=5,
                             env={"TZ": "UTC", "LC_ALL": "C", "PATH": "/bin:/usr/bin"}).stdout
    except (OSError, subprocess.SubprocessError):
        return ""
    return " ".join(out.split())


def relive(out, live=5):
    """Point `live` registry entries (the first sessions by id) at this process with its real start time, so they list as live while it runs."""
    reg = os.path.join(out, "sessions")
    os.makedirs(reg, exist_ok=True)
    for old in glob.glob(os.path.join(glob.escape(reg), "*.json")):
        os.remove(old)
    first = sorted(glob.glob(os.path.join(glob.escape(out), "projects", "*", "*.jsonl")), key=os.path.basename)[:live]
    start = proc_start(os.getpid())
    for k, path in enumerate(first):
        with open(os.path.join(reg, f"{k}.json"), "w") as fh:
            json.dump({"pid": os.getpid(), "sessionId": os.path.basename(path)[:-6], "status": "idle", "statusUpdatedAt": int(time.time() * 1000),
                       "entrypoint": "cli", "procStart": start}, fh)


def main():
    """Command line: bench_home.py OUT --count 500 --big 3 --big-mb 50 --turns 6."""
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("out")
    ap.add_argument("--count", type=int, default=500)
    ap.add_argument("--big", type=int, default=3)
    ap.add_argument("--big-mb", type=int, default=50)
    ap.add_argument("--turns", type=int, default=6, help="turns in each ordinary transcript")
    ap.add_argument("--live", type=int, default=5, help="sessions listed as live (registry entries held by the writing process)")
    ap.add_argument("--subagents", type=int, default=50, help="subagent transcripts, spread over the first sessions")
    a = ap.parse_args()
    if os.path.realpath(a.out) == os.path.realpath(os.path.expanduser("~/.claude")):
        raise SystemExit("refusing to write into ~/.claude")
    build(a.out, a.count, a.big, a.big_mb, turns=a.turns, subagents=a.subagents, live=a.live)
    print(a.out)


if __name__ == "__main__":
    main()
