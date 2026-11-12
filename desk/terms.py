"""Page terminals (interactive CLIs in pseudo-terminals) and headless replies; this module is never reloaded, so its state outlives code changes."""
import base64
import contextlib
import fcntl
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time

from . import config, ctl, termhost, transcripts

MAX_TERMS = 6
KEEP_DONE = MAX_TERMS  # finished terminals kept for re-attach; older ones are dropped with their output
_terms = {}  # sessionId -> Term: interactive CLIs opened from the page
_replies = {}  # sessionId -> {"proc", "log", "done_at", "error"} for replies sent from the page
_reply_lock = threading.Lock()
_start_lock = threading.Lock()  # one CLI start at a time, so parallel clicks never start two CLIs for one session
MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}")  # a model name a reply may pass on
OPEN_WAIT = 30.0  # seconds a terminal open waits for another server's open or host replacement to finish
OPEN_LOCK = "open.lock"  # file in the run folder locked while a server checks, replaces or opens in the terminal host
SPAWN_WAIT = 10.0  # seconds a freshly started terminal host gets to answer (an interpreter start on a loaded machine)
# The terminal host connection: spawned process (when this server started it), list watcher, last error, newest list generation applied.
_host = {"proc": None, "watch": None, "synced": threading.Event(), "error": "", "gen": -1, "closing": False, "lock": threading.Lock(),
         "mirror": threading.Lock(), "token": None, "rd": None, "hello": None}


def child_env():
    """The CLI's environment: the server's own, minus a parent Claude session's variables when started from inside one."""
    nested = "CLAUDECODE" in os.environ
    env = {k: v for k, v in os.environ.items() if not (nested and k.startswith(("CLAUDE", "ANTHROPIC"))) and k != "DESK_DETACHED"}
    env.update(TERM="xterm-256color", COLORTERM="truecolor")
    return env


class Term(termhost.Term):
    """One interactive `claude --resume` in a pseudo-terminal, as a child of this server (DESK_TERMHOST=0); same code as the host's terminals."""

    def __init__(self, sid, cwd, cols, rows):
        super().__init__(sid, [config.CLAUDE, "--resume", sid], cwd, child_env(), cols, rows, lambda: None)

    def stop(self):
        """Hang up, as closing a terminal window does."""
        self.kill_group(signal.SIGHUP)


class Remote:
    """A page terminal owned by the terminal host; pid, start time and exit code mirror the host's list."""
    remote = True

    def __init__(self, info):
        self.sid = info["id"]
        self.set(info)

    def set(self, info):
        """Take the host's view of the terminal."""
        self.pid, self.t0, self.code = info["pid"], info["t0"], info["code"]

    def call(self, op, timeout=5.0, **kw):
        """One request about this terminal to the host."""
        return termhost.call(config.run_dir(), dict(kw, op=op, id=self.sid), timeout)

    def end(self, wait=4):
        """Hang up, wait, then kill the CLI's group; the host does the waiting."""
        try:
            r = self.call("end", timeout=wait + 5, wait=wait)
            if "term" in r:
                self.set(r["term"])
        except termhost.HostError:
            self.code = termhost.LOST if self.code is None else self.code

    def resize(self, cols, rows):
        """Pass the page's terminal size on; ignored once the terminal closed."""
        try:
            self.call("resize", cols=cols, rows=rows)
        except termhost.HostError:
            pass

    def write(self, data):
        """Send keys; returns an error string when the terminal or the host is gone."""
        try:
            return self.call("input", data=base64.b64encode(data).decode()).get("error")
        except termhost.HostError as e:
            return str(e)

    def stop(self):
        """Hang up, as closing a terminal window does."""
        try:
            self.call("hangup")
        except termhost.HostError:
            pass

    def stream(self, pos):
        """Messages from the host's output stream; an exit message when the host is gone."""
        try:
            s = termhost.connect(config.run_dir())
        except (OSError, termhost.HostError):
            yield {"exit": termhost.LOST if self.code is None else self.code}
            return
        try:
            s.settimeout(termhost.PING * 4)
            termhost.send(s, {"op": "stream", "v": termhost.PROTOCOL, "id": self.sid, "pos": pos})
            for msg in termhost.lines(s):
                yield msg
                if "exit" in msg or "error" in msg:
                    return
        except (OSError, ValueError):
            pass
        finally:
            s.close()
        yield {"exit": termhost.LOST if self.code is None else self.code}


def stream(term, pos, wait=15):
    """Output messages of any terminal from byte offset pos: {"pos", "data"} chunks, {"ping"} while idle, then {"exit"}."""
    if getattr(term, "remote", False):
        yield from term.stream(pos)
        return
    while True:
        with term.cond:
            pos = max(pos, term.start) if pos <= term.start + len(term.buf) else term.start  # past the end: an older terminal's offset, replay
            if pos >= term.start + len(term.buf) and term.code is None:
                term.cond.wait(wait)
            chunk, code = bytes(term.buf[pos - term.start:]), term.code
        if chunk:
            pos += len(chunk)
            yield {"pos": pos, "data": base64.b64encode(chunk).decode()}
        elif code is not None:
            yield {"exit": code}
            return
        else:
            yield {"ping": 1}


def hosted():
    """True when page terminals live in the terminal host (the default), False when they are children of this server."""
    return config.TERMHOST


def _apply(infos, gen):
    """Mirror the host's terminal list into _terms; an older list than one already applied is ignored."""
    with _host["mirror"]:
        if gen >= _host["gen"]:
            _host["gen"] = gen
            _mirror(infos)


def _adopt(info, gen):
    """Mirror one terminal the host just started or handed back."""
    with _host["mirror"]:
        _host["gen"] = max(_host["gen"], gen)
        t = _terms.get(info["id"])
        if isinstance(t, Remote) and t.t0 == info["t0"]:
            t.set(info)
        else:
            _terms[info["id"]] = Remote(info)


def _mirror(infos):
    """Replace the mirrored terminals with the host's list."""
    seen = set()
    for info in infos:
        seen.add(info["id"])
        t = _terms.get(info["id"])
        if isinstance(t, Remote) and t.t0 == info["t0"]:
            t.set(info)
        else:
            _terms[info["id"]] = Remote(info)
    for sid, t in list(_terms.items()):
        if isinstance(t, Remote) and sid not in seen:
            _terms.pop(sid, None)


def _lost():
    """The host connection dropped: running terminals count as ended until a list says otherwise; reap a host this server started."""
    with _host["mirror"]:
        for t in list(_terms.values()):
            if isinstance(t, Remote) and t.code is None:
                t.code = termhost.LOST
        _host["synced"].clear()
        _host["gen"] = -1
    proc = _host["proc"]
    if proc is not None and proc.poll() is not None:
        _host["proc"] = None


def _watch(rd, me):
    """Follow the host's terminal list until the host goes away, this server closes, or a newer watcher takes over."""
    current = lambda: _host["token"] is me and not _host["closing"]  # noqa: E731
    while current():
        try:
            s = termhost.connect(rd)
        except (OSError, termhost.HostError):
            break
        try:
            s.settimeout(termhost.PING * 4)
            termhost.send(s, {"op": "watch", "v": termhost.PROTOCOL})
            for msg in termhost.lines(s):
                if not current():
                    break
                if msg.get("error") == "protocol":
                    _host["error"] = termhost.mismatch(msg.get("v"))
                    break
                if "terms" in msg:
                    _apply(msg["terms"], msg.get("gen", 0))
                    _host["synced"].set()
        except (OSError, ValueError):
            pass
        finally:
            s.close()
        if _host["token"] is me:
            _lost()
        if _host["error"]:
            break
        time.sleep(0.2)
    if _host["token"] is me:
        _lost()


def _spawn(rd):
    """Start a terminal host for this run folder in its own session, logging into the run folder; the host rotates that log under its lock."""
    termhost.private_dir(rd)
    log_path = os.path.join(rd, termhost.LOG)
    pkg = __name__.rpartition(".")[0]
    with ctl.open_log(log_path) as log:
        _host["proc"] = subprocess.Popen([sys.executable, "-m", f"{pkg}.termhost", "--dir", rd], cwd=config.HERE, stdin=subprocess.DEVNULL,
                                         stdout=log, stderr=log, start_new_session=True)


def host_hello(timeout=1.0):
    """The host's hello answer, or None when no host runs for this data folder."""
    try:
        return termhost.call(config.run_dir(), {"op": "hello"}, timeout, version=False)
    except (OSError, termhost.HostError):
        return None


def older(hello):
    """True when a host's code differs from the terminal host code this server loaded (a host from before an update)."""
    return hello is not None and hello.get("codeVersion") != termhost.CODE_VERSION


def stale_note(hello):
    """What health and status say about a host whose code differs from this server's, or None."""
    if not older(hello):
        return None
    if isinstance(hello.get("codeVersion"), int) and hello["codeVersion"] > termhost.CODE_VERSION:
        return "terminal host is newer than this server; run `python3 server.py restart`"
    return "terminal host is older than this server; it keeps running until its terminals end, or run `python3 server.py stop-terminals`"


def _replace(hello):
    """Stop an older host that holds no live terminal, so the next start runs the current code."""
    _host["token"], _host["watch"] = None, None  # its watcher stops mirroring
    stop_host(4.0, hello)


def attach(spawn=False):
    """Connect to this data folder's terminal host (starting one when `spawn`) and mirror its list; returns an error string or None.
    With `spawn`, a host older than this server's code that has no live terminal is replaced first."""
    with _host["lock"]:
        w = _host["watch"]
        rd = config.run_dir()
        if w is not None and w.is_alive() and _host["synced"].is_set() and _host["rd"] == rd and not (spawn and older(_host["hello"])):
            return None
        hello = host_hello(2.0)
        if spawn and hello is not None and hello.get("v") == termhost.PROTOCOL and older(hello) and not hello.get("terms"):
            _replace(hello)
            hello = host_hello(0.5)  # None unless another server started a host meanwhile
        _host["hello"] = hello
        if hello is None:
            if not spawn:
                return "terminal host not running"
            try:
                _spawn(rd)
            except (OSError, termhost.HostError) as e:
                _host["error"] = f"could not start the terminal host: {type(e).__name__}"
                return _host["error"]
            end = time.monotonic() + SPAWN_WAIT
            while hello is None and time.monotonic() < end and _host["proc"].poll() is None:
                time.sleep(0.05)
                hello = host_hello()
            if hello is None:
                hello = host_hello()  # a host for this folder started by another server at the same moment wins the lock
            if hello is None:
                _host["error"] = "terminal host did not start; see " + os.path.join(rd, termhost.LOG)
                return _host["error"]
            _host["hello"] = hello
        if hello.get("v") != termhost.PROTOCOL:
            _host["error"] = termhost.mismatch(hello.get("v"))
            return _host["error"]
        _host["error"], _host["closing"] = "", False
        if w is None or not w.is_alive() or _host["rd"] != rd or _host["watch"] is None:
            _host["synced"].clear()
            me = _host["token"] = object()
            _host["rd"], _host["watch"] = rd, threading.Thread(target=_watch, args=(rd, me), daemon=True, name="desk-termhost")
            _host["watch"].start()
        _host["synced"].wait(5.0)
        return None if _host["synced"].is_set() else "terminal host did not send its list"


def host_status():
    """Terminal host state for health: mode, running, protocol, pid, uptime, terminals, last error (no text from terminals)."""
    if not hosted():
        return {"mode": "local", "running": False, "terms": live_count()}
    h = host_hello(0.5)
    out = {"mode": "host", "running": h is not None, "error": _host["error"] or None, "attached": _host["synced"].is_set(), "peerCheck": termhost.peer_check()}
    if h:
        out.update(protocol=h.get("v"), pid=h.get("pid"), uptime=max(0, int(time.time() - h.get("started", 0) / 1000)), terms=h.get("terms"),
                   codeVersion=h.get("codeVersion") if isinstance(h.get("codeVersion"), int) else None, older=older(h), note=stale_note(h))
    return out


def shutdown(wait=4.0):
    """Server exit: end running replies; page terminals end too only when they are children of this server."""
    _host["closing"] = True
    if not hosted():
        return stop_all(wait)
    _end_replies(wait)


def stop_host(wait=8.0, hello=None):
    """Ask this data folder's terminal host to end every terminal and exit, and wait until it has; returns how many terminals ended, or None when none ran."""
    hello = hello or host_hello()
    try:
        r = termhost.call(config.run_dir(), {"op": "stop", "wait": wait}, wait + 5, version=False)
    except (OSError, termhost.HostError):
        r = None
    proc, end = _host["proc"], time.monotonic() + wait
    if proc is not None:
        try:
            proc.wait(wait)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(2)
        _host["proc"] = None
    elif hello and isinstance(hello.get("pid"), int):
        while time.monotonic() < end and _exists(hello["pid"]):
            time.sleep(0.05)
    return None if r is None else r.get("ended", 0)


def _exists(pid):
    """True while a process with this id exists."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def term_alive(sid):
    """True while the page-owned CLI of a session runs."""
    t = _terms.get(sid)
    return t is not None and t.code is None


def own_pid(sid):
    """Process id of the page-owned CLI of a session, or None."""
    return _terms[sid].pid if term_alive(sid) else None


def live_count():
    """Number of page terminals still running."""
    return sum(1 for t in list(_terms.values()) if t.code is None)


def stop_all(wait=4.0):
    """Hang up every page terminal (the terminal host's too, which then exits) and running reply; kill what is left after `wait` seconds."""
    with _reply_lock:
        procs = [r["proc"] for r in _replies.values() if r["proc"] is not None and r["proc"].poll() is None]
    terms = [t for t in list(_terms.values()) if t.code is None and not isinstance(t, Remote)]
    for t in terms:
        t.stop()
    for p in procs:
        p.terminate()
    deadline = time.monotonic() + wait
    if hosted():
        stop_host(wait)
    for t in terms:
        t.end(max(0.0, deadline - time.monotonic()))
    _wait_procs(procs, deadline)


def _end_replies(wait):
    """Stop running replies; kill those still there after `wait` seconds."""
    with _reply_lock:
        procs = [r["proc"] for r in _replies.values() if r["proc"] is not None and r["proc"].poll() is None]
    for p in procs:
        p.terminate()
    _wait_procs(procs, time.monotonic() + wait)


def _wait_procs(procs, deadline):
    """Wait for processes until the deadline, then kill and reap the rest."""
    for p in procs:
        try:
            p.wait(max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait(2)


def _prune():
    """Drop the oldest finished terminals beyond KEEP_DONE."""
    done = sorted((t.t0, sid) for sid, t in list(_terms.items()) if t.code is not None)
    for _, sid in done[:max(0, len(done) - KEEP_DONE)]:
        _terms.pop(sid, None)


def reply_state(sid):
    """Reap a finished reply process; return 'running', 'answered' or None for a session."""
    with _reply_lock:
        r = _replies.get(sid)
        if not r:
            return None
        if r["proc"] is not None:
            code = r["proc"].poll()
            if code is None:
                return "running"
            r["log"].seek(0)
            tail = r["log"].read()[-300:].strip()
            r["log"].close()
            r.update(proc=None, done_at=int(time.time() * 1000), error=tail if code else "", code=code)
        return "answered"


def send_reply(sid, text):
    """Continue a session with the user's reply through `claude -p --resume`; returns an error string or None."""
    with _start_lock:
        return _send_reply(sid, text)


def _send_reply(sid, text):
    """send_reply without the start lock."""
    from . import sessions
    path = transcripts.find(sid)
    if not path:
        return "session not found"
    off = config.cli_error("reply")
    if off:
        return off
    if reply_state(sid) == "running" or sessions.live().get(sid, ("",))[0] == "busy":
        return "session is still working"
    d = sessions.parse(path)
    if not os.path.isdir(d["cwd"]):
        return "session folder no longer exists"
    model = d["model"] if isinstance(d["model"], str) and MODEL.fullmatch(d["model"]) else None  # from the session file: never a flag
    cmd = [config.CLAUDE, "-p", "--resume", sid] + (["--model", model] if model else [])
    log = tempfile.TemporaryFile(mode="w+", errors="replace")
    try:
        proc = subprocess.Popen(cmd, cwd=d["cwd"], stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, text=True)
    except OSError as e:
        return f"could not start claude: {e}"
    proc.stdin.write(text)
    proc.stdin.close()
    with _reply_lock:
        _replies[sid] = {"proc": proc, "log": log, "done_at": 0, "error": ""}
    return None


def open_term(sid, cols, rows, fresh=False):
    """Start or reuse the interactive CLI of a session, restarting it when it fell behind; returns (error or None, restarted)."""
    with _start_lock:
        if not hosted():
            _prune()
        return _open_term(sid, cols, rows, fresh)


def _open_term(sid, cols, rows, fresh):
    """open_term without the start lock."""
    from . import sessions
    path = transcripts.find(sid)
    if not path:
        return "session not found", False
    d, again, alive = sessions.parse(path), False, term_alive(sid)
    if alive:
        hold = sessions.holders()
        if not (fresh or sessions.behind(sid, d, hold)):
            _terms[sid].resize(cols, rows)
            return None, False
    off = config.TERMS_OFF or config.cli_error()  # refused before anything is ended or spawned
    if off:
        return off, False
    if alive:
        if any(p["pid"] == own_pid(sid) and p["status"] == "busy" for p in hold.get(sid, [])):
            return "CLI is working; reload it when it finishes", False
        _terms[sid].end()
        again = True
    if not os.path.isdir(d["cwd"]):
        return "session folder no longer exists", False
    if live_count() >= MAX_TERMS:
        return f"{MAX_TERMS} terminals already open; end one first", False
    if not hosted():
        try:
            _terms[sid] = Term(sid, d["cwd"], cols, rows)
        except OSError as e:
            return f"could not start the CLI: {e.strerror or type(e).__name__}", False
        return None, again
    try:
        return _open_hosted(sid, d, cols, rows, again)
    except (OSError, termhost.HostError) as e:  # an unwritable or unsafe run folder: say why instead of "internal error"
        return f"could not start the terminal host: {getattr(e, 'strerror', None) or e}", False


def _open_hosted(sid, d, cols, rows, again):
    """Open a session's CLI in the terminal host under the run-folder lock; returns (error or None, restarted)."""
    req = {"op": "open", "id": sid, "cwd": d["cwd"], "argv": [config.CLAUDE, "--resume", sid], "env": child_env(), "cols": cols, "rows": rows, "max": MAX_TERMS}
    with _run_lock() as held:
        if not held:
            return "another server is opening a terminal; try again", False
        err = attach(spawn=True)  # under the lock: no other server opens a terminal in a host this one is replacing, or replaces it meanwhile
        if err:
            return err, False
        try:
            r = termhost.call(config.run_dir(), req)
        except termhost.HostError as e:
            return str(e), False
    if r.get("error"):
        return r["error"], False
    _adopt(r["term"], r.get("gen", 0))
    return None, again


@contextlib.contextmanager
def _run_lock(wait=None):
    """Exclusive lock of the run folder across servers while one checks, replaces or opens in the terminal host; yields False after `wait` seconds."""
    rd = termhost.private_dir(config.run_dir())
    fd = os.open(os.path.join(rd, OPEN_LOCK), os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0), 0o600)
    try:
        end = time.monotonic() + (OPEN_WAIT if wait is None else wait)
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() > end:
                    yield False
                    return
                time.sleep(0.05)
        yield True
    finally:
        os.close(fd)  # closing releases the lock


def term_action(sid, route, body):
    """Keys, resize or hang-up for a running terminal; returns an error string or None."""
    if not term_alive(sid):
        return "terminal not running"
    term = _terms[sid]
    try:
        if route.endswith("/input"):
            return term.write(str(body.get("data", "")).encode())
        elif route.endswith("/resize"):
            term.resize(int(body.get("cols") or 100), int(body.get("rows") or 30))
        else:
            term.stop()
    except (OSError, ValueError) as e:
        return str(e)
    return None
