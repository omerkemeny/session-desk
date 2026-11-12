#!/usr/bin/env python3
"""Synthetic data folder of a given shape for scale tests: invented sessions only, realistic row mix, long-tailed sizes, live entries held by sleeping stub processes."""
import json
import math
import os
import random
import subprocess
import time
import uuid

WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango".split()
SHAPE_FILE = ".scale-shape.json"  # marks a finished folder and the shape it was built for


def sid_of(i):
    """Repeatable session id for index i."""
    return str(uuid.UUID(int=(0x5CA1E << 100) + i + 1, version=4))


def iso(t):
    """Epoch seconds to the CLI's UTC timestamp form."""
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))


def words(r, n):
    """n invented words."""
    return " ".join(r.choice(WORDS) for _ in range(n))


def _row(kind, uid, parent, ts, cwd, entry, extra):
    """One row record as compact JSON text."""
    d = {"parentUuid": parent, "isSidechain": False, "type": kind, "uuid": uid, "timestamp": ts, "userType": "external", "entrypoint": entry, "cwd": cwd,
         "sessionId": "x", "version": "2.1.322", "gitBranch": "main"}
    d.update(extra)
    return json.dumps(d, separators=(",", ":")) + "\n"


def turn(r, n, t, cwd, parent, result_chars, entry, auto):
    """One realistic turn: prompt, hook attachment, thinking, two parallel tool calls, results, reply, duration note and checkpoint; returns (text, last uuid)."""
    u = [f"{n}-{k}-{r.getrandbits(32):08x}" for k in range(9)]
    mid, mid2 = "msg" + u[2], "msg" + u[7]
    usage = {"input_tokens": 12, "output_tokens": 40, "cache_creation_input_tokens": 300, "cache_read_input_tokens": 9000}
    body = ("x" * result_chars) if result_chars > 4000 else words(r, max(1, result_chars // 6))
    prompt = f"request {n} " + words(r, 14)
    out = [
        _row("user", u[0], parent, iso(t), cwd, entry, {"message": {"role": "user", "content": prompt}, "turnOrigin": "sdk" if auto else "human"}),
        _row("attachment", u[1], u[0], iso(t), cwd, entry, {"attachment": {"type": "hook_success", "content": "ok"}}),
        _row("assistant", u[2], u[1], iso(t + 1), cwd, entry, {"message": {"id": mid, "type": "message", "role": "assistant", "model": "model-x",
                                                                         "content": [{"type": "thinking", "thinking": words(r, 20)}], "usage": usage}}),
        _row("assistant", u[3], u[2], iso(t + 2), cwd, entry, {"message": {"id": mid, "type": "message", "role": "assistant", "model": "model-x",
                                                                         "content": [{"type": "tool_use", "id": "tu" + u[3], "name": "Read", "input": {"file_path": f"{cwd}/f{n % 9}.py"}}], "usage": usage}}),
        _row("assistant", u[4], u[3], iso(t + 2), cwd, entry, {"message": {"id": mid, "type": "message", "role": "assistant", "model": "model-x",
                                                                         "content": [{"type": "tool_use", "id": "tu" + u[4], "name": "Bash", "input": {"command": "ls -la"}}], "usage": usage}}),
        _row("user", u[5], u[3], iso(t + 3), cwd, entry, {"message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu" + u[3], "content": body, "is_error": False}]}}),
        _row("user", u[6], u[4], iso(t + 3), cwd, entry, {"message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu" + u[4], "content": "a\nb", "is_error": False}]},
                                                         "toolUseResult": {"stdout": "a\nb", "stderr": "", "interrupted": False}}),
        _row("assistant", u[7], u[6], iso(t + 9), cwd, entry, {"message": {"id": mid2, "type": "message", "role": "assistant", "model": "model-x", "stop_reason": "end_turn",
                                                                         "content": [{"type": "text", "text": f"reply {n} " + words(r, 30)}], "usage": usage}}),
        _row("system", u[8], u[7], iso(t + 9), cwd, entry, {"subtype": "turn_duration", "durationMs": 9000}),
        json.dumps({"type": "last-prompt", "leafUuid": u[7], "lastPrompt": prompt, "sessionId": "x"}, separators=(",", ":")) + "\n",
    ]
    return "".join(out), u[8]


def transcript(path, r, cwd, t_end, size, auto):
    """Write one transcript of about `size` bytes whose last row is at t_end; returns bytes written."""
    entry = "sdk-cli" if auto else ("claude-desktop" if r.random() < 0.8 else "cli")
    result = int(min(39_000, max(200, size / 12)))
    per = 4600 + result  # bytes of one turn, roughly
    turns = max(1, int(size // per))
    t0, last, done = t_end - turns * 60, None, 0
    with open(path, "w") as fh:
        k = r.random()
        if not auto and k < 0.3:
            fh.write(json.dumps({"type": "custom-title", "customTitle": "scale " + words(r, 3), "sessionId": "x"}) + "\n")
        elif k < 0.7:
            fh.write(json.dumps({"type": "ai-title", "aiTitle": "auto " + words(r, 3), "sessionId": "x"}) + "\n")
        buf = []
        for n in range(turns):
            text, last = turn(r, n, t0 + n * 60, cwd, last, result, entry, auto)
            buf.append(text)
            done += len(text)
            if len(buf) >= 64:
                fh.write("".join(buf))
                buf = []
        fh.write("".join(buf))
    return done


def proc_starts(pids):
    """Start time of each pid as `ps` prints lstart in UTC (the registry's procStart form)."""
    out = subprocess.run(["ps", "-o", "pid=,lstart=", "-p", ",".join(map(str, pids))], capture_output=True, text=True,
                         env={"TZ": "UTC", "LC_ALL": "C", "PATH": "/bin:/usr/bin"}).stdout
    return {int(b[0]): " ".join(b[1].split()) for b in (ln.split(None, 1) for ln in out.splitlines()) if len(b) == 2 and b[0].isdigit()}


def plan(n, live, big_mb, seed=7, median_kb=20, sigma=1.5, tail_cap_mb=8):
    """Sizes in bytes per session index (index 0 newest): the first non-live session is the biggest, a long tail below it."""
    r = random.Random(seed)
    sizes = [int(min(tail_cap_mb * 2**20, max(3000, r.lognormvariate(math.log(median_kb * 1024), sigma)))) for _ in range(n)]
    if n > live:
        sizes[live] = big_mb * 2**20
    return sizes


def build(home, n, live, waiting, big_mb, projects, subagents, auto_frac=0.6, seed=7, median_kb=20):
    """Write the folder (transcripts, subagents); live entries are written by `relive`. Returns a shape dict with the ids the measures need."""
    r = random.Random(seed)
    now = time.time()
    sizes = plan(n, live, big_mb, seed, median_kb)
    span = 90 * 86400
    total, out = 0, {"n": n, "live": live, "waiting": waiting, "bigMb": big_mb, "projects": projects, "subagents": subagents, "autoFrac": auto_frac}
    for i in range(n):
        p = i % projects
        cwd = f"/scale/p{p}"
        proj = os.path.join(home, "projects", f"-scale-p{p}")
        os.makedirs(proj, exist_ok=True)
        path = os.path.join(proj, sid_of(i) + ".jsonl")
        mt = now - 30 if i < live else now - 120 if i == live else now - 600 - (i - live) * span / max(1, n)
        auto = i > live and r.random() < auto_frac
        total += transcript(path, r, cwd, mt, sizes[i], auto)
        os.utime(path, (mt, mt))
    for j in range(subagents):
        i = j % max(1, min(n, max(live, 1) * 2))
        proj = os.path.join(home, "projects", f"-scale-p{i % projects}")
        sub = os.path.join(proj, sid_of(i), "subagents")
        os.makedirs(sub, exist_ok=True)
        with open(os.path.join(sub, f"agent-a{j:05x}.meta.json"), "w") as fh:
            json.dump({"agentType": "Explore", "description": f"helper {j}", "finished": j >= live}, fh)
        total += transcript(os.path.join(sub, f"agent-a{j:05x}.jsonl"), r, "/scale/sub", now - 60, 8000, False)
    out["bytes"] = total
    out["ids"] = {"live": sid_of(0), "big": sid_of(live) if n > live else sid_of(0), "recent": sid_of(min(n - 1, live + 2)), "cold": sid_of(n - 1)}
    done = sorted(range(live + 1, n), key=lambda k: sizes[k])
    out["ids"]["median"] = sid_of(done[len(done) // 2]) if done else sid_of(0)
    out["ids"]["small"] = sid_of(done[0]) if done else sid_of(0)
    with open(os.path.join(home, SHAPE_FILE), "w") as fh:
        json.dump(out, fh)
    return out


def relive(home, live, waiting):
    """Start `live` sleeping stub processes and point registry entries at them (the first `waiting` idle, the rest busy); returns the processes."""
    reg = os.path.join(home, "sessions")
    os.makedirs(reg, exist_ok=True)
    for f in os.listdir(reg):
        os.remove(os.path.join(reg, f))
    procs = [subprocess.Popen(["/bin/sleep", "86400"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(live)]
    starts = proc_starts([p.pid for p in procs]) if procs else {}
    now = int(time.time() * 1000)
    for k, p in enumerate(procs):
        with open(os.path.join(reg, f"{p.pid}.json"), "w") as fh:
            json.dump({"pid": p.pid, "sessionId": sid_of(k), "status": "idle" if k < waiting else "busy", "statusUpdatedAt": now - k * 1000,
                       "entrypoint": "claude-desktop", "procStart": starts.get(p.pid, "")}, fh)
    return procs
