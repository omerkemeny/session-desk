"""Process-wide settings, chosen once at start and never reloaded: data folder, app folder, port, page token."""
import hashlib
import os
import secrets
import shutil
import time

from . import messages, termhost

HOME = os.environ.get("DESK_CLAUDE_DIR") or os.path.expanduser("~/.claude")  # the only place the data folder is chosen
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # app folder: server.py, desk/, web/
WEB = os.path.join(HERE, "web")


def _port():
    """PORT from the environment, or one plain sentence and exit when it is not a port number."""
    raw = os.environ.get("PORT", "8765")
    if not (raw.isdigit() and int(raw) <= 65535):
        raise SystemExit(f"Session Desk: PORT must be a number from 0 to 65535, not {raw!r}")
    return int(raw)


PORT = _port()
TOKEN = secrets.token_urlsafe(24)  # page must echo this on every write request
STARTED = int(time.time() * 1000)
STATE_DIR = os.environ.get("DESK_STATE_DIR") or HERE  # where the app's own files (stats cache, index, lock) are written
STATS_FILE = None  # set to force a stats cache path; otherwise stats_file() derives it from the data folder
TERMHOST = os.environ.get("DESK_TERMHOST", "1") != "0"  # page terminals live in the terminal host and outlive restarts; 0 keeps them children of the server
CLAUDE = os.environ.get("DESK_CLAUDE_BIN") or shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")
_FOUND = CLAUDE  # the path chosen at start; only that one is looked up again when the CLI is installed later
TERMS_OFF = ""  # set at start when page terminals cannot run (read-only state folder): the reason the page shows
CLI_MISSING = termhost.CLI_MISSING
CLI_BROKEN = messages.say("termOpen", "cliBroken")


def stats_file():
    """Stats cache in STATE_DIR: .stats-cache.json for ~/.claude, a name keyed to the data folder for any other one."""
    if STATS_FILE:
        return STATS_FILE
    home = os.path.realpath(HOME)
    if home == os.path.realpath(os.path.expanduser("~/.claude")):
        return os.path.join(STATE_DIR, ".stats-cache.json")
    return os.path.join(STATE_DIR, f".stats-cache-{hashlib.sha1(home.encode()).hexdigest()[:12]}.json")


def run_dir():
    """Private folder (0700) for the terminal host socket and the server's pid and log files, one per data folder."""
    return termhost.run_dir(STATE_DIR, HOME)


def cli_state():
    """'ok', 'missing' or 'notExecutable' for the CLI; a CLI installed on PATH after the start is picked up when DESK_CLAUDE_BIN is unset."""
    global CLAUDE, _FOUND
    if not os.environ.get("DESK_CLAUDE_BIN") and CLAUDE == _FOUND and not _runnable(CLAUDE):
        CLAUDE = _FOUND = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")
    if _runnable(CLAUDE):
        return "ok"
    return "notExecutable" if os.path.exists(CLAUDE) else "missing"


def _runnable(path):
    """True for an executable file."""
    return os.path.isfile(path) and os.access(path, os.X_OK)


def cli_error(place="termOpen"):
    """The text a terminal open (or a quick reply, place "reply") gets when the CLI cannot run, or None."""
    state = cli_state()
    return None if state == "ok" else messages.say(place, "cliMissing" if state == "missing" else "cliBroken")


def writable(path):
    """True when this user may create files in a folder."""
    return os.path.isdir(path) and os.access(path, os.W_OK | os.X_OK)


def state_state():
    """'ok' when the app's own files can be written (state folder, and the run folder when it exists), else 'readOnly'; writes nothing."""
    rd = run_dir()
    if not writable(STATE_DIR) or (os.path.lexists(rd) and not writable(rd)):
        return "readOnly"
    return "ok"
