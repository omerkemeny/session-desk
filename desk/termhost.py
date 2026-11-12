"""Terminal host: owns page terminals (CLIs in pseudo-terminals) and their output logs in its own session, so they outlive server restarts; JSON lines on a private Unix socket."""
import base64
import binascii
import fcntl
import hashlib
import json
import os
import pty
import select
import shutil
import signal
import socket
import socketserver
import struct
import sys
import tempfile
import termios
import threading
import time

from . import durable, messages

PROTOCOL = 1  # bump on any change to ops or fields; `hello` and `stop` keep their shape in every version
TERM_KEEP = 512_000  # bytes of output kept per terminal for re-attach
KEEP_DONE = 6  # finished terminals kept for re-attach; older ones are dropped with their output
IDLE = float(os.environ.get("DESK_TERMHOST_IDLE", "300"))  # seconds with no terminal and no server before the host exits
PING = 5  # seconds between keep-alives on stream and watch connections
MAX_LINE = 1 << 20  # longest request line accepted
HARD_MAX = 16  # live terminals the host ever runs, whatever `max` a server asks for
REQ_WAIT = 10  # seconds a peer gets to send its request line
SEND_WAIT = 60  # seconds a stream or watch write may block on a peer that stopped reading
MAX_NUM = 1 << 31  # numbers in requests stay below this
LOG_MAX = 1_000_000  # bytes before termhost.log is rotated to termhost.log.1
SOCK, LOCK, PIDFILE, LOG = "termhost.sock", "termhost.lock", "termhost.pid", "termhost.log"
SOCKDIR = "termhost.sockdir"  # file in the run folder naming the random short folder of the socket, when the run folder's path is too long
SUN_MAX = 100  # Unix socket paths longer than this fall back to a short private folder
SWEEP_AGE = 10.0  # seconds a dead short socket folder is left alone before a starting host removes it
DRAIN = 1.0  # seconds output is still read after the CLI exits, while its background children keep the terminal open
CODE_VERSION = int(os.stat(__file__).st_mtime * 1000)  # source time (ms) of this file when the process loaded it
PEER_NOTE = "no peer-credential check on this platform; the private 0700 run folder is the only guard"
MAXFD = max(256, min(os.sysconf("SC_OPEN_MAX") if hasattr(os, "sysconf") else 256, 65536))  # descriptors closed in a new CLI
RESET = tuple(getattr(signal, n) for n in ("SIGHUP", "SIGINT", "SIGTERM", "SIGPIPE", "SIGXFSZ") if hasattr(signal, n))  # default again in each CLI


CLI_MISSING = messages.say("termOpen", "cliMissing")  # open refused before spawning
LOST = -1  # exit code only when the host or the server lost a terminal without knowing how it ended


def exit_code(status):
    """A wait status as one number: the CLI's own exit code, 128 + signal number for a signal death (129 hang-up), LOST otherwise."""
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    return LOST


def findable(cmd, path=None):
    """True when a command (a path, or a name looked up on PATH) is an executable file, so a CLI is never started just to exit 127."""
    if os.sep in cmd:
        return os.path.isfile(cmd) and os.access(cmd, os.X_OK)
    return shutil.which(cmd, path=path) is not None


class HostError(Exception):
    """The host cannot be reached safely, or answered with another protocol."""


def run_dir(state_dir, home):
    """Private state folder of one data folder: .desk-run for ~/.claude, .desk-run-<hash> for any other."""
    home = os.path.realpath(home)
    if home == os.path.realpath(os.path.expanduser("~/.claude")):
        return os.path.join(state_dir, ".desk-run")
    return os.path.join(state_dir, ".desk-run-" + hashlib.sha1(home.encode()).hexdigest()[:12])


def safe_parent(path):
    """Refuse a folder whose parent anyone may write without the sticky bit (others could rename it away)."""
    try:
        parent = os.stat(os.path.dirname(os.path.abspath(path)))
    except FileNotFoundError:
        return  # created with this user's umask
    if parent.st_mode & 0o002 and not parent.st_mode & 0o1000:
        raise HostError(f"{os.path.dirname(path)} is writable by everyone without the sticky bit; choose another DESK_STATE_DIR")


def is_private(path):
    """True for a real folder (no link) owned by this user that nobody else may enter."""
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat_dir(st) and st.st_uid == os.getuid() and not st.st_mode & 0o077


def stat_dir(st):
    """True when an lstat result is a folder, not a link."""
    return (st.st_mode & 0o170000) == 0o040000


def private_dir(path):
    """Create a folder only this user can enter; refuse a link, one owned by someone else, or one in a folder others may rename it out of."""
    safe_parent(path)
    os.makedirs(path, mode=0o700, exist_ok=True)
    st = os.lstat(path)
    if not os.path.isdir(path) or os.path.islink(path) or st.st_uid != os.getuid():
        raise HostError(f"{path} is not a private folder of this user")
    if st.st_mode & 0o077:
        os.chmod(path, 0o700)
    return path


def sock_path(rd, create=False):
    """Socket path inside the run folder; when too long, inside a short random private folder named in the run folder (None when there is none yet).
    Only the host (`create`) makes that folder; read-only callers never create anything."""
    p = os.path.join(rd, SOCK)
    if len(p.encode()) <= SUN_MAX:
        return p
    rec = os.path.join(rd, SOCKDIR)
    try:
        with open(rec) as fh:
            short = fh.read().strip()
    except OSError:
        short = ""
    if not create:
        return os.path.join(short, SOCK) if short else None
    if short and is_private(short):
        return os.path.join(short, SOCK)  # left by a host that died; the lock is the caller's
    base = sock_base()
    safe_parent(os.path.join(base, "x"))
    short = tempfile.mkdtemp(prefix=f"desk-{os.getuid()}-", dir=base)  # random name, made 0700 by us: nobody can pre-create it
    durable.write(rec, short.encode())
    return os.path.join(short, SOCK)


def sock_base():
    """Folder that holds short socket folders: the runtime folder, else the per-user temp folder."""
    return os.environ.get("XDG_RUNTIME_DIR") or tempfile.gettempdir()  # per-user on macOS and on Linux with a runtime folder


def sweep(base=None, age=SWEEP_AGE):
    """Remove this user's short socket folders that no host serves any more (left by killed hosts); returns how many went.
    A folder stays while its socket answers, while it is younger than `age` seconds (a host may be starting), or when it holds anything else."""
    base, prefix, gone = base or sock_base(), f"desk-{os.getuid()}-", 0
    try:
        names = os.listdir(base)
    except OSError:
        return 0
    for name in names:
        d = os.path.join(base, name)
        if not name.startswith(prefix) or not is_private(d):
            continue
        try:
            inside = os.listdir(d)
            st = os.lstat(os.path.join(d, SOCK)) if inside == [SOCK] else os.lstat(d) if not inside else None
        except OSError:
            continue
        if st is None or time.time() - st.st_mtime < age or (inside and served(os.path.join(d, SOCK))):
            continue
        try:
            for n in inside:
                os.unlink(os.path.join(d, n))
            os.rmdir(d)
            gone += 1
        except OSError:
            pass
    return gone


def served(path):
    """True unless connecting to a Unix socket is refused or finds nothing (any other failure counts as served, to be safe)."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(0.5)
    try:
        s.connect(path)
        return True
    except (ConnectionRefusedError, FileNotFoundError):
        return False
    except OSError:
        return True
    finally:
        s.close()


def drop_sock(rd, path):
    """Remove the socket, and its short folder and record when it lived outside the run folder."""
    for p in (path,):
        try:
            os.unlink(p)
        except FileNotFoundError:
            pass
    if os.path.dirname(path) != rd:
        try:
            os.rmdir(os.path.dirname(path))
            os.unlink(os.path.join(rd, SOCKDIR))
        except OSError:
            pass


def peer_uid(sock):
    """User id of the process at the other end of a Unix socket (Linux ucred, macOS xucred), or None where the platform has no check."""
    if sys.platform.startswith("linux"):
        return struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, getattr(socket, "SO_PEERCRED", 17), struct.calcsize("3i")))[1]
    if sys.platform == "darwin":
        version, uid = struct.unpack_from("II", sock.getsockopt(0, getattr(socket, "LOCAL_PEERCRED", 1), 76))  # SOL_LOCAL 0, struct xucred
        return uid if version == 0 else -1
    return None


def peer_check():
    """True where the platform lets the host read a peer's user id (Linux, macOS)."""
    return sys.platform.startswith("linux") or sys.platform == "darwin"


def same_user(sock):
    """True when the peer runs as this user; any failure to read it is a refusal; only a platform without the check leans on the 0700 folder."""
    try:
        uid = peer_uid(sock)
    except (OSError, struct.error):
        return False
    return uid is None or uid == os.getuid()


def send(sock, obj):
    """Write one JSON line."""
    sock.sendall(json.dumps(obj, separators=(",", ":")).encode() + b"\n")


def connect(rd, timeout=5.0):
    """Open a checked connection to the host of a run folder: private folder, socket owned by this user, same-user peer."""
    path = sock_path(rd)
    try:
        st = os.lstat(path) if path else None
    except FileNotFoundError:
        st = None
    if st is None:
        raise HostError("terminal host not running")
    if st.st_uid != os.getuid() or st.st_mode & 0o077 or not is_private(os.path.dirname(path)):
        raise HostError("terminal host socket is not private; remove " + path)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(path)
        if not same_user(s):
            raise HostError("terminal host runs as another user")
    except (OSError, HostError):
        s.close()
        raise
    return s


def lines(sock):
    """Yield JSON objects read line by line until the peer closes."""
    f = sock.makefile("rb")
    while True:
        line = f.readline(MAX_LINE)
        if not line:
            return
        yield json.loads(line)


def call(rd, req, timeout=5.0, version=True):
    """One request, one answer; raises HostError when the host is gone or speaks another protocol."""
    try:
        s = connect(rd, timeout)
    except OSError as e:
        raise HostError(f"terminal host not reachable: {type(e).__name__}")
    try:
        send(s, dict(req, v=PROTOCOL))
        out = next(lines(s), None)
    except (OSError, ValueError) as e:
        raise HostError(f"terminal host connection failed: {type(e).__name__}")
    finally:
        s.close()
    if out is None:
        raise HostError("terminal host closed the connection")
    if version and out.get("error") == "protocol":
        raise HostError(mismatch(out.get("v")))
    return out


def mismatch(theirs):
    """Refusal text for a host that speaks another protocol, with how to stop it."""
    return (f"terminal host speaks protocol {theirs}, this server {PROTOCOL}; "
            "run `python3 server.py stop-terminals` (it ends the open page terminals), then try again")


class Term:
    """One interactive CLI in a pseudo-terminal, with a bounded log of its output."""

    def __init__(self, sid, argv, cwd, env, cols, rows, gone):
        self.sid, self.buf, self.start, self.code, self.cond = sid, bytearray(), 0, None, threading.Condition()
        self.io = threading.Lock()  # guards fd: no write or resize reaches a closed (and possibly reused) descriptor
        self.t0 = int(time.time() * 1000)
        self.gone = gone
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                for sig in RESET:
                    signal.signal(sig, signal.SIG_DFL)  # the host ignores some; the CLI must hang up and break pipes like any program
                os.closerange(3, MAXFD)  # no other terminal, socket or log reaches the CLI and its tools
                os.chdir(cwd)
                os.execvpe(argv[0], argv, env)
            finally:
                os._exit(127)
        os.set_inheritable(self.fd, False)  # forkpty leaves the master inheritable
        self.exited = 0.0
        self.resize(cols, rows)
        self.waiter = threading.Thread(target=self.reap, daemon=True)
        self.waiter.start()
        threading.Thread(target=self.pump, daemon=True).start()

    def reap(self):
        """Wait for the CLI itself to exit and record its code, even while a child it left behind keeps the terminal open."""
        try:
            code = exit_code(os.waitpid(self.pid, 0)[1])
        except (ChildProcessError, ValueError):
            code = LOST
        with self.cond:
            self.code, self.exited = code, time.monotonic()  # set before anything else, so no signal can reach a recycled pid
            self.cond.notify_all()

    def info(self):
        """What a server needs to know about the terminal."""
        with self.cond:
            return {"id": self.sid, "pid": self.pid, "t0": self.t0, "code": self.code, "end": self.start + len(self.buf)}

    def pump(self):
        """Copy CLI output into the log until the terminal closes, or DRAIN seconds after the CLI exited; then close the terminal."""
        while True:
            if not select.select([self.fd], [], [], 0.2)[0]:
                if self.code is not None and time.monotonic() - self.exited > DRAIN:
                    break  # the CLI is gone; a child it left behind holds the terminal open
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                data = b""
            if not data:
                break
            with self.cond:
                self.buf += data
                extra = len(self.buf) - TERM_KEEP
                if extra > 0:
                    del self.buf[:extra]
                    self.start += extra
                self.cond.notify_all()
        self.waiter.join()
        with self.io:
            os.close(self.fd)  # hangs up whatever still holds the other side
            self.fd = -1
        self.gone()

    def end(self, wait=4.0):
        """Hang up and wait for the CLI to go; kill its group if it lingers."""
        self.kill_group(signal.SIGHUP)
        with self.cond:
            self.cond.wait_for(lambda: self.code is not None, wait)
        if self.code is None:
            self.kill_group(signal.SIGKILL)
            with self.cond:
                self.cond.wait_for(lambda: self.code is not None, 2)

    def resize(self, cols, rows):
        """Set the window size; ignored once the terminal closed."""
        with self.io:
            if self.fd >= 0:
                fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(5, min(rows, 300)), max(20, min(cols, 500)), 0, 0))

    def write(self, data):
        """Send keys; returns an error string once the terminal closed."""
        with self.io:
            if self.fd < 0:
                return "terminal not running"
            os.write(self.fd, data)
        return None

    def kill_group(self, sig):
        """Signal the CLI's whole process group (its own tools too) while the CLI runs."""
        if self.code is not None:
            return
        try:
            os.killpg(self.pid, sig)
        except (ProcessLookupError, PermissionError):
            try:
                os.kill(self.pid, sig)
            except ProcessLookupError:
                pass


class Host:
    """Every terminal of one run folder, the watchers (servers) connected, and the idle clock."""

    def __init__(self):
        self.terms, self.lock, self.changed = {}, threading.Lock(), threading.Condition()
        self.gen, self.watchers, self.seen, self.started = 0, 0, time.monotonic(), int(time.time() * 1000)
        self.stopping = threading.Event()

    def bump(self):
        """Wake watchers: the terminal list changed."""
        with self.changed:
            self.gen += 1
            self.changed.notify_all()

    def live(self):
        """Terminals whose CLI still runs."""
        return [t for t in list(self.terms.values()) if t.code is None]

    def listing(self):
        """Every kept terminal, as info dicts."""
        return [t.info() for t in list(self.terms.values())]

    def hello(self):
        """Version, pid, start time and terminal count; same shape in every protocol version."""
        return {"app": "session-desk-termhost", "v": PROTOCOL, "pid": os.getpid(), "started": self.started, "terms": len(self.live()),
                "codeVersion": CODE_VERSION, "peerCheck": peer_check()}

    def open(self, req):
        """Start a CLI for a session, or hand back the one already running; refuses beyond the cap (the server's, never above HARD_MAX)."""
        sid, argv, env, cwd = req.get("id"), req.get("argv"), req.get("env"), req.get("cwd")
        cols, rows, cap = num(req, "cols", 100), num(req, "rows", 30), min(num(req, "max", 6), HARD_MAX)
        if not (isinstance(sid, str) and 0 < len(sid) <= 128 and isinstance(cwd, str) and isinstance(argv, list) and argv
                and all(isinstance(a, str) for a in argv) and isinstance(env, dict) and all(isinstance(v, str) for v in env.values())):
            raise ValueError("bad open request")
        with self.lock:
            if self.stopping.is_set():
                return {"error": "terminal host is stopping; try again"}
            t = self.terms.get(sid)
            if t is not None and t.code is None:
                t.resize(cols, rows)
                return {"term": t.info(), "existing": True, "gen": self.gen}
            if len(self.live()) >= cap:
                return {"error": f"{cap} terminals already open; end one first"}
            if not findable(argv[0], env.get("PATH")):
                return {"error": CLI_MISSING}
            done = sorted((x.t0, k) for k, x in self.terms.items() if x.code is not None)
            for _, k in done[:max(0, len(done) - KEEP_DONE)]:
                self.terms.pop(k, None)
            t = self.terms[sid] = Term(sid, argv, cwd, env, cols, rows, self.bump)
        self.bump()
        return {"term": t.info(), "gen": self.gen}

    def term(self, req):
        """The kept terminal a request names, or None."""
        sid = req.get("id")
        return self.terms.get(sid) if isinstance(sid, str) else None

    def end_all(self, wait=4.0):
        """Hang up every terminal, wait up to `wait` seconds in total, then kill what is left; returns how many ran."""
        ts = self.live()
        for t in ts:
            t.kill_group(signal.SIGHUP)
        deadline = time.monotonic() + wait
        for t in ts:
            t.end(max(0.0, deadline - time.monotonic()))
        return len(ts)

    def stream(self, sock, t, pos):
        """Output from byte offset pos onward, keep-alives while idle, then the exit code."""
        while True:
            with t.cond:
                pos = max(pos, t.start) if pos <= t.start + len(t.buf) else t.start  # past the end: an offset of an older terminal, so replay
                if pos >= t.start + len(t.buf) and t.code is None:
                    t.cond.wait(PING)
                chunk, code = bytes(t.buf[pos - t.start:]), t.code
            if chunk:
                pos += len(chunk)
                send(sock, {"pos": pos, "data": base64.b64encode(chunk).decode()})
            elif code is not None:
                return send(sock, {"exit": code})
            else:
                send(sock, {"ping": 1})

    def watch(self, sock):
        """Push the terminal list now and on every change; a connected watcher keeps the host from idling out."""
        with self.changed:
            self.watchers += 1
        try:
            gen = -1
            while not self.stopping.is_set():
                with self.changed:
                    if gen == self.gen:
                        self.changed.wait(PING)
                    now = self.gen
                send(sock, {"terms": self.listing(), "gen": now} if now != gen else {"ping": 1})
                gen = now
        finally:
            with self.changed:
                self.watchers -= 1
                self.seen = time.monotonic()

    def idle(self):
        """True once there has been no live terminal and no watcher for IDLE seconds."""
        with self.changed:
            if self.watchers or self.live():
                self.seen = time.monotonic()
                return False
            return time.monotonic() - self.seen > IDLE


HOST = Host()


def num(req, key, default, lo=-MAX_NUM, hi=MAX_NUM):
    """An integer field of a request (default when missing or null); ValueError for any other type or a number out of range."""
    v = req.get(key)
    if v is None:
        return default
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo < v < hi:
        raise ValueError(f"bad {key}")
    return int(v)


class Handler(socketserver.StreamRequestHandler):
    """One connection: a same-user peer sends one request line; the answer is one line, or a stream for `stream` and `watch`."""
    timeout = REQ_WAIT  # a peer that never sends its line is dropped

    def handle(self):
        """Check the peer and the protocol, then run the request; malformed requests get an error line, never a dropped connection."""
        sock, h = self.request, HOST
        if not same_user(sock):
            return
        try:
            line = self.rfile.readline(MAX_LINE)
            req = json.loads(line) if line.endswith(b"\n") else None
            op = req["op"] if isinstance(req, dict) else None
            if not isinstance(op, str):
                return send(sock, {"error": "bad request"})
            with h.changed:
                h.seen = time.monotonic()
            sock.settimeout(SEND_WAIT)
            if op == "hello":
                return send(sock, h.hello())
            if op == "stop":
                n = h.end_all(min(max(0.0, float(num(req, "wait", 4))), 30.0))
                send(sock, {"ok": True, "ended": n})
                return h.stopping.set()
            if req.get("v") != PROTOCOL:
                return send(sock, {"error": "protocol", "v": PROTOCOL})
            try:
                out = self.run(h, op, req)
            except (ValueError, TypeError, binascii.Error):
                out = {"error": "bad request"}
            send(sock, out or {"ok": True})
        except ValueError:
            send(sock, {"error": "bad request"})
        except OSError:
            pass  # peer gone, too slow, or timed out

    def run(self, h, op, req):
        """Versioned operations; returns the answer, or None after a stream ended."""
        if op == "list":
            return {"terms": h.listing()}
        if op == "open":
            return h.open(req)
        if op == "watch":
            h.watch(self.request)
            return None
        if op not in ("stream", "end", "input", "resize", "hangup"):
            return {"error": "unknown op"}
        t = h.term(req)
        if t is None:
            return {"error": "terminal not running"}
        if op == "stream":
            h.stream(self.request, t, num(req, "pos", 0, hi=1 << 53))
            return None
        if op == "end":
            t.end(min(max(0.0, float(num(req, "wait", 4))), 30.0))
            return {"term": t.info()}
        if t.code is not None:
            return {"error": "terminal not running"}
        try:
            if op == "input":
                data = req.get("data", "")
                if not isinstance(data, str):
                    raise ValueError("bad data")
                err = t.write(base64.b64decode(data, validate=True))
                return {"error": err} if err else None
            if op == "resize":
                t.resize(num(req, "cols", 100), num(req, "rows", 30))
            else:
                t.kill_group(signal.SIGHUP)
        except OSError as e:
            return {"error": type(e).__name__}
        return None


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """Threaded Unix socket server; connection threads never hold the process open."""
    daemon_threads = True


def rotate(path, limit=LOG_MAX):
    """Move a log past `limit` bytes to <name>.1, keeping one old copy."""
    try:
        if os.path.getsize(path) > limit:
            os.replace(path, path + ".1")
    except OSError:
        pass


def rotate_own_log(path, limit=LOG_MAX):
    """Under the host lock: rotate the log behind stdout and stderr when it is too big, then write to a fresh file."""
    try:
        st, out = os.stat(path), os.fstat(1)
        if (st.st_dev, st.st_ino) != (out.st_dev, out.st_ino) or st.st_size <= limit:
            return  # stdout is not this log (a test, a terminal), or it is small
        os.replace(path, path + ".1")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        os.dup2(fd, 1)
        os.dup2(fd, 2)
        os.close(fd)
    except OSError:
        pass


def main(argv=None):
    """Run the host of one run folder until stopped, signalled or idle; a second host for the same folder exits at once."""
    args = sys.argv[1:] if argv is None else argv
    rd = private_dir(os.path.abspath(args[args.index("--dir") + 1]))
    lock = os.open(os.path.join(rd, LOCK), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return 0  # another host owns this folder
    rotate_own_log(os.path.join(rd, LOG))  # only the lock holder rotates, so two starting hosts never both move it
    if len(os.path.join(rd, SOCK).encode()) > SUN_MAX:
        sweep()  # dead socket folders of killed hosts, this run folder's included (the lock is ours, so its host is dead)
    path = sock_path(rd, create=True)
    try:
        os.unlink(path)  # left by a host that died; safe, the lock is ours
    except FileNotFoundError:
        pass
    old = os.umask(0o177)
    try:
        srv = Server(path, Handler)
    finally:
        os.umask(old)
    os.chmod(path, 0o600)
    durable.drop_stale_temps(os.path.join(rd, PIDFILE))
    durable.write(os.path.join(rd, PIDFILE), str(os.getpid()).encode())
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: HOST.stopping.set())
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True).start()
    print(f"terminal host {os.getpid()} protocol {PROTOCOL} on {path}", flush=True)
    if not peer_check():
        print("terminal host: " + PEER_NOTE, flush=True)
    while not HOST.stopping.wait(1.0):
        if HOST.idle():
            print("terminal host idle, exiting", flush=True)
            break
    HOST.stopping.set()
    HOST.bump()
    srv.shutdown()
    HOST.end_all()
    drop_sock(rd, path)
    try:
        os.unlink(os.path.join(rd, PIDFILE))
    except FileNotFoundError:
        pass
    srv.server_close()
    print("terminal host stopped", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
