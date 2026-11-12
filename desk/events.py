"""Change feed: one shared background thread compares a cheap signature of everything the session list depends on and bumps a counter.
Kernel notifications (kqueue) wake it at once where available; the timed pass stays as the safety net and is the only mechanism elsewhere."""
import hashlib
import json
import math
import os
import sys
import threading
import time

from . import config, liveness, terms, transcripts as tx, watch

INTERVAL = 1.0  # seconds between signature checks (the safety net when the kernel watches)
GAP = 0.3  # seconds at least between two change events to one listener; the first change after a quiet spell goes out at once, the last one is never dropped
SETTLE = 0.02  # seconds a kernel wake waits so one burst of writes is one pass
FULL_WATCHED = 60  # seconds between full scans when the kernel watches every transcript and folder
HISTORY = 64  # change records kept to tell a listener which sessions changed
MAX_IDS = 100  # more changed sessions than this are sent as `all`
KEEPALIVE = 5  # seconds between keep-alive comments on an idle stream
CHECK = 1.0  # seconds between checks that a listener is still connected
MAX_CLIENTS = 8  # a page needs one; more get 503
HOT = 600  # seconds: transcripts changed this recently, and those of live sessions, are checked on every pass
FULL = 10  # seconds between full scans of every transcript; folder changes (added or removed files) also force one
CYCLE = 1.0  # seconds in which the rotating pass stats every transcript the kernel does not watch, a slice per pass
ROTATE_MAX = 6000  # transcripts the rotation stats per second at most (about 2 % of a core, measured at 20,000 sessions): past MAX_FDS + this many, a cycle takes longer
ROTATE_RECENT = 3 * 86400  # seconds: unwatched transcripts changed this recently form the fast tier, checked every CYCLE before the older ones
ROTATE_FAST = 2000  # most transcripts in the fast tier (newest first), so the older tier keeps at least ROTATE_MAX - this many checks a second
WARM = 6 * 3600  # seconds: transcripts changed this recently are watched right after live ones
FRESH = 2.5  # seconds a pass's view of file keys and holders is offered to the list routes
# Kept across code reloads: connected clients and the thread must not be forgotten.
_feed = globals().get("_feed") or {"cond": threading.Condition(), "clients": 0, "count": 0, "sig": None, "thread": None, "error": "", "log": [], "watch": None}
# Known transcript (mtime, size) keys with an order-free running digest, so a pass costs only what it checks; `changed` collects paths whose key moved,
# `parts` the per-session state of the last pass, `watched` what the kernel watches, `order` the paths to watch by priority.
_scan = globals().get("_scan") or {"at": 0.0, "dirs": None, "files": {}, "acc": 0, "hot": set(), "home": None}
for _k, _v in (("changed", set()), ("parts", None), ("watched", set()), ("order", []), ("kernel", False), ("woke", set())):
    _scan.setdefault(_k, _v)


def _key(path):
    """(mtime_ns, size, inode, ctime_ns) of a file, the data module's stat key, or None when it is gone."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return st.st_mtime_ns, st.st_size, st.st_ino, st.st_ctime_ns


def _mix(path, key):
    """64-bit digest of one transcript entry; entries combine by XOR, so order does not matter."""
    return int.from_bytes(hashlib.sha1(f"{path}\0{key}".encode()).digest()[:8], "big")


def _note(path, key, recent):
    """Record a transcript's key (None forgets it), keep the running digest, and mark it hot when it changed recently."""
    s = _scan
    old = s["files"].get(path)
    if old == key:
        return
    s["changed"].add(path)
    if old is not None:
        s["acc"] ^= _mix(path, old)
    if key is None:
        s["files"].pop(path, None)
        s["hot"].discard(path)
        return
    s["files"][path] = key
    s["acc"] ^= _mix(path, key)
    if key[0] >= recent:
        s["hot"].add(path)


def _full_scan(now):
    """Check every transcript; remember their folders so an added or removed file forces the next full scan."""
    s, recent = _scan, int((now - HOT) * 1e9)
    paths = set(tx.session_paths())
    for p in [p for p in s["files"] if p not in paths]:
        _note(p, None, recent)
    for p in paths:
        _note(p, _key(p), recent)
    s["hot"] = {p for p in s["hot"] if p in s["files"] and s["files"][p][0] >= recent}
    folders = {os.path.dirname(p) for p in paths}
    folders |= {os.path.dirname(d) for d in folders} | {os.path.join(config.HOME, "projects"), os.path.join(config.HOME, "sessions")}
    s["dirs"], s["at"], s["rotat"] = {d: _key(d) for d in folders}, now, now
    s["order"] = sorted(paths, key=lambda p: -s["files"].get(p, (0, 0))[0])
    s["wlist"] = s["cold"] = None  # the watch list and the rotation are rebuilt


def transcripts_digest(live_paths):
    """Digest of every transcript's mtime and size: a full scan every FULL seconds or on a folder change, else only hot and live files."""
    s, now = _scan, time.time()
    if s["home"] != config.HOME:
        s.update(at=0.0, dirs=None, files={}, acc=0, hot=set(), home=config.HOME, parts=None, watched=set(), order=[], woke=set(), wlist=None, seen=set(), complete=False, cold=None, live=None, pubkeys=None)
    kernel, watched, woke = s["kernel"], s["watched"], s["woke"]
    s["woke"] = set()
    every = FULL_WATCHED if kernel and s["dirs"] is not None else FULL  # with the kernel, folder notes and the rotation cover what is not watched
    if (s["dirs"] is None or now - s["at"] >= every or any(d in woke for d in s["dirs"])
            or any(_key(d) != k for d, k in s["dirs"].items() if not kernel or d not in watched)):
        _full_scan(now)
    else:
        recent = int((now - HOT) * 1e9)
        for p in s["hot"] | live_paths | {p for p in woke if p in s["files"]}:
            if not kernel or p in woke or p not in watched:  # a watched file that sent no note is unchanged
                _note(p, _key(p), recent)
        _rotate(now, kernel, watched, live_paths, recent)
    return f"{s['acc']:016x}"


def _rotate(now, kernel, watched, live_paths, recent):
    """Stat the next slice of unwatched transcripts: the fast tier within CYCLE, the older tier with the rest of ROTATE_MAX; positions survive watch changes."""
    s = _scan
    if s.get("cold") is None:
        s["cold"] = _tiers(now)
    dt, s["rotat"] = max(0.0, now - s.get("rotat", now)), now
    fast, slow = s["cold"]
    skip = s["hot"] | live_paths | (watched if kernel else set())
    budget = max(1, math.ceil(ROTATE_MAX * dt))
    budget -= _sweep(fast, "rotf", math.ceil(len(fast) * dt / CYCLE), budget, skip, recent)
    _sweep(slow, "rot", math.ceil(len(slow) * dt / CYCLE), max(1, budget), skip, recent)


def _tiers(now):
    """Known transcripts as (fast, slow) rotation tiers: those changed within ROTATE_RECENT newest first, then the rest; watched ones are skipped per pass."""
    files, cut = _scan["files"], int((now - ROTATE_RECENT) * 1e9)
    newest = sorted((p for p in files if files[p][0] >= cut), key=lambda p: -files[p][0])[:ROTATE_FAST]
    fast = set(newest)
    return newest, [p for p in files if p not in fast]


def _sweep(tier, pos, visits, stats, skip, recent):
    """Walk up to `visits` entries of one tier from its saved position, statting at most `stats` of them (skipped ones are free); returns stats used."""
    s, files, used = _scan, _scan["files"], 0
    if not tier:
        return 0
    i, n = s.get(pos, 0) % len(tier), min(len(tier), max(1, visits))
    k = 0
    while k < n and used < stats:
        p = tier[(i + k) % len(tier)]
        k += 1
        if p in skip or p not in files:
            continue
        used += 1
        key = _key(p)
        if key != files[p]:
            _note(p, key, recent)
            s["wlist"] = None  # a cold file woke: watch it from now on
    s[pos] = (i + k) % len(tier)
    return used


def signature():
    """Digest of transcript mtimes and sizes, live registry entries, running subagents, page terminals and replies."""
    return snapshot()[0]


def snapshot():
    """(digest, ids of sessions whose state moved since the last pass, whether that set is unknown): what the change feed compares."""
    s = _scan
    kernel, watched, woke = s["kernel"], s["watched"], s["woke"]
    hold, own, replies = liveness.holders(kernel, watched, woke), dict(terms._terms), dict(terms._replies)
    paths = {sid: _find(sid, kernel, watched, woke) for sid in set(hold) | set(own) | set(replies) if isinstance(sid, str)}
    first = s["parts"] is None or s["home"] != config.HOME
    live = frozenset(p for p in paths.values() if p)
    s["changed"] = set()
    h = hashlib.sha1(transcripts_digest(set(live)).encode())
    if live != s.get("live"):
        s["live"], s["wlist"] = live, None
    parts = {}
    for sid in sorted(hold, key=str):
        parts[sid] = repr((sid, sorted((p["pid"], str(p["status"]), p["at"], str(p["name"]), p["entry"]) for p in hold[sid])))
        if paths.get(sid):
            parts[sid] += repr(liveness.helpers(paths[sid], kernel, watched, woke))
    liveness.forget({paths[sid] for sid in hold if paths.get(sid)})
    for sid in sorted(own):
        parts[sid] = parts.get(sid, "") + repr((sid, terms.term_alive(sid), own[sid].t0))
    for sid in sorted(replies):
        r = replies[sid]
        parts[sid] = parts.get(sid, "") + repr((sid, terms.reply_state(sid), r.get("done_at"), r.get("error")))
    for sid in sorted(parts, key=str):
        h.update(parts[sid].encode())
    old = s["parts"] or {}
    ids = {tx.session_id(p) for p in s["changed"]} | {k for k in set(parts) | set(old) if parts.get(k) != old.get(k)}
    s["parts"] = parts
    if s.get("pubacc") != s["acc"] or s.get("pubkeys") is None:
        s["pubkeys"], s["pubacc"] = dict(s["files"]), s["acc"]  # copied only when a key moved; readers never see it change
    s["pending"] = (config.HOME, s["pubkeys"], hold)
    return h.hexdigest(), {str(i) for i in ids}, first


def _find(sid, kernel, watched, woke):
    """Transcript path of a session; a path the kernel watches and that sent no note is reused without a stat."""
    found = _scan.setdefault("found", {})
    p = found.get(sid)
    if p is None or not (kernel and p in watched and p not in woke and p in _scan["files"]):
        p = found[sid] = tx.find(sid)
        if len(found) > 4 * HISTORY:
            found.clear()
    return p


def watch_list():
    """Paths the kernel should watch, by what a person looks at: live transcripts, their registry files, transcripts changed in the last WARM
    seconds, the registry and projects folders, project folders, subagent paths, then older transcripts newest first."""
    s, files = _scan, _scan["files"]
    reg, proj = os.path.join(config.HOME, "sessions"), os.path.join(config.HOME, "projects")
    live = sorted(p for p in s.get("live") or () if p in files)
    cut = int((time.time() - WARM) * 1e9)
    order = [p for p in s["order"] if p in files]
    warm, rest = sorted((p for p in order if files[p][0] >= cut), key=lambda p: -files[p][0]), [p for p in order if files[p][0] < cut]
    dirs = sorted(d for d in s["dirs"] or () if d not in (reg, proj))
    return list(dict.fromkeys(live + liveness.registry_watch() + warm + [reg, proj] + dirs + liveness.watch_paths() + rest))


def record(f, ids, unknown):
    """Remember which sessions the newest counter step changed (caller holds the condition)."""
    f["log"] = (f.get("log") or [])[-(HISTORY - 1):] + [(f["count"], frozenset(ids), unknown)]


def changes(since, upto, f=None):
    """Session ids changed between two counter values, and whether the set is complete; unknown when the history does not reach back."""
    f = f or _feed
    with f["cond"]:
        log = [e for e in (f.get("log") or []) if since < e[0] <= upto]
    if len(log) != upto - since or any(e[2] for e in log):
        return [], True
    ids = sorted(set().union(*(e[1] for e in log))) if log else []
    return (ids, False) if len(ids) <= MAX_IDS else ([], True)


def _loop(f=_feed, name=__name__, modules=sys.modules, sleep=time.sleep, me=threading.current_thread):
    """Check the signature on every kernel wake and at least once a second while anyone listens; no exception ends it, only the last client leaving does."""
    while True:
        interval, mod, ids, unknown = 1.0, None, set(), True
        try:
            mod = modules[name]  # the current code, even after a reload
            interval = getattr(mod, "INTERVAL", 1.0)
            sig, ids, unknown = mod.snapshot()
            f["error"] = ""
        except Exception as e:
            sig, f["error"] = f["sig"], f"{type(e).__name__}: {e}"[:200]
            f.update(errors=f.get("errors", 0) + 1, errorType=type(e).__name__, errorAt=int(time.time() * 1000))
        try:
            with f["cond"]:
                if sig != f["sig"]:
                    if f["sig"] is not None:
                        f["count"] += 1
                        record(f, ids, unknown) if mod is None else mod.record(f, ids, unknown)
                        f["cond"].notify_all()
                    f["sig"] = sig
                pend = _scan.pop("pending", None) if mod is not None and not f["error"] else None
                f["pub"] = None if pend is None else {"n": f["count"], "home": pend[0], "keys": pend[1], "hold": pend[2], "at": time.monotonic()}
                if f["clients"] <= 0:
                    if f["thread"] is me():
                        f["thread"], f["sig"] = None, None
                        _close_watch(f)
                    return
        except Exception as e:
            f["error"] = f"{type(e).__name__}: {e}"[:200]
        try:
            woke = mod.kernel_wait(f, interval) if mod is not None and hasattr(mod, "kernel_wait") else None
        except Exception as e:
            f["error"], woke = f"{type(e).__name__}: {e}"[:200], None
            _close_watch(f)
        if woke is None:
            sleep(interval)


def kernel_wait(f, timeout):
    """Wait for a kernel notification or the timeout; None where the kernel does not watch (the caller sleeps instead)."""
    s = _scan
    if not watch.available():
        s["kernel"] = False
        return None
    if f.get("watch") is None:
        f["watch"] = watch.Watch()
    w, before = f["watch"], s["watched"]
    reg = os.path.join(config.HOME, "sessions")
    s["kernel"] = True
    if s.get("wlist") is None or reg in s.get("seen", ()) or s.get("lver") != liveness.version():
        s["lver"] = liveness.version()
        s["wlist"] = watch_list()
        s["watched"] = w.want(s["wlist"])
        s["complete"] = len(s["watched"]) == len(s["wlist"])
    elif len(w.fds) < len(s["watched"]):
        s["watched"] = w.want(s["wlist"])  # a watched inode left its path: watch the path again
    fresh = {d for d in s["watched"] - before if s["dirs"] and d in s["dirs"]}
    if fresh and before:
        s["woke"] = s["seen"] = fresh  # a folder watched only now may have gained files before its watch began: scan once more
        return fresh
    woke = w.wait(timeout)
    if woke:
        time.sleep(SETTLE)
        woke |= w.wait(0)
    woke |= s["watched"] - before  # a path watched only now may have changed before its watch began: check it once
    s["woke"] = s["seen"] = woke
    return woke


def _close_watch(f):
    """Release the kernel watch when the feed thread stops."""
    w = f.get("watch")
    f["watch"] = None
    _scan["kernel"], _scan["watched"], _scan["cold"] = False, set(), None
    if w is not None:
        try:
            w.close()
        except OSError:
            pass


def subscribe():
    """Register a listener and make sure the shared thread runs; returns the current counter, or None when MAX_CLIENTS listen already."""
    f = _feed
    with f["cond"]:
        if f["clients"] >= MAX_CLIENTS:
            return None
        f["clients"] += 1
        t = f["thread"]
        if t is None or not t.is_alive():
            f["thread"] = threading.Thread(target=_loop, daemon=True, name="desk-events")
            f["thread"].start()
        return f["count"]


def unsubscribe():
    """Drop a listener; the thread stops by itself once none are left."""
    with _feed["cond"]:
        _feed["clients"] -= 1


def wait(last, timeout=None):
    """Block until the counter moves past `last` or the timeout (default KEEPALIVE) passes; returns the counter."""
    f = _feed
    with f["cond"]:
        f["cond"].wait_for(lambda: f["count"] != last, KEEPALIVE if timeout is None else timeout)
        return f["count"]


def list_inputs():
    """What the feed's last pass saw, for the list routes: {n, keys, hold} with the counter it is valid for, the transcript stat keys
    (path -> (mtime_ns, size, inode, ctime_ns)) and the map equal to `sessions.holders()`; None when no pass ran within FRESH seconds."""
    pub = _feed.get("pub")
    if not pub or pub["home"] != config.HOME or time.monotonic() - pub["at"] > FRESH or not status()["running"]:
        return None
    return {"n": pub["n"], "keys": pub["keys"], "hold": {sid: [dict(p) for p in procs] for sid, procs in pub["hold"].items()}}


def status():
    """Listeners, the cap, whether the shared thread runs, and its last error."""
    f = _feed
    t = f["thread"]
    return {"clients": f["clients"], "max": MAX_CLIENTS, "running": bool(t and t.is_alive()), "error": f["error"]}


def fds():
    """Descriptor budget for health: open now, the soft limit, and how many the kernel watch holds."""
    w = _feed.get("watch")
    try:
        import resource
        soft = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
        soft = -1 if soft == resource.RLIM_INFINITY else soft
    except (ImportError, OSError, ValueError):
        soft = -1
    n = watch.open_fds()
    return {"open": -1 if n is None else n, "limit": soft, "watches": len(w.fds) if w is not None else 0}


def worker_status():
    """Change-feed thread for health: running, failed passes, and the last failure's type and time (no message text)."""
    f = _feed
    t = f["thread"]
    return {"running": bool(t and t.is_alive()), "errors": f.get("errors", 0), "lastError": f.get("errorType") if f["error"] else None,
            "lastErrorAt": f.get("errorAt")}


def stream(write, n, alive=lambda: True, gap=None):
    """Write the event stream of a subscribed listener: a change event now and on every change (at most one per GAP, the last kept), keep-alives;
    each change event follows a `sessions` event naming the changed session ids. Unsubscribes when the peer is gone."""
    gap = GAP if gap is None else gap
    try:
        write(b"retry: 3000\nevent: change\ndata: %d\n\n" % n)
        last = sent = time.monotonic()
        while alive():
            m = wait(n, min(CHECK, KEEPALIVE))
            if m != n:
                rest = gap - (time.monotonic() - sent)
                if rest > 0:
                    time.sleep(rest)  # trailing edge: everything that changed meanwhile goes out in this one event
                    m = wait(m, 0)
                ids, unknown = changes(n, m)
                body = json.dumps({"n": m, "ids": ids, "all": unknown}, separators=(",", ":")).encode()
                write(b"event: sessions\ndata: %s\n\nevent: change\ndata: %d\n\n" % (body, m))
                n, last = m, time.monotonic()
                sent = last
            elif time.monotonic() - last >= KEEPALIVE:
                write(b": keep-alive\n\n")
                last = time.monotonic()
    finally:
        unsubscribe()
