"""The change feed's cheap view of live processes and their subagents: the registry is re-read only when its folder or files change, liveness is
signal 0 plus a native start-time token, `ps` runs only for a new or changed pid and at a slow interval, and subagents are re-listed only when their
files change. Results equal `sessions.holders()` and `sessions.helpers()`."""
import os
import struct
import sys
import time

from . import config, sessions, transcripts as tx

SLOW = 300  # seconds before a pid whose start token stayed the same is checked with ps again
SLOW_BLIND = 30  # the same where the platform gives no start token
RETRY = 5  # seconds before a pid that ps did not report is asked about again
SAFETY = 60  # seconds between forced re-reads of the registry and subagents while the kernel watches them
REFRESH = 60  # seconds a subagent list is trusted at most without a change (its age cut-off moves with the clock)
AGE = 1800  # seconds since a subagent's last write after which `sessions.helpers` drops it; only used to schedule a refresh
KINFO = 1024  # bytes for one macOS kinfo_proc (648 today)
_state = {"home": None}
_native = {"fn": None, "tried": False}


def _fresh(home):
    """Forget everything when the data folder changes."""
    _state.clear()
    _state.update(home=home, reg=None, regkeys={}, regat=0.0, ps={}, subs={}, ver=0, renamed=set())


def _key(path):
    """(mtime_ns, size, inode, ctime_ns) of a path, or None when it is gone."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return st.st_mtime_ns, st.st_size, st.st_ino, st.st_ctime_ns


def _darwin_token():
    """A function pid -> (start seconds, microseconds) through sysctl(KERN_PROC_PID), no subprocess; None when ctypes cannot load it."""
    try:
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        fn = libc.sysctl
        fn.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
        fn.restype = ctypes.c_int
    except (OSError, AttributeError, ImportError):
        return None

    def token(pid):
        """Start time of a pid from the kernel's process table, or None."""
        mib = (ctypes.c_int * 4)(1, 14, 1, pid)  # CTL_KERN, KERN_PROC, KERN_PROC_PID
        buf, size = ctypes.create_string_buffer(KINFO), ctypes.c_size_t(KINFO)
        if fn(mib, 4, buf, ctypes.byref(size), None, 0) != 0 or size.value < 16:
            return None
        return struct.unpack_from("=qi", buf.raw, 0)  # kp_proc.p_un.__p_starttime
    return token


def _linux_token(pid):
    """Start time of a pid in clock ticks since boot from /proc, or None."""
    try:
        with open(f"/proc/{pid}/stat") as fh:
            return fh.read().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def token(pid):
    """A value that changes when a pid is reused (the process start time), read without a subprocess; None where the platform has none."""
    if not isinstance(pid, int) or not 0 < pid < 1 << 31:
        return None
    if not _native["tried"]:
        _native["tried"] = True
        _native["fn"] = _darwin_token() if sys.platform == "darwin" else _linux_token if sys.platform.startswith("linux") else None
    fn = _native["fn"]
    return fn(pid) if fn else None


def _alive(pid):
    """Signal 0, with exactly the failures `sessions.holders` treats as gone (another user's pid included)."""
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, ValueError, OSError, OverflowError, TypeError):
        return False
    return True


def _registry_moved(now, kernel, watched, woke):
    """True when the registry folder or a registry file may have changed: kernel note, unwatched path whose stat moved, or the safety interval."""
    s = _state
    if s["reg"] is None or (kernel and now - s["regat"] >= SAFETY):
        return True
    for p, k in s["regkeys"].items():
        if p in woke or ((not kernel or p not in watched) and _key(p) != k):
            return True
    return False


def _read_registry(now):
    """Re-read the registry through the data module and remember the stat keys of its folder and files."""
    s, reg = _state, os.path.join(config.HOME, "sessions")
    keys = {reg: _key(reg)}
    try:
        names = os.listdir(reg)
    except OSError:
        names = []
    for n in names:
        if n.endswith(".json") and not n.startswith("."):
            keys[os.path.join(reg, n)] = _key(os.path.join(reg, n))
    s["reg"], s["regat"] = tx.registry(), now
    renamed = s.setdefault("renamed", set())
    for p, k in keys.items():
        old = s["regkeys"].get(p)
        if p != reg and old and k and old != k:
            if old[2] != k[2] and p not in renamed:
                renamed.add(p)  # replaced by rename: the folder watch reports it
                s["ver"] += 1
            elif p in renamed:
                renamed.discard(p)  # written in place: only a watch on the file itself reports it
                s["ver"] += 1
    renamed.intersection_update(keys)
    if set(keys) != set(s["regkeys"]):
        s["ver"] += 1
    s["regkeys"] = keys


def _starts(alive, now):
    """Start time `ps` reports for each alive pid with a recorded start, asking ps only for new pids, changed tokens and expired answers."""
    cache, need, toks = _state["ps"], set(), {}
    for pid in {p["pid"] for p in alive if p["start"]}:
        tok = toks[pid] = token(pid)
        hit = cache.get(pid)
        if hit is None or hit[0] != tok or now - hit[2] >= (RETRY if hit[1] is None else SLOW if tok is not None else SLOW_BLIND):
            need.add(pid)
    if need:
        got = sessions.process_starts(need)
        for pid in need:
            cache[pid] = (toks[pid], got.get(pid), now)
    for pid in [p for p in cache if p not in toks]:
        del cache[pid]
    return {pid: cache[pid][1] for pid in toks if cache[pid][1] is not None}


def holders(kernel=False, watched=frozenset(), woke=frozenset()):
    """Same map as `sessions.holders()`: sessionId -> live processes holding it; the registry is re-read only when it may have changed."""
    now = time.time()
    if _state.get("home") != config.HOME:
        _fresh(config.HOME)
    if _registry_moved(now, kernel, watched, woke):
        _read_registry(now)
    alive = [p for p in _state["reg"] if not p["parked"] and _alive(p["pid"])]
    starts = _starts(alive, now)
    out = {}
    for p in alive:
        if p["start"] and starts.get(p["pid"]) not in (None, p["start"]):
            continue  # the pid now belongs to another process: the file is stale
        out.setdefault(p["sid"], []).append({k: p[k] for k in ("pid", "status", "at", "name", "entry")})
    return out


def _sub_paths(path):
    """Stat keys of everything a session's subagent list depends on: its folder, the subagents folders and each meta and transcript file."""
    base = path[:-6]
    keys = {base: _key(base), os.path.join(base, "subagents"): None}
    for root, dirs, files in os.walk(os.path.join(base, "subagents")):
        keys[root] = _key(root)
        for f in files:
            if f.endswith(".meta.json"):
                for q in (os.path.join(root, f), os.path.join(root, f[:-10] + ".jsonl")):
                    keys[q] = _key(q)
    return keys


def helpers(path, kernel=False, watched=frozenset(), woke=frozenset()):
    """Same list as `sessions.helpers(path)`, recomputed only when a subagent file or folder changed or an age cut-off passed."""
    now = time.time()
    if _state.get("home") != config.HOME:
        _fresh(config.HOME)
    hit = _state["subs"].get(path)
    if hit is not None and now < hit["until"] and not (kernel and now - hit["at"] >= SAFETY):
        moved = any(p in woke or ((not kernel or p not in watched) and _key(p) != k) for p, k in hit["keys"].items())
        if not moved:
            return hit["out"]
    keys = _sub_paths(path)
    out = sessions.helpers(path)
    cut = [k[0] / 1e9 + AGE for p, k in keys.items() if k and p.endswith(".jsonl") and k[0] / 1e9 + AGE > now]
    if hit is None or set(keys) != set(hit["keys"]):
        _state["ver"] += 1
    _state["subs"][path] = {"keys": keys, "out": out, "at": now, "until": min([now + REFRESH] + cut)}
    return out


def forget(keep):
    """Drop subagent state of sessions no longer live (paths not in `keep`)."""
    subs = _state.get("subs") or {}
    for p in [p for p in subs if p not in keep]:
        del subs[p]
        _state["ver"] += 1


def registry_watch():
    """Registry files that need a watch of their own: all but those seen replaced by rename, which their folder's watch reports."""
    reg = os.path.join(config.HOME, "sessions")
    renamed = _state.get("renamed") or set()
    return sorted(p for p, k in (_state.get("regkeys") or {}).items() if p != reg and k is not None and p not in renamed)


def watch_paths():
    """Existing paths worth a kernel watch: subagent folders and files of live sessions."""
    out = []
    for hit in list((_state.get("subs") or {}).values()):
        out += [p for p, k in hit["keys"].items() if k is not None]
    return out


def version():
    """Moves whenever the set of paths to watch changed."""
    return _state.get("ver", 0)
