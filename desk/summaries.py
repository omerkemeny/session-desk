"""Session list views kept on disk between runs, keyed by transcript path, size, mtime, inode and ctime, so a restart re-reads only changed files.

Same privacy class as the stats cache: counts and the short capped texts the list already sends; never packaged (`.stats-cache*`)."""
import hashlib
import json
import os
import stat as stat_mod
import threading
import time

from . import config, durable

VERSION = 3  # bump when the view shape, the index shape or a rule behind them changes: an older file is then ignored and rebuilt
SAVE_DELAY = 5.0  # seconds a change waits before the file is written, so a burst of changes is one write
MAX_ENTRIES = 10000  # views kept in the file, newest transcripts first
MAX_BYTES = 64 << 20  # a larger file is not read
MAX_INT = 2 ** 53  # numbers at or above this are not plausible counts or times
TIMES = ("updated", "lastAt", "turnEnd")  # epoch ms fields; a stored one later than a day from now is rejected
NONE = type(None)
# Every field of a view with its JSON types and, for texts, the longest length accepted.
SHAPE = {"title": ((str, NONE), 80), "titleAuto": (bool, 0), "promptTitle": (str, 64), "fallback": (str, 20), "topic": (str, 72),
         "project": (str, 255), "branch": (str, 200), "model": (str, 200), "updated": (int, 0), "tokens": (int, 0), "ask": (str, 400), "last": (str, 160),
         "kind": (str, 16), "automated": (bool, 0), "consistency": (str, 16), "lastTool": (str, 200), "lastError": (bool, 0), "prOpened": (int, 0),
         "turnEnd": (int, 0), "lastAt": (int, 0), "lastBy": (str, 64), "continuedIn": ((str, NONE), 64), "shown": (bool, 0), "days": (dict, 0)}
# Kept across code reloads: the loaded file and the pending write.
_state = globals().get("_state") or {"file": None, "home": None, "code": None, "entries": {}, "dirty": False, "timer": None, "loaded": 0, "rejected": 0, "writes": 0,
                                    "error": ""}
_state.setdefault("index", {})  # transcript path -> (key, automated, shown, continuedIn) for every file the list loop has decided on, no count bound
_lock = globals().get("_lock") or threading.Lock()
SOURCES = ("transcripts.py", "sessions.py", "summaries.py")  # the code a view depends on
_marks = {"sig": None, "mark": None}  # source file stats and the code mark hashed from them


def code_mark():
    """Short hash of the code that builds a view, so views made by other code are never reused; re-hashed only when a source file changed."""
    here, sig = os.path.dirname(os.path.abspath(__file__)), []
    for name in SOURCES:
        try:
            st = os.stat(os.path.join(here, name))
            sig.append((st.st_mtime_ns, st.st_size, st.st_ino))
        except OSError:
            sig.append(None)
    if _marks.get("sig") == sig:
        return _marks["mark"]
    h = hashlib.sha1()
    for name in SOURCES:
        try:
            with open(os.path.join(here, name), "rb") as fh:
                h.update(fh.read())
        except OSError:
            h.update(name.encode())
    _marks.update(sig=sig, mark=h.hexdigest()[:16])
    return _marks["mark"]


def cache_file():
    """The summary cache beside the stats cache: <stats cache name>-summaries.json."""
    root, ext = os.path.splitext(config.stats_file())
    return root + "-summaries" + (ext or ".json")


def _valid_view(v, now_ms=None):
    """True when a stored view has exactly the expected fields, types, lengths and plausible numbers."""
    if not isinstance(v, dict) or set(v) != set(SHAPE):
        return False
    late = (time.time() * 1000 if now_ms is None else now_ms) + 86400000
    for k, (types, cap) in SHAPE.items():
        x = v[k]
        if not isinstance(x, types) or (isinstance(x, bool) and bool not in (types if isinstance(types, tuple) else (types,))):
            return False
        if isinstance(x, str) and len(x) > cap:
            return False
        if isinstance(x, int) and not isinstance(x, bool) and not (0 <= x < MAX_INT and (k not in TIMES or x <= late)):
            return False
    return all(isinstance(day, str) and len(day) == 10 and isinstance(n, list) and len(n) == 2
               and all(isinstance(i, int) and not isinstance(i, bool) and 0 <= i < MAX_INT for i in n) for day, n in v["days"].items())


def _valid_key(k):
    """True for a stored [mtime_ns, size, inode, ctime_ns] key."""
    return isinstance(k, list) and len(k) == 4 and all(isinstance(i, int) and not isinstance(i, bool) and i >= 0 for i in k)


def _valid_path(p, root):
    """True for an entry path of the exact form <data folder>/projects/<dir>/<file>.jsonl, already normalised."""
    if not isinstance(p, str) or not p.startswith(root) or os.path.normpath(p) != p or not p.endswith(".jsonl"):
        return False
    parts = p[len(root):].split(os.sep)
    return len(parts) == 2 and all(x and not x.startswith(".") for x in parts)


def _load(path):
    """Bytes of a cache file only when it is a regular file of this user that nobody else may write (never through a link), else None."""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat_mod.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o022 or st.st_size > MAX_BYTES:
        return None
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    with os.fdopen(fd, "rb") as fh:
        fs = os.fstat(fh.fileno())
        if (fs.st_ino, fs.st_dev) != (st.st_ino, st.st_dev) or fs.st_size > MAX_BYTES:
            return None
        return fh.read(MAX_BYTES + 1)


def read(path, mark=None):
    """Entries of a cache file as {transcript path: (key tuple, view)}; a missing, corrupt, foreign, untrusted or older file gives {}, bad entries are dropped."""
    return read_all(path, mark)[:2]


def _valid_index(e):
    """True for a stored index entry [mtime_ns, size, inode, ctime_ns, automated, shown, continuedIn]."""
    return (isinstance(e, list) and len(e) == 7 and _valid_key(e[:4]) and isinstance(e[4], bool) and isinstance(e[5], bool)
            and (e[6] is None or (isinstance(e[6], str) and 0 < len(e[6]) <= SHAPE["continuedIn"][1])))


def read_all(path, mark=None):
    """(views, rejected count, index) of a cache file; the index maps <data folder>/projects/<dir>/<file>.jsonl to (key, automated, shown, continuedIn)."""
    out, bad, index = {}, 0, {}
    raw = _load(path)
    if raw is None or len(raw) > MAX_BYTES:
        return {}, int(os.path.lexists(path)), {}
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:  # bad JSON, bad bytes, nesting deeper than the parser allows (RecursionError), memory
        return {}, 1, {}
    if (not isinstance(data, dict) or data.get("v") != VERSION or data.get("code") != (mark or code_mark()) or data.get("home") != os.path.realpath(config.HOME)
            or not isinstance(data.get("entries"), dict) or not isinstance(data.get("index"), dict)):
        return {}, 1, {}
    root, now_ms = os.path.join(os.path.realpath(config.HOME), "projects") + os.sep, time.time() * 1000
    for p, e in data["entries"].items():
        if (_valid_path(p, root) and isinstance(e, list) and len(e) == 2
                and _valid_key(e[0]) and _valid_view(e[1], now_ms)):
            out[p] = (tuple(e[0]), e[1])
        else:
            bad += 1
    base = index_root()
    for rel, e in data["index"].items():
        if isinstance(rel, str) and _valid_path(root + rel, root) and _valid_index(e):
            index[base + rel] = (tuple(e[:4]), e[4], e[5], e[6])
        else:
            bad += 1
    return out, bad, index


def index_root():
    """Prefix of the transcript paths the index is keyed by in memory (as the list finds them, not resolved)."""
    return os.path.join(config.HOME, "projects") + os.sep


def index():
    """The in-memory index: transcript path -> (key, automated, shown, continuedIn); read it, change it only through index_put/index_keep."""
    return _state["index"]


def index_put(path, entry):
    """Store one index entry (key, automated, shown, continuedIn) and schedule a write when it changed."""
    with _lock:
        if _state["file"] is None or _state["index"].get(path) == entry:
            return
        _state["index"][path] = entry
        _dirty()


def index_keep(paths):
    """Drop index entries of transcripts that are no longer among these paths."""
    with _lock:
        ix = _state["index"]
        gone = [p for p in ix if p not in paths]
        for p in gone:
            del ix[p]
        if gone and _state["file"] is not None:
            _dirty()


def attach():
    """Load the cache file once per data folder (and again when the folder or cache path changes)."""
    f, home, mark = cache_file(), os.path.realpath(config.HOME), code_mark()
    with _lock:
        if _state["file"] == f and _state["home"] == home and _state["code"] == mark:
            return
        same = _state["file"] == f and _state["home"] == home
        entries, bad, ix = ({}, 0, {}) if same else read_all(f, mark)  # new code after a reload: views of the old code are dropped, not reused or saved
        _cancel()
        _state.update(file=f, home=home, code=mark, entries=entries, index=ix, dirty=False, loaded=len(entries), rejected=bad, error="")


def get(path, key):
    """The stored view of a transcript when its key (mtime_ns, size, inode, ctime_ns) still matches, else None."""
    with _lock:
        e = _state["entries"].get(_real(path))
    return e[1] if e and e[0] == tuple(key) else None


def put(path, key, view):
    """Store a fresh view and schedule a write of the file."""
    with _lock:
        if _state["file"] is None:
            return
        ents, real = _state["entries"], _real(path)
        ents.pop(real, None)
        ents[real] = (tuple(key), view)
        while len(ents) > MAX_ENTRIES:
            ents.pop(next(iter(ents)))  # least recently stored first
        _dirty()


def _dirty():
    """Mark the file changed and schedule one write (caller holds the lock)."""
    _state["dirty"] = True
    if _state["timer"] is None:
        t = threading.Timer(SAVE_DELAY, flush, args=(_state["file"],))
        t.daemon = True
        _state["timer"] = t
        t.start()


def _real(path):
    """Absolute real path, the key entries are stored under."""
    return os.path.realpath(path)


def _cancel():
    """Drop a pending write (caller holds the lock)."""
    if _state["timer"] is not None:
        _state["timer"].cancel()
        _state["timer"] = None


def flush(file=None):
    """Write the cache file now when it changed (atomic, 0600, one writer); entries of deleted transcripts are dropped."""
    with _lock:
        if file is not None and file != _state["file"]:
            return False  # the data folder changed since the write was scheduled
        _state["timer"] = None
        if not _state["dirty"] or _state["file"] is None:
            return False
        if _state["home"] != os.path.realpath(config.HOME) or not os.path.isdir(_state["home"]):
            return False  # the data folder was switched or removed since: its views are not written anywhere
        file, home, mark, items = _state["file"], _state["home"], _state["code"], list(_state["entries"].items())
        base, ix = index_root(), list(_state["index"].items())
        _state["dirty"] = False
    live = [(p, e) for p, e in items if os.path.exists(p)]
    if len(live) < len(items):
        alive, ents = {p for p, _ in live}, _state["entries"]
        with _lock:
            for p, e in items:
                if p not in alive and ents.get(p) is e:
                    ents.pop(p, None)  # a deleted transcript's view leaves memory too
    live.sort(key=lambda x: x[1][0][0], reverse=True)
    n = len(base)
    body = {"v": VERSION, "code": mark, "home": home, "entries": {p: [list(k), v] for p, (k, v) in live[:MAX_ENTRIES]},
            "index": {p[n:]: [*k, a, s, c] for p, (k, a, s, c) in ix if p.startswith(base)}}
    try:
        durable.write(file, json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    except OSError as e:
        with _lock:
            _state["error"], _state["dirty"] = type(e).__name__, True
        return False
    with _lock:
        _state["writes"] += 1
    return True


def reset():
    """Forget the loaded file and any pending write (tests, data folder switch)."""
    with _lock:
        _cancel()
        _state.update(file=None, home=None, code=None, entries={}, index={}, dirty=False, loaded=0, rejected=0, writes=0, error="")
