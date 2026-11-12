"""Command line: run in the foreground (no verb), or start (detached), stop, restart, status, stop-terminals and doctor; pid and log files live in the private run folder."""
import contextlib
import fcntl
import http.client
import json
import os
import signal
import subprocess
import sys
import time

from . import config, durable, messages, termhost

PIDFILE, LOGFILE, CTL_LOCK, LAST_PORT = "server.json", "server.log", "ctl.lock", "last-port"  # last-port outlives a stop: restart with nothing running uses it
LOG_MAX = 1_000_000  # bytes before server.log is rotated to server.log.1
ROTATE_EVERY = 30  # seconds between log size checks in a detached server
START_WAIT = 15.0  # seconds a detached server gets to answer its health check
STOP_WAIT = 15.0  # seconds a server gets to stop after SIGTERM before it is killed
RECORD_VER = 1  # shape of server.json; a record of another version is ignored
START_SLACK = 30  # seconds between a process start and the start time its record names, beyond which the pid was reused
LOG_LINES = 40  # lines `logs` prints from each log by default
LOG_MAX_LINES = 10_000  # most lines `logs -n` prints from each log
LOG_TAIL_BYTES = 4_000_000  # bytes read from the end of a log for `logs` (both logs rotate at about 1 MB)
WARMING = "preparing the session list… the page shows it in a few seconds"  # `start` while health says setup.warming
USAGE = ("usage: python3 server.py [start | stop | restart | status [--json] | stop-terminals | doctor | logs [-n N]]"
         "   (no verb: run in the foreground)")


@contextlib.contextmanager
def start_lock(take=True):
    """Hold the ctl lock while a foreground server checks for a running copy and records itself (a server `start` launched: its parent holds it)."""
    if not take or os.environ.get("DESK_DETACHED") == str(os.getppid()):
        yield take
        return
    with lock_file() as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield True


def lock_file():
    """The ctl lock file opened for appending, created 0600 and tightened to 0600 like every other run file."""
    fd = os.open(_path(CTL_LOCK), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.fchmod(fd, 0o600)
    return os.fdopen(fd, "a")


def _path(name):
    """A file in the private run folder, which is created when missing."""
    return os.path.join(termhost.private_dir(config.run_dir()), name)


def read_pid():
    """The pid file's record ({v, pid, port, started}), or None when missing, unreadable, of another version or holding impossible values."""
    try:
        with open(_path(PIDFILE)) as fh:
            info = json.load(fh)
    except (OSError, ValueError, termhost.HostError):
        return None
    if not isinstance(info, dict) or info.get("v", RECORD_VER) != RECORD_VER:
        return None
    pid, port, started = info.get("pid"), info.get("port"), info.get("started", 0)
    if not all(type(x) is int for x in (pid, port, started)) or pid <= 1 or not 0 < port < 65536:
        return None
    return dict(info, started=started)


def write_pid(port):
    """Record this server (synced temp file + rename) unless another live server of this data folder holds the record."""
    try:
        cur = running()
        if cur and cur["pid"] != os.getpid():
            return False
        path = _path(PIDFILE)
        durable.drop_stale_temps(path)
        durable.write(path, json.dumps({"v": RECORD_VER, "pid": os.getpid(), "port": port, "started": config.STARTED}).encode())
        durable.write(_path(LAST_PORT), b"%d\n" % port)
        return True
    except (OSError, termhost.HostError):
        return False


def clear_pid():
    """Remove the pid file when it still names this process."""
    info = read_pid()
    if info and info["pid"] == os.getpid():
        try:
            os.unlink(_path(PIDFILE))
        except OSError:
            pass


def alive(pid):
    """True while a process with this id exists and belongs to this user."""
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def command_of(pid):
    """Command line of a process, or '' when it is gone."""
    r = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True)
    return r.stdout.strip()


def started_near(pid, ms):
    """True when the process started within START_SLACK seconds of ms (its record's start time), so the pid was not reused."""
    r = subprocess.run(["ps", "-o", "etime=", "-p", str(pid)], capture_output=True, text=True, env=dict(os.environ, LC_ALL="C"))
    parts = r.stdout.strip().replace("-", ":").split(":")
    try:
        nums = [int(x) for x in parts]
    except ValueError:
        return False
    secs = sum(n * m for n, m in zip(reversed(nums), (1, 60, 3600, 86400)))
    return abs((time.time() - secs) - ms / 1000) <= START_SLACK


def proc_start(pid):
    """Exact start time of a process (Linux /proc clock ticks, elsewhere `ps` lstart), or None once it is gone; tells a reused pid apart."""
    try:
        with open(f"/proc/{pid}/stat") as fh:
            return "ticks " + fh.read().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        pass
    r = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, env=dict(os.environ, LC_ALL="C"))
    return r.stdout.strip() or None


def signal_same(pid, ident, sig):
    """Send sig only while pid is still the process whose start time was ident; returns whether it was sent."""
    if ident is None or proc_start(pid) != ident:
        return False
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        return False
    return True


def health(port, timeout=2.0):
    """The server's /api/health answer on a port, or None."""
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        conn.request("GET", "/api/health", headers={"Host": f"127.0.0.1:{port}"})
        r = conn.getresponse()
        body = r.read()
        conn.close()
        return json.loads(body) if r.status == 200 else None
    except (OSError, ValueError):
        return None


def running():
    """The live server's record with its health, or None; a stale record (dead pid, another program) is removed, never trusted."""
    info = read_pid()
    if info is None:
        return None
    pid = info["pid"]
    if pid == os.getpid():
        return info
    if alive(pid) and started_near(pid, info["started"]):
        h = health(info["port"])
        if h is not None and h.get("pid") == pid and h.get("started") == info["started"]:
            return dict(info, health=h)
        if h is None and "server.py" in command_of(pid):
            return dict(info, health=None)  # alive but not answering: still ours, never start a second one
    try:
        os.unlink(_path(PIDFILE))
    except OSError:
        pass
    return None


def rotate_loop():
    """In a detached server: move server.log to server.log.1 when it grows past LOG_MAX, then keep writing to a fresh file."""
    path = _path(LOGFILE)
    while True:
        time.sleep(ROTATE_EVERY)
        rotate_now(path)


def rotate_now(path):
    """Rotate the log behind stdout and stderr when it is too big."""
    try:
        if os.path.getsize(path) <= LOG_MAX:
            return
        os.replace(path, path + ".1")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.dup2(fd, 1)
        os.dup2(fd, 2)
        os.close(fd)
    except OSError:
        pass


def open_log(path):
    """A log file opened for appending, created 0600 and tightened to 0600 when it already existed."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.fchmod(fd, 0o600)
    return os.fdopen(fd, "ab")


def uptime(ms):
    """Seconds since a start time in ms, as '2h 3m' or '41s'."""
    s = max(0, int(time.time() - ms / 1000))
    return f"{s // 3600}h {s % 3600 // 60}m" if s >= 3600 else f"{s // 60}m {s % 60}s" if s >= 60 else f"{s}s"


def start(port=None):
    """Start a detached server (new session, output to server.log) unless one runs; prints the URL; returns an exit code."""
    cur = running()
    if cur:
        print(f"already running: pid {cur['pid']}, http://127.0.0.1:{cur['port']}")
        return 1
    log_path = _path(LOGFILE)
    termhost.rotate(log_path, LOG_MAX)
    env = dict(os.environ, DESK_DETACHED=str(os.getpid()), PORT=str(config.PORT if port is None else port))
    with open_log(log_path) as log:
        proc = subprocess.Popen([sys.executable, os.path.join(config.HERE, "server.py")], cwd=config.HERE, env=env, stdin=subprocess.DEVNULL,
                                stdout=log, stderr=log, start_new_session=True)
    end = time.monotonic() + START_WAIT
    while time.monotonic() < end:
        if proc.poll() is not None:
            print(f"server did not start (exit {proc.returncode}); last lines of {log_path}:")
            with open(log_path, "rb") as fh:
                print(b"".join(fh.readlines()[-10:]).decode(errors="replace").rstrip())
            return 1
        info = read_pid()
        h = info and info["pid"] == proc.pid and health(info["port"], 1.0)
        if h:
            print(f"Session Desk started: pid {proc.pid}, http://127.0.0.1:{info['port']}  (log: {log_path})")
            setup = h.get("setup") or {}
            for line in (WARMING if setup.get("warming") else "", setup.get("hint")):
                if line:
                    print("  " + line)
            proc.returncode = 0  # detached on purpose: never waited for here
            return 0
        time.sleep(0.1)
    print(f"server pid {proc.pid} did not answer within {START_WAIT:.0f}s; see {log_path}")
    proc.returncode = 0
    return 1


def stop():
    """Stop the running server with SIGTERM (SIGKILL after STOP_WAIT); page terminals in the terminal host keep running."""
    cur = running()
    if not cur:
        print("not running")
        return 0
    pid, ident = cur["pid"], proc_start(cur["pid"])  # read right after the record was checked; every signal re-checks it
    if not signal_same(pid, ident, signal.SIGTERM):
        print("not running")
        running()
        return 0
    end = time.monotonic() + STOP_WAIT
    while alive(pid) and time.monotonic() < end:
        time.sleep(0.05)
    if alive(pid) and signal_same(pid, ident, signal.SIGKILL):
        print(f"pid {pid} did not stop within {STOP_WAIT:.0f}s; killed")
    else:
        print(f"stopped pid {pid}")
    running()  # drops the record if the server could not
    return 0


def last_port():
    """The port the last server of this data folder recorded, or None."""
    try:
        with open(_path(LAST_PORT)) as fh:
            port = int(fh.read(16).strip())
    except (OSError, ValueError, termhost.HostError):
        return None
    return port if 0 < port < 65536 else None


def restart():
    """Stop the running server and start a new one on the same port (PORT overrides); with nothing running, start on the last recorded port."""
    cur = running()
    if "PORT" in os.environ:
        port = config.PORT
    elif cur:
        port = cur["port"]
    else:
        port = last_port()
    if cur:
        stop()
    elif "PORT" in os.environ:
        print(f"nothing was running; starting on port {port} (PORT)")
    elif port:
        print(f"nothing was running; starting on port {port}, the last one this data folder used")
    else:
        port = config.PORT
        print(f"nothing was running and no port is recorded; starting on the default port {port}")
    return start(port)


def status_record(cur, host):
    """The `status --json` answer: server, terminal host and setup hint, for scripts."""
    from . import terms
    h = (cur or {}).get("health")
    out = {"v": 1, "running": bool(cur), "answering": h is not None, "pid": cur["pid"] if cur else None, "port": cur["port"] if cur else None,
           "url": f"http://127.0.0.1:{cur['port']}" if cur else None, "uptime": None, "codeVersion": None, "reloads": None, "terms": None,
           "host": {"running": bool(host), "pid": host.get("pid") if host else None, "protocol": host.get("v") if host else None,
                    "terms": host.get("terms") if host else None, "note": terms.stale_note(host) or None},
           "hint": None}
    if h is not None:
        out.update(uptime=max(0, int(time.time() - h.get("started", cur["started"]) / 1000)), codeVersion=h.get("codeVersion"),
                   reloads=h.get("reloads", 0), terms=h.get("terms", 0), hint=(h.get("setup") or {}).get("hint") or None)
    else:
        from . import firstrun
        out["hint"] = firstrun.build()["hint"] or None
    return out


def status(as_json=False):
    """Print pid, uptime, URL, code version and terminals of the running server; exit code 3 when none runs."""
    cur = running()
    from . import terms
    host = terms.host_hello(1.0)
    if as_json:
        rec = status_record(cur, host)
        print(json.dumps(rec, sort_keys=True))
        return 0 if rec["answering"] else 3 if not cur else 1
    hline = f"terminal host: pid {host['pid']}, protocol {host['v']}, up {uptime(host['started'])}, {host['terms']} terminals" if host else "terminal host: not running"
    note = terms.stale_note(host)
    if note:
        hline += "\n" + note
    if not cur:
        print("not running")
        print(hline)
        from . import firstrun
        hint = firstrun.build()["hint"]
        if hint:
            print("  " + hint)
        return 3
    h = cur.get("health")
    if h is None:
        print(f"pid {cur['pid']} on port {cur['port']} is not answering")
        print(hline)
        return 1
    version = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(h.get("codeVersion", 0) / 1000))
    print(f"running: pid {cur['pid']}, up {uptime(h.get('started', cur['started']))}, http://127.0.0.1:{cur['port']}")
    print(f"code version {version}, {h.get('reloads', 0)} reloads, {h.get('terms', 0)} page terminals")
    newer = code_on_disk()
    if newer > h.get("codeVersion", 0) + 1000:
        print(f"the code on disk is newer ({time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(newer / 1000))}): run `python3 server.py restart` to load it")
    print(hline)
    hint = (h.get("setup") or {}).get("hint")
    if hint:
        print("  " + hint)
    return 0


def code_on_disk():
    """Newest source time (ms) of server.py and desk/*.py, as health `codeVersion` counts it."""
    newest = 0
    for path in [os.path.join(config.HERE, "server.py")] + [os.path.join(config.HERE, "desk", n) for n in os.listdir(os.path.join(config.HERE, "desk"))]:
        if path.endswith(".py"):
            try:
                newest = max(newest, int(os.stat(path).st_mtime * 1000))
            except OSError:
                pass
    return newest


def stop_terminals():
    """End every page terminal of this data folder and stop its terminal host."""
    from . import terms
    n = terms.stop_host()
    print("no terminal host running" if n is None else f"terminal host stopped; {n} terminals ended")
    return 0


def tail(path, n):
    """The last n lines of a regular file (never through a link), or None when it does not exist."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None
    with os.fdopen(fd, "rb") as fh:
        if not os.path.isfile(path):
            return None
        size = fh.seek(0, os.SEEK_END)
        fh.seek(max(0, size - LOG_TAIL_BYTES))
        lines = fh.read().splitlines()[-n:] if n else []
    return b"\n".join(lines).decode(errors="replace")


def logs(n=LOG_LINES):
    """Print the last n lines of server.log and termhost.log; terminal output files are never read."""
    rd = config.run_dir()
    if not os.path.isdir(rd):
        print(f"no logs yet: {rd} does not exist (nothing has run for this data folder)")
        return 0
    for name in (LOGFILE, termhost.LOG):
        path = os.path.join(rd, name)
        text = tail(path, n)
        if text is None:
            print(f"== {path}: none yet")
            continue
        print(f"== {path} (last {n} line{'' if n == 1 else 's'})")
        if text:
            print(text)
    return 0


def log_count(argv):
    """The -n value of `logs`, or None when the arguments are wrong."""
    if not argv:
        return LOG_LINES
    if len(argv) == 2 and argv[0] == "-n" and argv[1].isdigit():
        return min(int(argv[1]), LOG_MAX_LINES)
    return None


def main(argv):
    """Dispatch a verb; no verb runs the server in the foreground as before."""
    if not argv:
        from . import app
        return app.main()
    verbs = {"start": start, "stop": stop, "restart": restart, "status": status, "stop-terminals": stop_terminals, "--stop-terminals": stop_terminals, "logs": logs}
    if argv == ["doctor"]:
        from . import doctor
        return doctor.main()  # reads only: no lock, creates nothing
    if argv[0] == "logs" and log_count(argv[1:]) is not None:
        return logs(log_count(argv[1:]))  # reads only: no lock, creates nothing
    if argv == ["status", "--json"]:
        argv, verbs["status"] = ["status"], lambda: status(as_json=True)
    if argv[0] not in verbs or len(argv) > 1:
        print(USAGE)
        return 2
    if config.state_state() != "ok":
        if argv[0] in ("start", "restart"):
            print(messages.say(argv[0], "readOnly"))
            return 1
        return verbs[argv[0]]()  # nothing can be recorded in a read-only folder, so there is nothing to lock
    with lock_file() as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)  # one start, stop or restart at a time per data folder
        return verbs[argv[0]]()
