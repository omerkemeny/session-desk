"""HTTP guards, static files, health and the change feed, through a real server on a free port."""
import http.client
import json
import os
import re
import socket
import struct
import threading
import time
import unittest
import zlib
from unittest import mock

from helpers import S1, S2, S3, FakeHome, FakeTerm, Served, open_events, read_event, wait_until
from desk import config, events, terms, web


class GuardTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.srv = Served()
        self.origin = "http://" + self.srv.host

    def tearDown(self):
        self.srv.close()
        self.home.close()

    def test_wrong_host_is_refused(self):
        for path in ("/", "/api/sessions", "/api/health", "/api/events", "/vendor/xterm.js", "/src/app.js", f"/api/session?id={S1}",
                     "/api/stats", f"/api/term/stream?id={S1}", "/api/term/stream?id=x"):
            status, _, _ = self.srv.request("GET", path, headers={"Host": "evil.example:80"})
            self.assertEqual(status, 403, path)
        status, _, _ = self.srv.request("GET", "/api/health", headers={"Host": f"localhost:{self.srv.port}"})
        self.assertEqual(status, 200)

    def test_get_cannot_reach_write_routes(self):
        for route in web.WRITES:
            status, _, _ = self.srv.request("GET", f"{route}?id={S1}&text=hi")
            self.assertEqual(status, 404, route)
        self.assertEqual((terms._terms, terms._replies), ({}, {}))

    def test_page_carries_token_and_no_store(self):
        status, headers, body = self.srv.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(re.search(rb'window.DESK_TOKEN="([^"]+)"', body).group(1).decode(), config.TOKEN)

    def test_post_needs_origin_and_token(self):
        body = {"id": S1, "data": "x"}
        good = {"Origin": self.origin, "X-Desk-Token": config.TOKEN, "Content-Type": "application/json"}
        cases = [
            ({"X-Desk-Token": config.TOKEN}, 403),
            (dict(good, Origin="http://evil.example"), 403),
            (dict(good, **{"X-Desk-Token": "wrong"}), 403),
            ({k: v for k, v in good.items() if k != "X-Desk-Token"}, 403),
            (dict(good, Host="evil.example:80"), 403),
            (good, 409),  # passes the guard; the terminal simply is not running
        ]
        for headers, want in cases:
            status, _, out = self.srv.request("POST", "/api/term/input", body, headers)
            self.assertEqual(status, want, headers)
        self.assertEqual(json.loads(out), {"error": "terminal not running"})
        status, _, _ = self.srv.request("POST", "/api/term/open", {"id": "../../x"}, good)
        self.assertEqual(status, 400)

    def test_favicon_is_a_16px_icon_behind_the_host_check(self):
        status, headers, body = self.srv.request("GET", "/favicon.ico")
        self.assertEqual((status, headers["Content-Type"]), (200, "image/x-icon"))
        self.assertEqual(struct.unpack("<HHHBB", body[:8]), (0, 1, 1, 16, 16))
        png = body[struct.unpack("<I", body[18:22])[0]:]
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", png[16:24]), (16, 16))
        idat = png.index(b"IDAT")
        self.assertEqual(len(zlib.decompress(png[idat + 4:idat + 4 + struct.unpack(">I", png[idat - 4:idat])[0]])), 16 * (1 + 16 * 4))
        self.assertEqual(self.srv.request("GET", "/favicon.ico", headers={"Host": "evil.example:80"})[0], 403)

    def test_json_routes(self):
        status, out = self.srv.json("/api/sessions")
        self.assertEqual(status, 200)
        self.assertIn(S1, [o["id"] for o in out])
        status, out = self.srv.json(f"/api/session?id={S1}")
        self.assertEqual((status, out["files"]), (200, [["/work/alpha/login.py", 1]]))
        for bad in ("../x", "*", ""):
            self.assertEqual(self.srv.request("GET", "/api/session?id=" + bad)[0], 404)
        self.assertEqual(self.srv.request("GET", "/api/nothing")[0], 404)

    def test_stats_route_has_no_prompt_text(self):
        for _ in range(100):
            status, out = self.srv.json("/api/stats")
            if out.get("ready") and not out.get("updating"):
                break
            time.sleep(0.05)
        self.assertTrue(out["ready"])
        text = json.dumps(out)
        for word in ("zebrafruit", "mangosteen", "papaya", "quokka", "acme/widgets", "login redirect", "slate"):
            self.assertNotIn(word, text)

    def test_health_shape(self):
        from test_contract import tables
        self.srv.json("/api/sessions")
        status, h = self.srv.json("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(set(h), {"ok", "started", "pid", "uptime", "codeVersion", "webVersion", "reloads", "reloadError", "restartNeeded", "terms", "maxTerms", "termhost",
                                  "events", "workers", "formatWarnings", "formatNotes", "formatChecked", "fds", "setup"})
        self.assertEqual(set(h["setup"]), set(tables()["health.setup"]), "docs/api.md health.setup differs from what is sent")
        self.assertEqual(set(h["events"]), {"clients", "max", "running", "error"})
        self.assertEqual(set(h["fds"]), set(tables()["health.fds"]), "docs/api.md health.fds differs from what is sent")
        self.assertGreater(h["fds"]["open"], 3)
        self.assertGreater(h["fds"]["limit"], h["fds"]["open"])
        self.assertEqual((h["pid"], h["termhost"]["mode"], h["termhost"]["running"]), (os.getpid(), "host", False))
        self.assertEqual(set(h["workers"]), {"events", "stats"})
        self.assertEqual(set(h["workers"]["stats"]), {"running", "runs", "errors", "lastError", "lastErrorAt"})
        self.assertEqual(set(h["workers"]["events"]), {"running", "errors", "lastError", "lastErrorAt"})
        self.assertGreaterEqual(h["uptime"], 0)
        self.assertIs(h["ok"], True)
        self.assertIsNone(h["reloadError"])
        self.assertEqual((h["terms"], h["formatWarnings"], h["restartNeeded"]), (0, [], []))
        self.assertGreater(h["codeVersion"], 0)
        self.assertEqual(h["started"], config.STARTED)
        self.assertGreaterEqual(h["formatChecked"]["transcriptFiles"], 1)

    def test_web_version_follows_served_files_at_most_every_check(self):
        web._webv.update(at=None)
        first = self.srv.json("/api/health")[1]["webVersion"]
        newest = max(os.stat(os.path.join(b, n)).st_mtime_ns for b, _, ns in os.walk(config.WEB) for n in ns) // 1_000_000
        self.assertEqual(first, newest)
        later = time.time() + 3600
        for name in (".hidden.js", "notes.txt"):  # never served: no effect
            path = os.path.join(config.WEB, name)
            with open(path, "w") as fh:
                fh.write("x")
            os.utime(path, (later, later))
        os.makedirs(os.path.join(config.WEB, "src"), exist_ok=True)
        page = os.path.join(config.WEB, "src", "main.js")
        with open(page, "w") as fh:
            fh.write("// new")
        os.utime(page, (later - 60, later - 60))
        self.assertEqual(self.srv.json("/api/health")[1]["webVersion"], first)  # cached within WEB_CHECK seconds
        with mock.patch.object(web.time, "monotonic", return_value=time.monotonic() + web.WEB_CHECK + 1):
            self.assertEqual(self.srv.json("/api/health")[1]["webVersion"], int((later - 60) * 1000))
        calls = []
        real = os.walk
        with mock.patch.object(web.os, "walk", side_effect=lambda *a, **k: calls.append(1) or real(*a, **k)):
            for _ in range(20):
                web.web_version()
        self.assertEqual(calls, [])

    def test_worker_errors_are_counted_by_type_only(self):
        from unittest import mock
        conn, resp = open_events(self.srv.port)
        try:
            with mock.patch.object(events, "snapshot", side_effect=OSError("/private/secret-name")):
                self.assertTrue(wait_until(lambda: self.srv.json("/api/health")[1]["workers"]["events"]["errors"] >= 1, timeout=5))
                w = self.srv.json("/api/health")[1]["workers"]
        finally:
            resp.close()
            conn.close()
        self.assertEqual((w["events"]["lastError"], w["stats"]["errors"]), ("OSError", 0))
        self.assertIsInstance(w["events"]["lastErrorAt"], int)
        self.assertNotIn("secret-name", json.dumps(w))


class HardeningTest(unittest.TestCase):
    """Browser-side attacks: framing, cross-site reads, big or slow requests, hostile stream offsets, too many streams."""

    def setUp(self):
        self.home = FakeHome()
        self.srv = Served()
        self.good = {"Origin": "http://" + self.srv.host, "X-Desk-Token": config.TOKEN, "Content-Type": "application/json"}

    def tearDown(self):
        for t in list(terms._terms.values()):
            with t.cond:
                t.code = 0
                t.cond.notify_all()
        self.srv.close()
        self.home.close()

    def fake(self, data=b"hello", code=0):
        """A local terminal stand-in with output in its log."""
        t = FakeTerm(os.getpid(), 0)
        t.cond, t.buf, t.start, t.code = threading.Condition(), bytearray(data), 0, code
        terms._terms[S1] = t
        return t

    def test_every_answer_refuses_framing_and_sniffing(self):
        self.fake()
        for path in ("/", "/api/health", "/vendor/xterm.css", "/nothing.js", f"/api/term/stream?id={S1}"):
            status, headers, _ = self.srv.request("GET", path)
            self.assertEqual((headers.get("X-Frame-Options"), headers.get("X-Content-Type-Options")), ("DENY", "nosniff"), path)
            self.assertIn("frame-ancestors 'none'", headers.get("Content-Security-Policy", ""), path)
        status, headers, _ = self.srv.request("POST", "/api/term/input", {"id": S2, "data": "x"}, self.good)
        self.assertEqual(headers.get("X-Frame-Options"), "DENY")

    def test_cross_site_reads_are_refused(self):
        self.fake()
        for site in ("cross-site", "same-site"):
            for path in ("/api/sessions", "/api/events", "/api/health", "/api/stats", "/vendor/xterm.js", "/favicon.ico", f"/api/term/stream?id={S1}",
                         f"/api/session?id={S1}"):
                self.assertEqual(self.srv.request("GET", path, headers={"Sec-Fetch-Site": site})[0], 403, (site, path))
            nav = {"Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
            self.assertEqual(self.srv.request("GET", "/", headers=nav)[0], 200)  # a link or bookmark still opens the page
            self.assertEqual(self.srv.request("GET", "/", headers=dict(nav, **{"Sec-Fetch-Dest": "iframe"}))[0], 403)
        for site in ("same-origin", "none"):
            self.assertEqual(self.srv.request("GET", "/api/health", headers={"Sec-Fetch-Site": site})[0], 200)

    def test_big_or_bad_bodies(self):
        status, headers, _ = self.srv.request("POST", "/api/term/input", b"x" * 10, dict(self.good, **{"Content-Length": "200000"}))
        self.assertEqual(status, 413)
        self.assertEqual(self.srv.request("POST", "/api/term/input", b"{}", dict(self.good, **{"Content-Length": "two"}))[0], 400)
        self.assertEqual(self.srv.json("/api/health")[0], 200)

    def test_slow_client_is_dropped(self):
        self.assertTrue(1 <= web.Handler.timeout <= 120)
        with mock.patch.object(web.Handler, "timeout", 0.3):
            s = socket.create_connection(("127.0.0.1", self.srv.port), timeout=5)
            try:
                s.sendall(b"GET /api/health HTTP/1.1\r\nHost: " + self.srv.host.encode() + b"\r\n")  # headers never finish
                t0 = time.monotonic()
                while s.recv(4096):
                    pass
                self.assertLess(time.monotonic() - t0, 3)
            finally:
                s.close()

    def test_hostile_last_event_ids(self):
        self.fake()
        for last in ("9" * 5000, "99999", "-1", "1e9", "\xb2"):
            status, _, body = self.srv.request("GET", f"/api/term/stream?id={S1}", headers={"Last-Event-ID": last})
            self.assertEqual(status, 200, last[:20])
            self.assertIn(b"id: 5\ndata: aGVsbG8=\n\n", body, last[:20])  # past the end or junk: replay from the start

    def test_stream_count_is_capped(self):
        self.fake(code=None)
        opened = []
        try:
            for _ in range(web.MAX_STREAMS):
                conn = http.client.HTTPConnection("127.0.0.1", self.srv.port, timeout=5)
                conn.request("GET", f"/api/term/stream?id={S1}", headers={"Host": self.srv.host})
                r = conn.getresponse()
                self.assertEqual(r.status, 200)
                opened.append((conn, r))
            self.assertEqual(self.srv.request("GET", f"/api/term/stream?id={S1}")[0], 503)
        finally:
            for conn, r in opened:
                r.close()
                conn.close()


class StaticTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        web = config.WEB
        files = {"src/app.js": b"export const a = 1;", "src/deep/mod.mjs": b"export {};", "styles/site.css": b"body{}", "art/sprite.png": b"\x89PNG..",
                 "art/i.svg": b"<svg/>", "data/x.json": b"{}", ".hidden/a.js": b"x", "src/.secret.js": b"x", "notes.txt": b"x"}
        for rel, data in files.items():
            os.makedirs(os.path.dirname(os.path.join(web, rel)), exist_ok=True)
            with open(os.path.join(web, rel), "wb") as fh:
                fh.write(data)
        with open(os.path.join(self.home.tmp, "outside.js"), "wb") as fh:
            fh.write(b"outside")
        os.symlink(os.path.join(self.home.tmp, "outside.js"), os.path.join(web, "src", "link.js"))
        self.srv = Served()

    def tearDown(self):
        self.srv.close()
        self.home.close()

    def test_allowed_files_and_types(self):
        for path, ctype in (("/src/app.js", "text/javascript; charset=utf-8"), ("/src/deep/mod.mjs", "text/javascript; charset=utf-8"),
                            ("/styles/site.css", "text/css; charset=utf-8"), ("/art/sprite.png", "image/png"),
                            ("/art/i.svg", "image/svg+xml; charset=utf-8"), ("/data/x.json", "application/json; charset=utf-8"),
                            ("/src/app.js?v=2", "text/javascript; charset=utf-8")):
            status, headers, _ = self.srv.request("GET", path)
            self.assertEqual((status, headers["Content-Type"], headers["Cache-Control"]), (200, ctype, "no-store"), path)

    def test_rejected_paths(self):
        for path in ("/src/../../outside.js", "/src/%2e%2e/%2e%2e/outside.js", "/src/..%2f..%2foutside.js", "/notes.txt", "/.hidden/a.js",
                     "/src/.secret.js", "/src/link.js", "/src//app.js", "/src/app.js%00.png", "/src\\app.js", "/index.html",
                     "/src/missing.js", "/vendor/evil.js", "/vendor/../server.py"):
            status, _, body = self.srv.request("GET", path)
            self.assertEqual(status, 404, path)
            self.assertNotIn(b"outside", body)

    def test_page_and_vendor_sources(self):
        status, _, body = self.srv.request("GET", "/")
        self.assertIn(b"Session Desk", body)
        status, _, body = self.srv.request("GET", "/vendor/xterm.css")
        self.assertEqual(status, 200)
        with open(os.path.join(config.WEB, "index.html"), "wb") as fh:
            fh.write(b"<p>split page</p>")
        os.makedirs(os.path.join(config.WEB, "vendor"), exist_ok=True)
        with open(os.path.join(config.WEB, "vendor", "xterm.css"), "wb") as fh:
            fh.write(b"/* from web */")
        status, _, body = self.srv.request("GET", "/")
        self.assertTrue(body.endswith(b"<p>split page</p>"))
        self.assertIn(b"DESK_TOKEN", body)
        self.assertEqual(self.srv.request("GET", "/vendor/xterm.css")[2], b"/* from web */")


class EventsTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.saved = (events.INTERVAL, events.KEEPALIVE)
        events.INTERVAL, events.KEEPALIVE = 0.1, 0.3
        self.srv = Served()
        self.open = []

    def tearDown(self):
        for r, c in self.open:
            r.close()
            c.close()
        wait_until(lambda: not self.feed_threads())
        events.INTERVAL, events.KEEPALIVE = self.saved
        self.srv.close()
        self.home.close()

    def connect(self, want=200):
        """Open the change feed; returns the response, closed again in tearDown."""
        conn, resp = open_events(self.srv.port)
        self.open.append((resp, conn))
        self.assertEqual(resp.status, want)
        if want == 200:
            self.assertEqual((resp.getheader("Content-Type"), resp.getheader("Cache-Control")), ("text/event-stream", "no-store"))
        return resp

    def first(self, resp):
        """Counter carried by the event sent on connect, once the thread has its first signature."""
        ev = read_event(resp)
        self.assertEqual(ev[:2], ["retry: 3000", "event: change"])
        self.assertTrue(wait_until(lambda: events._feed["sig"] is not None))
        return int(ev[2].split(": ")[1])

    def feed_threads(self):
        """Running feed threads."""
        return [t for t in threading.enumerate() if t.name == "desk-events" and t.is_alive()]

    def test_change_after_touch_with_one_shared_thread(self):
        r1, r2 = self.connect(), self.connect()
        n = self.first(r1)
        self.first(r2)
        self.assertEqual(len(self.feed_threads()), 1)
        with open(self.home.path(S1), "a") as fh:
            fh.write('{"type":"custom-title","customTitle":"Renamed","sessionId":"x"}\n')
        ev = read_event(r1)
        self.assertEqual(ev, ["event: change", f"data: {n + 1}"])
        self.assertEqual(read_event(r2), ["event: change", f"data: {n + 1}"])
        self.assertNotIn("Renamed", "".join(ev))
        for r, c in self.open:
            r.close()
            c.close()
        self.open = []
        self.assertTrue(wait_until(lambda: not self.feed_threads()))
        r3 = self.connect()  # the thread starts again for a new listener
        self.first(r3)
        self.assertEqual(len(self.feed_threads()), 1)

    def test_registry_change_fires(self):
        r = self.connect()
        n = self.first(r)
        self.home.register(S3)
        self.assertEqual(read_event(r), ["event: change", f"data: {n + 1}"])

    def test_listener_cap(self):
        rs = [self.connect() for _ in range(events.MAX_CLIENTS)]
        for r in rs:
            read_event(r)
        conn, resp = open_events(self.srv.port)
        self.open.append((resp, conn))
        self.assertEqual(resp.status, 503)
        status, h = self.srv.json("/api/health")
        self.assertEqual((h["events"]["clients"], h["events"]["max"]), (events.MAX_CLIENTS, events.MAX_CLIENTS))

    def test_dead_listener_is_dropped_quickly(self):
        events.KEEPALIVE = 30  # only the peer check can notice
        r = self.connect()
        self.first(r)
        self.assertEqual(events._feed["clients"], 1)
        for resp, conn in self.open:
            resp.close()
            conn.close()
        self.open = []
        self.assertTrue(wait_until(lambda: events._feed["clients"] == 0, timeout=3))

    def test_thread_survives_missing_globals(self):
        events.INTERVAL = 0.05
        r = self.connect()
        n = self.first(r)
        del events.INTERVAL  # as during a reload or a rollback
        time.sleep(0.3)
        events.INTERVAL = 0.05
        self.assertEqual(len(self.feed_threads()), 1)
        status, h = self.srv.json("/api/health")
        self.assertIs(h["events"]["running"], True)
        with open(self.home.path(S1), "a") as fh:
            fh.write('{"type":"custom-title","customTitle":"Again","sessionId":"x"}\n')
        self.assertEqual(read_event(r), ["event: change", f"data: {n + 1}"])

    def test_subscribe_restarts_a_dead_thread(self):
        dead = threading.Thread(target=lambda: None, name="desk-events")
        dead.start()
        dead.join()
        with events._feed["cond"]:
            events._feed["thread"] = dead
        self.assertIsNotNone(events.subscribe())
        try:
            self.assertEqual(len(self.feed_threads()), 1)
            self.assertIs(events.status()["running"], True)
        finally:
            events.unsubscribe()


class ExtraPageTest(unittest.TestCase):
    """The two fixed read-only pages: served as they are, never with the token, guarded like every route."""

    def setUp(self):
        self.home = FakeHome()
        for name in ("legend.html", "gallery.html", "other.html"):
            with open(os.path.join(config.WEB, name), "w") as fh:
                fh.write(f"<h1>{name}</h1>")
        self.srv = Served()

    def tearDown(self):
        self.srv.close()
        self.home.close()

    def test_served_without_token_with_safe_headers(self):
        for name in ("legend.html", "gallery.html"):
            status, h, body = self.srv.request("GET", "/" + name, headers={"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"})
            self.assertEqual((status, body), (200, f"<h1>{name}</h1>".encode()))
            self.assertEqual(h["Content-Type"], "text/html; charset=utf-8")
            self.assertEqual((h["X-Frame-Options"], h["X-Content-Type-Options"], h["Referrer-Policy"], h["Cache-Control"]), ("DENY", "nosniff", "no-referrer", "no-store"))
            self.assertIn("frame-ancestors 'none'", h["Content-Security-Policy"])
            self.assertNotIn(config.TOKEN.encode(), body)
            self.assertNotIn(b"DESK_TOKEN", body)

    def test_guards(self):
        self.assertEqual(self.srv.request("GET", "/legend.html", headers={"Host": "evil.example:80"})[0], 403)
        for site in ("cross-site", "same-site"):
            self.assertEqual(self.srv.request("GET", "/legend.html", headers={"Sec-Fetch-Site": site, "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty"})[0], 403)
            self.assertEqual(self.srv.request("GET", "/legend.html", headers={"Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"})[0], 403)

    def test_nothing_else_is_html(self):
        for path in ("/other.html", "/index.html", "/legend.html/", "/x/../legend.html", "/%2e/legend.html", "/legend%2ehtml", "/LEGEND.html", "/legend.html%00"):
            status, _, body = self.srv.request("GET", path)
            self.assertEqual(status, 404, path)
            self.assertNotIn(b"<h1>", body)
        status, _, body = self.srv.request("GET", "//legend.html")  # newer Pythons fold leading slashes: the same page or nothing
        self.assertIn((status, body), ((200, b"<h1>legend.html</h1>"), (404, b'{"error": "not found"}')))

    def test_missing_file_is_404(self):
        os.remove(os.path.join(config.WEB, "gallery.html"))
        self.assertEqual(self.srv.request("GET", "/gallery.html")[0], 404)

    def test_health_reports_max_terms(self):
        self.assertEqual(self.srv.json("/api/health")[1]["maxTerms"], terms.MAX_TERMS)


if __name__ == "__main__":
    unittest.main()
