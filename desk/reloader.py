"""Hot reload: re-run changed modules from their source text on request, at most once a second, keeping the old code when the new code fails."""
import ast
import importlib
import os
import sys
import threading
import time

PACKAGE = __name__.rpartition(".")[0]
DIR = os.path.dirname(os.path.abspath(__file__))
FIXED = frozenset({"__init__", "config", "terms", "termhost", "reloader", "app", "ctl", "durable", "messages"})  # loaded once: process state lives here
_state = {"checked": 0.0, "loaded": {}, "failed": None, "error": None, "reloads": 0, "lock": threading.Lock()}


def _file(name):
    """Source file of a module of the package."""
    return os.path.join(DIR, name + ".py")


def _mtime(name):
    """Modification time of a module's source in nanoseconds, 0 when missing."""
    try:
        return os.stat(_file(name)).st_mtime_ns
    except OSError:
        return 0


def modules():
    """Every module of the package, found on disk so a new file is seen too."""
    return sorted(f[:-3] for f in os.listdir(DIR) if f.endswith(".py") and not f.startswith("."))


def _deps(src):
    """Package modules a source imports with a relative import, anywhere in the file."""
    out = set()
    try:
        tree = ast.parse(src)
    except (SyntaxError, ValueError):
        return out  # reported by the compile step, under the right file name
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level == 1:
            out.update([node.module.split(".")[0]] if node.module else [a.name for a in node.names])
    return out


def order(sources):
    """Module names in dependency order (each after the package modules it imports); a cycle falls back to name order."""
    deps = {n: (_deps(src) & set(sources)) - {n} for n, src in sources.items()}
    done, out = set(), []
    while len(out) < len(deps):
        ready = sorted(n for n in deps if n not in done and deps[n] <= done) or sorted(n for n in deps if n not in done)[:1]
        out += ready
        done.update(ready)
    return out


def _restore(ns, saved):
    """Put a module namespace back without ever emptying it: overwrite, then drop names the failed code added."""
    ns.update(saved)
    for k in [k for k in ns if k not in saved]:
        ns.pop(k, None)


def init():
    """Remember the source times of everything loaded at start."""
    _state["loaded"] = {n: _mtime(n) for n in modules()}
    _state["checked"] = time.monotonic()


def check(force=False):
    """Re-run changed modules and every module after them in dependency order; on any error restore the old code and keep the error text."""
    st = _state
    if not force and time.monotonic() - st["checked"] < 1.0:
        return
    with st["lock"]:
        if not force and time.monotonic() - st["checked"] < 1.0:
            return
        st["checked"] = time.monotonic()
        names = [n for n in modules() if n not in FIXED]
        now = {n: _mtime(n) for n in names}
        changed = [n for n in names if now[n] != st["loaded"].get(n)]
        if not changed:
            st["failed"], st["error"] = None, None
            return
        if now == st["failed"]:
            return
        sources, codes, n = {}, {}, changed[0]
        try:
            for n in names:
                with open(_file(n), "rb") as fh:
                    sources[n] = fh.read()
            seq = order(sources)
            todo = seq[min(seq.index(c) for c in changed):]
            for n in todo:
                codes[n] = compile(sources[n], _file(n), "exec")  # from the text just read: no bytecode cache can serve older code
        except (SyntaxError, ValueError, OSError) as e:
            st["failed"], st["error"] = now, _describe(n, e)
            return
        importlib.invalidate_caches()  # a module added since start must be importable by the new code
        saved = []
        try:
            for n in todo:
                mod = sys.modules.get(f"{PACKAGE}.{n}")
                if mod is None:  # not imported by the running code; the new code imports it fresh if needed
                    continue
                saved.append((mod.__dict__, dict(mod.__dict__)))
                exec(codes[n], mod.__dict__)
        except Exception as e:
            for ns, d in reversed(saved):
                _restore(ns, d)
            st["failed"], st["error"] = now, _describe(n, e)
            return
        st["loaded"].update(now)
        st["failed"], st["error"] = None, None
        st["reloads"] += 1


def _describe(name, e):
    """Short error text: module, line and message."""
    line = getattr(e, "lineno", None)
    return f"{name}.py{f' line {line}' if line else ''}: {type(e).__name__}: {getattr(e, 'msg', None) or e}"[:300]


def status():
    """Loaded code version (newest source time of the loaded code, ms), reload count, last error, and files whose edits need a restart."""
    loaded = _state["loaded"]
    return {"version": max(loaded.values(), default=0) // 1_000_000, "reloads": _state["reloads"], "error": _state["error"],
            "restart": [n + ".py" for n in modules() if n in FIXED and _mtime(n) != loaded.get(n)]}
