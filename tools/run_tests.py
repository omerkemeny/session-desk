#!/usr/bin/env python3
"""Run the Python test modules in parallel worker processes (one `python3 -m unittest <module>` each), print their output in a stable order.

Usage: python3 tools/run_tests.py [--fast] [--jobs N] [--reserve N] [module ...]
Exit code 0 when every module passed, 1 otherwise; failing test names and the ten slowest tests are listed at the end.
"""
import argparse
import ast
import os
import re
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = os.path.join(ROOT, "tests")
SLOW_SUITES = ("test_feed_watch", "test_crash", "test_two_servers", "test_fds")  # skipped by --fast
FIRST = ("test_feed_watch", "test_crash", "test_fds", "test_two_servers", "test_package", "test_robust", "test_terms", "test_web",
         "test_termhost", "test_events", "test_busy_day", "test_index", "test_ctl")  # longest modules start first, so the pool ends together
SPLIT = ("test_feed_watch", "test_crash", "test_termhost")  # modules whose test classes run as separate units, so no single unit holds the pool up
MODULE_TIMEOUT = 900  # seconds one module may run before it is killed and counted as failed
SLOWEST = 10  # tests listed by duration at the end
DUR_LINE = re.compile(r"^\s*([0-9.]+)s\s+(\S.*)$")  # one line of unittest's --durations table (3.12+)
FAIL_LINE = re.compile(r"^(FAIL|ERROR): ")


def test_classes(mod):
    """Names of the TestCase classes a module defines (a class with Test in its name and a base), read without importing it."""
    with open(os.path.join(TESTS, mod + ".py"), encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
    return [n.name for n in tree.body if isinstance(n, ast.ClassDef) and n.bases and n.name.endswith("Test")]


def modules(fast, names):
    """Units to run (modules, or module.Class for the SPLIT ones), longest first, then alphabetical."""
    mods = names or sorted(f[:-3] for f in os.listdir(TESTS) if f.startswith("test_") and f.endswith(".py"))
    if fast:
        mods = [m for m in mods if m not in SLOW_SUITES]
    units = []
    for m in mods:
        classes = test_classes(m) if m in SPLIT and "." not in m else []
        units += [f"{m}.{c}" for c in classes] if classes else [m]
    return sorted(units, key=lambda u: (FIRST.index(u.split(".")[0]) if u.split(".")[0] in FIRST else len(FIRST), u))


def default_jobs(reserve):
    """Worker count: the machine's cores less those reserved for suites running beside this one, at least 2."""
    return max(2, (os.cpu_count() or 2) - reserve)


def run_one(mod, out):
    """Run one module in its own interpreter; stores (exit code, seconds, output) in out[mod]."""
    args = [sys.executable, "-m", "unittest"] + (["--durations", str(SLOWEST)] if sys.version_info >= (3, 12) else []) + [mod]
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(filter(None, [TESTS, os.environ.get("PYTHONPATH")])), PYTHONDONTWRITEBYTECODE="1")
    t0 = time.monotonic()
    try:
        r = subprocess.run(args, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=MODULE_TIMEOUT)
        code, text = r.returncode, r.stdout.decode(errors="replace")
    except subprocess.TimeoutExpired as e:
        code, text = 1, (e.stdout or b"").decode(errors="replace") + f"\nERROR: {mod} timed out after {MODULE_TIMEOUT}s\n"
    out[mod] = (code, time.monotonic() - t0, text)


def counts(text):
    """(tests run, failures + errors, skipped) read from a module's unittest summary."""
    m = re.search(r"^Ran (\d+) tests? in", text, re.M)
    ran = int(m.group(1)) if m else 0
    bad = sum(int(x) for x in re.findall(r"(?:failures|errors)=(\d+)", text))
    skipped = sum(int(x) for x in re.findall(r"skipped=(\d+)", text))
    return ran, bad, skipped


def durations(text, mod):
    """(seconds, test name) pairs from a module's --durations table."""
    rows, inside = [], False
    for line in text.splitlines():
        if line.startswith("Slowest test durations"):
            inside = True
        elif inside:
            m = DUR_LINE.match(line)
            if m:
                rows.append((float(m.group(1)), m.group(2)))
            elif not line.strip() or line.startswith("-"):
                if rows:
                    break
    return rows


def main(argv=None):
    """Run the modules in a pool, then print each one's result in order and the summary; returns the exit code."""
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--fast", action="store_true", help="skip the slow suites: " + " ".join(SLOW_SUITES))
    p.add_argument("--jobs", type=int, default=0, help="worker processes (default: cores less --reserve)")
    p.add_argument("--reserve", type=int, default=0, help="cores left free for suites running beside this one")
    p.add_argument("--verbose", action="store_true", help="print every module's output, not only failing ones")
    p.add_argument("--list-slow", action="store_true", help="print the suites --fast skips and exit")
    p.add_argument("module", nargs="*")
    a = p.parse_args(argv)
    if a.list_slow:
        print(" ".join(SLOW_SUITES))
        return 0
    mods = modules(a.fast, a.module)
    jobs = max(1, min(len(mods), a.jobs or default_jobs(a.reserve)))
    out, todo, lock = {}, list(mods), threading.Lock()

    def worker():
        """Take the next module until none is left."""
        while True:
            with lock:
                if not todo:
                    return
                mod = todo.pop(0)
            run_one(mod, out)

    t0 = time.monotonic()
    threads = [threading.Thread(target=worker, daemon=True) for _ in range(jobs)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.monotonic() - t0
    total = bad_total = skipped_total = 0
    failing, failed_mods, slow = [], [], []
    for mod in sorted(mods):
        code, secs, text = out[mod]
        ran, bad, skipped = counts(text)
        total, bad_total, skipped_total = total + ran, bad_total + bad, skipped_total + skipped
        ok = code == 0
        print(f"{'ok  ' if ok else 'FAIL'}  {mod:<40} {ran:>4} tests  {secs:6.1f}s")
        if not ok or a.verbose:
            print(text.rstrip())
            print()
        if not ok:
            failed_mods.append(mod)
            failing += [line for line in text.splitlines() if FAIL_LINE.match(line)] or [f"ERROR: {mod} (exit {code}, no test summary)"]
        slow += [(s, f"{name}  [{mod}]") for s, name in durations(text, mod)]
    print()
    print(f"Ran {total} tests in {wall:.3f}s ({len(mods)} units, {jobs} workers)")
    if slow:
        print()
        print("Slowest test durations")
        for s, name in sorted(slow, reverse=True)[:SLOWEST]:
            print(f"{s:10.3f}s {name}")
        print()
    if failed_mods:
        print("failing tests:")
        for line in failing:
            print("  " + line)
        print()
        print(f"FAILED (modules={len(failed_mods)}: {' '.join(failed_mods)}; failures and errors={bad_total})")
        return 1
    print("OK" + (f" (skipped={skipped_total})" if skipped_total else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
