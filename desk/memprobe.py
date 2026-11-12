"""Opt-in memory probe (DESK_TRACEMALLOC=1): the largest allocation sites of the server by size, file and line only, never data."""
import os
import threading
import time
import tracemalloc

TOP = 10  # allocation sites listed
FRAMES = 1  # stack depth kept per allocation; one frame keeps the probe cheap
TTL = 5.0  # seconds a listing is reused, since a snapshot walks every traced block
_cache = {"at": 0.0, "value": None}
_lock = threading.Lock()


def wanted():
    """True when the probe was asked for."""
    return os.environ.get("DESK_TRACEMALLOC") == "1"


def start():
    """Begin tracing allocations when asked for; called once at server start."""
    if wanted() and not tracemalloc.is_tracing():
        tracemalloc.start(FRAMES)


def short(path):
    """A source path without the folders above the app or the Python library, so no home path is shown."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if path.startswith(here + os.sep):
        return os.path.relpath(path, here)
    parts = path.split(os.sep)
    return os.sep.join(parts[-2:])


def top():
    """[{file, line, size, count}] of the TOP allocation sites by size, or None when the probe is off."""
    if not (wanted() and tracemalloc.is_tracing()):
        return None
    with _lock:
        if _cache["value"] is not None and time.monotonic() - _cache["at"] < TTL:
            return _cache["value"]
        snap = tracemalloc.take_snapshot().filter_traces((tracemalloc.Filter(False, tracemalloc.__file__),))
        rows = [{"file": short(st.traceback[0].filename), "line": st.traceback[0].lineno, "size": st.size, "count": st.count}
                for st in snap.statistics("lineno")[:TOP]]
        _cache.update(at=time.monotonic(), value=rows)
        return rows
