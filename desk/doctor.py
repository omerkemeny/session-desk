"""`python3 server.py doctor`: a short pass/fail list of what the app needs; reads only, prints no secrets and no session text."""
import json
import os
import socket
import subprocess
import sys

from . import config, firstrun, messages, termhost

VERSION_WAIT = 10  # seconds the CLI gets to print its version
MIN_PY = (3, 9)  # oldest Python the app supports


OK, WARN, FAIL = "ok", "warn", "FAIL"  # warn: a part of the app is off, but it runs; FAIL: the app cannot work until it is fixed


def check_python():
    """Python version."""
    v = ".".join(map(str, sys.version_info[:3]))
    if sys.version_info[:2] >= MIN_PY:
        return OK, v
    return FAIL, f"{v}; install Python {MIN_PY[0]}.{MIN_PY[1]} or newer and run the app with it"


def check_cli():
    """The CLI exists; its own `--version` line, asked only of a path the user configured in DESK_CLAUDE_BIN."""
    state, cli = config.cli_state(), config.CLAUDE
    if state == "missing":
        return WARN, messages.say("doctorCheck", "cliMissing")
    if state != "ok":
        return WARN, messages.say("doctorCheck", "cliBroken", cli=cli)
    if not os.environ.get("DESK_CLAUDE_BIN"):
        return OK, f"found at {cli}"
    try:
        r = subprocess.run([cli, "--version"], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=VERSION_WAIT, errors="replace")
    except (OSError, subprocess.TimeoutExpired) as e:
        return WARN, f"{cli} --version failed ({type(e).__name__}): check that `{cli} --version` works in a terminal"
    line = (r.stdout.strip().splitlines() or [""])[0][:80]
    if r.returncode == 0 and line:
        return OK, f"{cli} {line}"
    return WARN, f"{cli} --version printed nothing (exit {r.returncode}): check that it is the Claude Code CLI"


def check_data():
    """The data folder and its projects folder can be read; no sessions yet is a warning, not a failure."""
    home, state = config.HOME, firstrun.data_state()
    if state == "missing":
        return FAIL, messages.say("doctorCheck", "dataMissing", home=home)
    if state != "ok":
        return FAIL, messages.say("doctorCheck", "dataUnreadable", home=home)
    if not os.path.isdir(os.path.join(home, "projects")):
        return WARN, messages.say("doctorCheck", "noSessions", home=home)
    return OK, f"{home} readable"


def check_state_dir():
    """The folder for the app's own files (caches, run folder) can be written."""
    d = config.STATE_DIR
    if not config.writable(d):
        return FAIL, messages.say("doctorCheck", "readOnly", dir=d)
    return OK, f"{d} writable"


def check_run_dir():
    """The run folder is private (0700, this user, not a link) and writable, or can be created."""
    rd = config.run_dir()
    if not os.path.lexists(rd):
        if config.writable(os.path.dirname(rd)):
            return OK, "not created yet; can be created"
        return FAIL, messages.say("doctorCheck", "readOnly", dir=f"cannot create {rd}")
    if not termhost.is_private(rd):
        return FAIL, f"{rd} is not a private folder of this user: remove it and start again"
    if not config.writable(rd):
        return FAIL, messages.say("doctorCheck", "readOnly", dir=f"{rd} (or make it writable with chmod u+w)")
    return OK, "private (0700)"


def check_port():
    """The port is free, or held by this app's server for this data folder."""
    port = config.PORT
    if os.path.isdir(config.run_dir()):
        from . import ctl
        cur = ctl.running()
        if cur:
            return OK, f"{cur['port']} used by this app (pid {cur['pid']})"
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return OK, f"{port} free"
    except OSError:
        pass
    finally:
        s.close()
    return FAIL, f"{port} is used by another program: start on another port, for example PORT=9000 python3 server.py"


def check_stats():
    """The stats cache parses, or there is none yet; a broken one is rebuilt by the next count."""
    path = config.stats_file()
    try:
        with open(path) as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return OK, "none yet"
    except (OSError, ValueError) as e:
        return WARN, f"{path} does not parse ({type(e).__name__}); the next count rebuilds it, or delete it"
    return (OK, "parses") if isinstance(data, dict) else (WARN, f"{path} is not an object; the next count rebuilds it, or delete it")


def check_host():
    """Terminal host: not running, or answering with this protocol and this code."""
    from . import terms
    h = terms.host_hello(1.0)
    if h is None:
        return OK, "not running (starts with the first page terminal)"
    if h.get("v") != termhost.PROTOCOL:
        return WARN, termhost.mismatch(h.get("v"))
    note = terms.stale_note(h)
    return (WARN, note) if note else (OK, f"pid {h.get('pid')}, {h.get('terms')} terminals")


CHECKS = (("python", check_python), ("cli", check_cli), ("data folder", check_data), ("state folder", check_state_dir), ("run folder", check_run_dir),
          ("port", check_port), ("stats cache", check_stats), ("terminal host", check_host))


def terminal_hint(hint):
    """Doctor's wording of a setup hint: what to run in a terminal instead of reloading a page."""
    state = messages.state_of(hint)
    return messages.say("doctor", state) if state else hint


def setup_line(s):
    """The health `setup` answer in one line."""
    return f"data folder {s['dataDir']}, {s['sessions']} sessions, cli {s['cli']}, state folder {s['stateDir']}"


def main():
    """Print one line per check, the setup summary and the first thing to do; exit code 1 only when something stops the app from working."""
    bad = warn = 0
    for name, fn in CHECKS:
        try:
            mark, text = fn()
        except Exception as e:  # a check that breaks is a failed check, never a crash
            mark, text = FAIL, f"check failed: {type(e).__name__}"
        bad, warn = bad + (mark == FAIL), warn + (mark == WARN)
        print(f"{mark:<5} {name:<14} {text}")
    s = firstrun.build()
    print(f"{'':<5} {'setup':<14} {setup_line(s)}")
    if s["hint"]:
        print(f"{'':<5} {'first':<14} {terminal_hint(s['hint'])}")
    if bad:
        print(f"{bad} check(s) failed" + (f", {warn} warning(s)" if warn else "") + ": the app cannot work until the FAIL lines are fixed")
    else:
        print("all checks passed" if not warn else f"no blocking problem; {warn} warning(s): the app runs, the warned parts are off")
    return 1 if bad else 0
