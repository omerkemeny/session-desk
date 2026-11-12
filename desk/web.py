"""HTTP side: guards, the page with its token, static files from web/, the JSON routes, terminal and change streams."""
import inspect
import json
import os
import re
import secrets
import select
import socket
import struct
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, unquote, urlparse

from . import config, events, firstrun, memprobe, reloader, sessions, stats, terms, transcripts as tx

SHELL = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>'
VENDOR = {"xterm.js": "text/javascript", "xterm-addon-fit.js": "text/javascript", "xterm-addon-web-links.js": "text/javascript", "xterm.css": "text/css"}  # bundled terminal library
TYPES = {".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png",
         ".svg": "image/svg+xml", ".gif": "image/gif", ".webp": "image/webp", ".woff2": "font/woff2"}  # what web/ may serve
TEXTUAL = ("text/", "application/json", "image/svg+xml")
SAFE = (("X-Frame-Options", "DENY"), ("Content-Security-Policy", "frame-ancestors 'none'"), ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"))  # on every answer: no framing (clickjacking a live terminal), no type sniffing
MAX_BODY = 100_000  # bytes of a write request body
MAX_STREAMS = 16  # terminal output streams open at once; more get 503
WEB_CHECK = 5.0  # seconds between walks of web/ for webVersion
_streams = globals().get("_streams") or {"n": 0, "lock": threading.Lock()}  # kept across reloads
_listed = globals().get("_listed") or {"done": False}  # kept across reloads: True once the first session list was built (health setup.warming)
_webv = {"at": None, "v": 0, "root": None}  # newest page file time, when it was checked, for which folder
PAGES = ("/legend.html", "/gallery.html")  # extra read-only pages, served as they are: no token shell
MAX_IDS = 100  # session ids one partial list request may name
KEY_ARGS = ("keys", "file_keys")  # names under which a list function may take the feed's transcript stat keys
HOLD_ARGS = ("hold", "holders")  # names under which it may take the live-process map
WRITES = ("/api/reply", "/api/term/open", "/api/term/input", "/api/term/resize", "/api/term/close")
ICON_ART = ("................", ".....PPPPPP.....", "....PppppppP....", "....PppppppP....", "..PPPPPPPPPPPP..", "...oooooooooo...",
            "..oohhoooooooo..", "..ookooooookoo..", "..ookooooookoo..", "..oooooooooooo..", "..occoooooocco..", "..oooooooooooo..",
            "..dooooooooood..", "...dddddddddd...", "...xx......xx...", "................")  # 16x16 page character, '.' is clear
ICON_COL = {"P": "55339c", "p": "7b4fd0", "o": "d97757", "h": "f0a283", "d": "b85c3c", "x": "86391f", "k": "231815", "c": "f19486"}


def icon():
    """The favicon: ICON_ART as one 16x16 RGBA PNG inside an .ico container."""
    rows = b"".join(b"\0" + b"".join(bytes.fromhex(ICON_COL[ch]) + b"\xff" if ch in ICON_COL else b"\0\0\0\0" for ch in row) for row in ICON_ART)
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))  # noqa: E731
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 16, 16, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")
    return struct.pack("<HHHBBBBHHII", 0, 1, 1, 16, 16, 0, 0, 1, 32, len(png), 22) + png


FAVICON = icon()


def page_file():
    """The page markup, web/index.html."""
    return os.path.join(config.WEB, "index.html")


def vendor_file(name):
    """Path of a bundled terminal-library file in web/vendor/."""
    return os.path.join(config.WEB, "vendor", name)


def static_file(raw):
    """Resolve a request path to (file, type) inside web/, or None when any rule fails: no dot segments or dotfiles, allowed type, stays inside."""
    rel = unquote(raw)
    if not rel.startswith("/") or "\\" in rel or "\0" in rel:
        return None
    parts = rel[1:].split("/")
    if any(not p or p.startswith(".") for p in parts):
        return None
    ctype = TYPES.get(os.path.splitext(parts[-1])[1].lower())
    if not ctype:
        return None
    base = os.path.realpath(config.WEB)
    full = os.path.realpath(os.path.join(base, *parts))
    if os.path.commonpath([base, full]) != base or not os.path.isfile(full):
        return None
    return full, ctype


def number(v, default):
    """Integer from a request field (default when empty); ValueError for anything else."""
    try:
        return int(v or default)
    except TypeError:
        raise ValueError("not a number")


def web_version():
    """Newest modification time (ms) of any file web/ may serve; walked at most once per WEB_CHECK seconds."""
    now = time.monotonic()
    if _webv["at"] is not None and now - _webv["at"] < WEB_CHECK and _webv["root"] == config.WEB:
        return _webv["v"]
    newest = 0
    for base, dirs, files in os.walk(config.WEB):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if name.startswith(".") or os.path.splitext(name)[1].lower() not in TYPES and name != "index.html":
                continue
            try:
                newest = max(newest, os.stat(os.path.join(base, name)).st_mtime_ns)
            except OSError:
                pass
    _webv.update(at=now, v=newest // 1_000_000, root=config.WEB)
    return _webv["v"]


def feed_args(fn):
    """Keyword arguments that hand a list function what the change feed already knows, only those its signature accepts; (kwargs, counter or None)."""
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return {}, None
    names = [k for k in KEY_ARGS if k in params][:1] + [k for k in HOLD_ARGS if k in params][:1]
    got = events.list_inputs() if names else None
    if got is None:
        return {}, None
    return {k: got["keys"] if k in KEY_ARGS else got["hold"] for k in names}, got["n"]


def list_all():
    """`sessions.sessions()`, fed the change feed's keys and holders when it takes them."""
    kw, _ = feed_args(sessions.sessions)
    out = sessions.sessions(**kw)
    _listed["done"] = True
    return out


def warm():
    """Build the first session list once, so the page's first request finds it ready; health says `setup.warming` until then."""
    try:
        list_all()
    except Exception:
        _listed["done"] = True  # a broken list is not "still preparing"; the route reports its own error


def rows_for(ids):
    """`sessions.sessions_for(ids)` plus the feed counter its answer is valid for; where the data module lacks it, the same four keys from the full list."""
    n = events._feed["count"]
    fn = getattr(sessions, "sessions_for", None)
    if fn is not None:
        kw, at = feed_args(fn)
        if kw and "settled" in inspect.signature(fn).parameters:
            kw["settled"] = True  # the feed is fresh, so only the named and active sessions can have changed
        out = dict(fn(ids, **kw))
        n = n if at is None else at
    else:
        full, want = list_all(), set(ids)
        listed = {r["id"] for r in full}
        out = {"rows": [r for r in full if r["id"] in want or r["status"] != "done"], "gone": [i for i in ids if i not in listed],
               "order": [r["id"] for r in full], "today": sessions.day_of(sessions.CLOCK())}
    out["n"] = n
    return out


def max_ids():
    """Ids one partial request may name: the data module's limit when it has one."""
    return getattr(sessions, "PARTIAL_MAX", MAX_IDS)


def wanted_ids(query):
    """The ids of `?ids=a,b,c` in order without repeats; None when the route was asked for the full list; ValueError when any id is bad."""
    q = parse_qs(query, keep_blank_values=True)
    if "ids" not in q:
        return None
    if len(q["ids"]) != 1 or len(q["ids"][0]) > max_ids() * 65:
        raise ValueError("bad ids")
    ids = q["ids"][0].split(",")
    if len(ids) > max_ids() or not all(tx.SID.fullmatch(i) for i in ids):
        raise ValueError("bad ids")
    return list(dict.fromkeys(ids))


def health():
    """Server health: pid, uptime, code version and reload error, terminals and their host, change feed, workers, data-format checks, first-run setup (counts and names only)."""
    warn, notes, checked = tx.format_report()
    r, ev, host = reloader.status(), events.status(), terms.host_status()
    feed_ok = ev["running"] or not ev["clients"]
    setup = dict(firstrun.setup(), warming=not _listed["done"])
    out = {"ok": not r["error"] and not warn and feed_ok and not host.get("error") and firstrun.healthy(setup), "started": config.STARTED, "pid": os.getpid(),
            "uptime": max(0, int(time.time() - config.STARTED / 1000)), "codeVersion": r["version"], "webVersion": web_version(), "reloads": r["reloads"],
            "reloadError": r["error"], "restartNeeded": r["restart"], "terms": terms.live_count(), "maxTerms": terms.MAX_TERMS, "termhost": host, "events": ev,
            "workers": {"events": events.worker_status(), "stats": stats.worker_status()}, "fds": events.fds(),
            "setup": setup, "formatWarnings": warn, "formatNotes": notes, "formatChecked": checked}
    top = memprobe.top()
    if top is not None:
        out["memTop"] = top
    return out


class Handler(BaseHTTPRequestHandler):
    sent = False  # True once a status line went out, so a late error cannot send a second one
    timeout = 30  # seconds a client may stall while sending a request or reading an answer

    def hosts(self):
        """Host headers this server answers to: its own port on 127.0.0.1 or localhost."""
        port = self.server.server_address[1]
        return (f"127.0.0.1:{port}", f"localhost:{port}")

    def reply(self, code, body, ctype="application/json"):
        """Send one response."""
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.sent = True
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8" if ctype.startswith(TEXTUAL) else ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.safe_headers()
        self.end_headers()
        self.wfile.write(data)

    def safe_headers(self):
        """Headers every answer carries."""
        for k, v in SAFE:
            self.send_header(k, v)

    def cross_site(self, path):
        """True for a request another site made from the browser; only a top-level navigation to the page itself may come from elsewhere."""
        if self.headers.get("Sec-Fetch-Site") not in ("cross-site", "same-site"):
            return False
        return not (path == "/" and self.headers.get("Sec-Fetch-Mode") == "navigate" and self.headers.get("Sec-Fetch-Dest") in (None, "document"))

    def send_file(self, path, ctype):
        """Send a file from disk, or 404 when it cannot be read."""
        try:
            with open(path, "rb") as fh:
                return self.reply(200, fh.read(), ctype)
        except OSError:
            return self.reply(404, {"error": "not found"})

    def guarded(self, route):
        """Run a route; a dropped peer ends it quietly, any other error becomes a 500 without details."""
        try:
            route()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            if not self.sent:
                self.reply(500, {"error": "internal error"})
            self.close_connection = True

    def do_GET(self):
        """Guarded GET routing."""
        self.guarded(self.get)

    def do_POST(self):
        """Guarded POST routing."""
        self.guarded(self.post)

    def get(self):
        """Serve the page, static files and read-only JSON routes; refuse any non-local Host."""
        if self.headers.get("Host") not in self.hosts():
            return self.reply(403, {"error": "local only"})
        url = urlparse(self.path)
        if self.cross_site(url.path):
            return self.reply(403, {"error": "cross-site request"})
        if url.path == "/favicon.ico":
            return self.reply(200, FAVICON, "image/x-icon")
        if url.path.startswith("/vendor/"):
            name = url.path[8:]
            return self.send_file(vendor_file(name), VENDOR[name]) if name in VENDOR else self.reply(404, {"error": "not found"})
        if url.path == "/":
            with open(page_file(), "rb") as fh:
                return self.reply(200, (SHELL + f'<script>window.DESK_TOKEN="{config.TOKEN}"</script>').encode() + fh.read(), "text/html")
        if url.path in PAGES:
            base = os.path.realpath(config.WEB)
            full = os.path.realpath(os.path.join(base, url.path[1:]))
            ok = os.path.dirname(full) == base and os.path.isfile(full)
            return self.send_file(full, "text/html") if ok else self.reply(404, {"error": "not found"})
        if url.path == "/api/sessions":
            try:
                ids = wanted_ids(url.query)
            except ValueError:
                return self.reply(400, {"error": f"ids: 1 to {max_ids()} session ids, comma-separated"})
            return self.reply(200, list_all() if ids is None else rows_for(ids))
        if url.path == "/api/term/stream":
            term = terms._terms.get(parse_qs(url.query).get("id", [""])[0])
            if not term:
                return self.reply(404, {"error": "terminal not running"})
            last = self.headers.get("Last-Event-ID") or ""
            return self.term_stream(term, int(last) if last.isascii() and last.isdigit() and len(last) <= 15 else 0)
        if url.path == "/api/events":
            return self.change_stream()
        if url.path == "/api/session":
            path = tx.find(parse_qs(url.query).get("id", [""])[0])
            if not path:
                return self.reply(404, {"error": "not found"})
            try:
                evs, files = sessions.transcript(path)
            except FileNotFoundError:
                return self.reply(404, {"error": "not found"})
            return self.reply(200, {"events": evs, "files": sorted(files.items(), key=lambda kv: -kv[1])})
        if url.path == "/api/stats":
            return self.reply(200, stats.stats())
        if url.path == "/api/health":
            return self.reply(200, health())
        hit = None if url.path.startswith("/api/") else static_file(self.path.split("?", 1)[0].split("#", 1)[0])
        return self.send_file(*hit) if hit else self.reply(404, {"error": "not found"})

    def post(self):
        """Write routes: reply to a session, drive a page terminal. Local Host, same Origin and the page token are all required."""
        hosts = self.hosts()
        if self.headers.get("Host") not in hosts or self.headers.get("Origin") not in tuple("http://" + h for h in hosts):
            return self.reply(403, {"error": "local only"})
        if not secrets.compare_digest(self.headers.get("X-Desk-Token", ""), config.TOKEN):
            return self.reply(403, {"error": "bad token, reload the page"})
        route = urlparse(self.path).path
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self.close_connection = True
            return self.reply(400, {"error": "bad length"})
        if not 0 <= size <= MAX_BODY:
            self.close_connection = True  # the unread body must not be parsed as the next request
            return self.reply(413, {"error": "request too large"})
        try:
            body = json.loads(self.rfile.read(size)) if size else {}
        except ValueError:
            body = {}
        if not isinstance(body, dict):
            body = {}
        sid = str(body.get("id", ""))
        if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", sid):
            return self.reply(400, {"error": "id required"})
        if route == "/api/reply":
            text = str(body.get("text", "")).strip()
            err = terms.send_reply(sid, text) if text else "text required"
        elif route == "/api/term/open":
            try:
                cols, rows = number(body.get("cols"), 100), number(body.get("rows"), 30)
            except ValueError:
                return self.reply(400, {"error": "bad number"})
            err, again = terms.open_term(sid, cols, rows, bool(body.get("fresh")))
            if not err:
                return self.reply(200, {"ok": True, "restarted": again})
        elif route in WRITES:
            err = terms.term_action(sid, route, body)
        else:
            return self.reply(404, {"error": "not found"})
        return self.reply(409, {"error": err}) if err else self.reply(200, {"ok": True})

    def start_stream(self):
        """Headers of a server-sent event stream."""
        self.sent = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.safe_headers()
        self.end_headers()

    def term_stream(self, term, pos):
        """Server-sent events: terminal output from byte offset pos onward, then an exit event; at most MAX_STREAMS at once."""
        with _streams["lock"]:
            if _streams["n"] >= MAX_STREAMS:
                return self.reply(503, {"error": "too many terminal streams"})
            _streams["n"] += 1
        msgs = terms.stream(term, pos)
        try:
            self.start_stream()
            self.relay(msgs)
        finally:
            msgs.close()
            with _streams["lock"]:
                _streams["n"] -= 1

    def relay(self, msgs):
        """Write terminal messages as events until the exit event or a dropped peer."""
        try:
            for msg in msgs:
                if "data" in msg:
                    self.wfile.write(b"id: %d\ndata: %s\n\n" % (msg["pos"], msg["data"].encode()))
                elif ("exit" in msg or "error" in msg) and getattr(self.server, "closing", False):
                    return  # this server is going away, not the terminal: drop the stream, the page re-attaches
                elif "exit" in msg:
                    self.wfile.write(b"event: exit\ndata: %d\n\n" % int(msg["exit"]))
                    self.wfile.flush()
                    return
                elif "error" in msg:
                    self.wfile.write(b"event: exit\ndata: -1\n\n")
                    self.wfile.flush()
                    return
                else:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def change_stream(self):
        """Server-sent events: a counter that moves whenever the session list would change; the page then re-fetches it."""
        n = events.subscribe()
        if n is None:
            return self.reply(503, {"error": "too many change listeners"})
        sock = self.connection

        def write(data):
            """Send one event and flush it."""
            self.wfile.write(data)
            self.wfile.flush()

        def alive():
            """False once the server closes or the peer hung up (readable with nothing to read)."""
            if getattr(self.server, "closing", False):
                return False
            try:
                poll = select.poll()  # not select(): descriptors above 1024 are normal once the kernel watches thousands of paths
                poll.register(sock, select.POLLIN)
                readable = poll.poll(0)
                return not readable or sock.recv(1, socket.MSG_PEEK) != b""
            except (OSError, ValueError):
                return False

        try:
            self.start_stream()
        except OSError:
            events.unsubscribe()
            return
        try:
            events.stream(write, n, alive)
        except OSError:
            pass

    def log_message(self, *args):
        """Stay quiet."""
