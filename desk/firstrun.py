"""First-run checks for health, the start line and doctor: data folder, session count, CLI and state folder, with the first thing to do."""
import os
import threading
import time

from . import config, messages, transcripts as tx

TTL = 5.0  # seconds a setup answer is reused
DATA_MISSING = messages.CORE["dataMissing"]  # every setup sentence lives in messages.CORE
DATA_UNREADABLE = messages.CORE["dataUnreadable"]
NO_SESSIONS = messages.CORE["noSessions"]
READ_ONLY = messages.CORE["readOnly"]
CLI_HINTS = {"missing": messages.CORE["cliMissing"], "notExecutable": messages.CORE["cliBroken"]}
_cache = {"key": None, "at": 0.0, "value": None}
_lock = threading.Lock()


def data_state():
    """'ok', 'missing' or 'unreadable' for the data folder."""
    home = config.HOME
    if not os.path.exists(home):
        return "missing"
    if not os.path.isdir(home) or not os.access(home, os.R_OK | os.X_OK):
        return "unreadable"
    projects = os.path.join(home, "projects")
    if os.path.exists(projects) and not os.access(projects, os.R_OK | os.X_OK):
        return "unreadable"
    return "ok"


def hint(s):
    """The first thing to do for a setup answer, or '' when all is fine."""
    if s["dataDir"] == "missing":
        return DATA_MISSING
    if s["dataDir"] == "unreadable":
        return DATA_UNREADABLE
    if s["stateDir"] != "ok":
        return READ_ONLY
    if s["cli"] != "ok":
        return CLI_HINTS[s["cli"]]
    return NO_SESSIONS if not s["sessions"] else ""


def build():
    """A fresh setup answer: {dataDir, sessions, cli, stateDir, hint}."""
    data = data_state()
    try:
        count = len(tx.session_paths()) if data == "ok" else 0
    except OSError:
        count = 0
    s = {"dataDir": data, "sessions": count, "cli": config.cli_state(), "stateDir": config.state_state()}
    s["hint"] = hint(s)
    return s


def setup():
    """The setup answer, reused for TTL seconds per data folder, state folder and CLI path."""
    key = (config.HOME, config.STATE_DIR, config.CLAUDE)
    with _lock:
        if _cache["key"] == key and time.monotonic() - _cache["at"] < TTL:
            return dict(_cache["value"])
    value = build()
    with _lock:
        _cache.update(key=key, at=time.monotonic(), value=value)
    return dict(value)


def healthy(s):
    """True when the page can show sessions and the app can keep its files (a missing CLI only fills the hint)."""
    return s["dataDir"] == "ok" and s["stateDir"] == "ok"
