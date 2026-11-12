#!/usr/bin/env python3
"""Session Desk: local viewer for Claude Code sessions; replies go through the claude CLI. Binds to 127.0.0.1 only."""
# Plain syntax only up to the version check, so an old Python reaches the message instead of a syntax error.
import os
import sys

MIN_PY = (3, 9)  # oldest Python the app supports


def version_problem(info=None):
    """The sentence to print when this Python is too old, or None."""
    info = tuple(sys.version_info if info is None else info)
    if info[:2] >= MIN_PY:
        return None
    return "Session Desk needs Python %d.%d or newer; this is %d.%d" % (MIN_PY[0], MIN_PY[1], info[0], info[1])


def save_details(text):
    """Write a failure's details to the run folder's server.log, else to a private temp file; returns the path or None."""
    try:
        from desk import config, termhost
        path = os.path.join(termhost.private_dir(config.run_dir()), "server.log")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    except Exception:
        try:
            import tempfile
            fd, path = tempfile.mkstemp(prefix="session-desk-", suffix=".log")
        except Exception:
            return None
    with os.fdopen(fd, "a") as fh:
        fh.write(text)
    return path


def run(argv):
    """Check the Python version, then dispatch; a failure prints one line and where its details are (DESK_DEBUG=1 shows the traceback)."""
    problem = version_problem()
    if problem:
        sys.stderr.write(problem + "\n")
        return 1
    try:
        from desk.ctl import main
        return main(argv)
    except KeyboardInterrupt:
        return 130
    except Exception as e:
        if os.environ.get("DESK_DEBUG") == "1":
            raise
        import traceback
        path = save_details(traceback.format_exc())
        where = "details in %s" % path if path else "run with DESK_DEBUG=1 to see the details"
        sys.stderr.write("Session Desk stopped: %s: %s; %s\n" % (type(e).__name__, str(e)[:200], where))
        return 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
