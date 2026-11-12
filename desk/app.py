"""Start and stop the server: each request picks up reloaded code; SIGTERM and SIGINT shut down cleanly; page terminals live on in the terminal host."""
import atexit
import errno
import os
import shutil
import signal
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer

from . import config, ctl, durable, memprobe, messages, reloader, terms, web  # noqa: F401  (web loads the whole package)


FD_SPARE = 32  # descriptors kept free for the files a request opens (transcripts, stats, the host socket) while connections pile up


def soft_limit():
    """This process's soft descriptor limit, or None when unlimited or unknown."""
    try:
        import resource
        soft = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
    except (ImportError, OSError, ValueError):
        return None
    return None if soft == resource.RLIM_INFINITY else soft


class Server(ThreadingHTTPServer):
    """Threaded HTTP server bound to 127.0.0.1; `closing` tells long streams to end. Near the descriptor limit it stops accepting for a moment,
    so a burst waits in the backlog instead of failing to open a transcript."""
    daemon_threads = True
    closing = False
    request_queue_size = 256  # a burst of connections waits in the backlog instead of being refused
    inflight = 0  # accepted connections not yet closed

    def full(self):
        """True while one more connection would leave fewer than FD_SPARE descriptors free; counted only under pressure."""
        soft = soft_limit()
        if soft is None or self.inflight < soft // 4:
            return False
        used = sys.modules[f"{reloader.PACKAGE}.watch"].open_fds()
        return used is not None and used + FD_SPARE >= soft

    def get_request(self):
        """Accept one connection once there is descriptor room; an OSError (skipped by the serve loop) while closing."""
        while self.full():
            if self.closing:
                raise OSError("closing")
            time.sleep(0.01)
        conn = self.socket.accept()
        with _gate:
            self.inflight += 1
        return conn

    def shutdown_request(self, request):
        """Close a connection and give its descriptor back to the budget."""
        try:
            super().shutdown_request(request)
        finally:
            with _gate:
                self.inflight -= 1


_gate = threading.Lock()


def handler(*args):
    """Build the request handler from the current web module, reloading changed code first."""
    reloader.check()
    return sys.modules[f"{reloader.PACKAGE}.web"].Handler(*args)


def make_server(port=None):
    """A server on 127.0.0.1 (port 0 picks a free one), with reload tracking started."""
    reloader.init()
    return Server(("127.0.0.1", config.PORT if port is None else port), handler)


def shutdown():
    """End running replies, a running stats worker, and page terminals unless the terminal host owns them."""
    terms.shutdown()
    stats = sys.modules.get(f"{reloader.PACKAGE}.stats")
    if stats is not None:
        stats.stop_worker()


def taken(port):
    """What to print when the port is in use: this data folder's own server (with its URL) or another program."""
    cur = ctl.running()
    if cur and cur["port"] == port:
        return f"Session Desk already runs for this data folder: pid {cur['pid']}, http://127.0.0.1:{port}"
    return f"Session Desk: port {port} is in use by another program; start on another port, for example PORT=9000 python3 server.py"


def read_only_mode():
    """Read-only state folder: keep this run's caches in a private temp folder removed at exit, and turn page terminals off."""
    tmp = tempfile.mkdtemp(prefix=f"session-desk-cache-{os.getpid()}-")
    atexit.register(shutil.rmtree, tmp, True)
    config.STATS_FILE = os.path.join(tmp, ".stats-cache.json")
    config.TERMS_OFF = messages.say("termOpen", "readOnly")
    return messages.say("startLine", "readOnly")


def sweep_temps():
    """Remove temp files a killed writer left beside the stats cache and the summary cache (they may hold session text); returns how many."""
    paths = [config.stats_file(), sys.modules[f"{reloader.PACKAGE}.summaries"].cache_file()]
    return sum(durable.drop_stale_temps(p) for p in paths)


def already(cur):
    """What to print when this data folder's server already runs."""
    return (f"Session Desk already runs for this data folder: pid {cur['pid']}, http://127.0.0.1:{cur['port']}  "
            "(open it, or stop it with `python3 server.py stop`)")


def main():
    """Run until Ctrl+C or SIGTERM; one server per state and data folder; exit 1 with a plain message when the port is taken or the folder's server runs."""
    memprobe.start()
    note = read_only_mode() if config.state_state() != "ok" else ""
    with ctl.start_lock(not note) as held:
        cur = ctl.running() if held or os.path.isdir(config.run_dir()) else None
        if cur and cur["pid"] != os.getpid():
            print(already(cur), flush=True)
            return 1
        try:
            server = make_server()
        except OSError as e:
            if e.errno != errno.EADDRINUSE:
                raise
            print(taken(config.PORT), flush=True)
            return 1
        port = server.server_address[1]
        if not note:
            ctl.write_pid(port)
            sweep_temps()  # under the start lock: no other server of this folder writes now

    def stop(signum, frame):
        """Ask the serve loop to finish; shutdown must run outside the loop's own thread."""
        server.closing = True
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    atexit.register(shutdown)
    if terms.hosted() and not note:
        err = terms.attach()
        if err and err != "terminal host not running":
            print(f"Session Desk: {err}", flush=True)
    threading.Thread(target=lambda: sys.modules[f"{reloader.PACKAGE}.web"].warm(), daemon=True, name="desk-warm").start()
    if os.environ.get("DESK_DETACHED"):
        threading.Thread(target=ctl.rotate_loop, daemon=True, name="desk-log").start()
    keep = "; page terminals keep running" if terms.hosted() and not note else ""
    print(f"Session Desk: http://127.0.0.1:{port}  (Ctrl+C to stop{keep})", flush=True)
    hint = sys.modules[f"{reloader.PACKAGE}.firstrun"].setup()["hint"]
    for line in (note, hint if not note else ""):
        if line:
            print("  " + line, flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        shutdown()
        ctl.clear_pid()
        print("Session Desk stopped.", flush=True)
