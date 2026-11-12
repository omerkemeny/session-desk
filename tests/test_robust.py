"""Requests under bad input, vanishing files, half-written lines and parallel load: always one clean response."""
import json
import os
import threading
import unittest
from unittest import mock

from helpers import S1, S2, S3, S4, S5, S6, FakeHome, FakeTerm, Served, wait_until
from desk import config, sessions, terms, transcripts


class RobustTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.srv = Served()

    def tearDown(self):
        self.srv.close()
        self.home.close()

    def post(self, path, body):
        """A write request with a valid Origin and token."""
        return self.srv.request("POST", path, body, {"Origin": "http://" + self.srv.host, "X-Desk-Token": config.TOKEN, "Content-Type": "application/json"})

    def test_session_file_vanishes_mid_request(self):
        gone = os.path.join(self.home.home, "projects", "-work-alpha", "deadbeef-0000-4000-8000-000000000000.jsonl")
        with mock.patch.object(transcripts, "find", return_value=gone):
            status, _, body = self.srv.request("GET", "/api/session?id=deadbeef-0000-4000-8000-000000000000")
        self.assertEqual((status, json.loads(body)), (404, {"error": "not found"}))

    def test_unexpected_error_is_a_500_without_details(self):
        with mock.patch.object(sessions, "sessions", side_effect=RuntimeError("secret detail")):
            status, _, body = self.srv.request("GET", "/api/sessions")
        self.assertEqual((status, json.loads(body)), (500, {"error": "internal error"}))
        self.assertEqual(self.srv.json("/api/health")[0], 200)  # the server keeps serving

    def test_bad_numbers_in_a_write_are_a_400(self):
        for body in ({"id": S1, "cols": "wide", "rows": 30}, {"id": S1, "cols": 80, "rows": [1]}):
            status, _, out = self.post("/api/term/open", body)
            self.assertEqual((status, json.loads(out)), (400, {"error": "bad number"}), body)

    def test_bad_last_event_id_starts_from_the_beginning(self):
        t = FakeTerm(os.getpid(), 0)
        t.cond, t.buf, t.start, t.code = threading.Condition(), bytearray(b"hello"), 0, 0
        terms._terms[S1] = t
        status, _, body = self.srv.request("GET", f"/api/term/stream?id={S1}", headers={"Last-Event-ID": "junk"})
        self.assertEqual(status, 200)
        self.assertIn(b"id: 5\ndata: aGVsbG8=\n\n", body)
        self.assertIn(b"event: exit", body)

    def test_half_written_last_line_is_not_an_error(self):
        path = self.home.path(S1)
        line = '{"parentUuid":"s1-a4","isSidechain":false,"type":"assistant","uuid":"s1-a5","timestamp":"2026-01-05T10:00:09.000Z","entrypoint":"cli","cwd":"/work/alpha","message":{"id":"msg_9","model":"model-x","usage":{},"content":[{"type":"text","text":"Second fix landed."}]}}\n'
        with open(path, "a") as fh:
            fh.write(line[:100])
        status, out = self.srv.json("/api/sessions")
        self.assertEqual(status, 200)
        self.assertNotIn("Second fix", json.dumps(out))
        warn = self.srv.json("/api/health")[1]["formatWarnings"]
        self.assertFalse([w for w in warn if w["issue"] == "unparseable lines"], warn)
        with open(path, "a") as fh:
            fh.write(line[100:])
        out = self.srv.json("/api/sessions")[1]
        self.assertEqual(next(o for o in out if o["id"] == S1)["last"], "Second fix landed.")

    def test_data_folder_is_never_written(self):
        def tree():
            """Every path under the data folder with its size and mtime."""
            out = {}
            for base, dirs, files in os.walk(self.home.home):
                for n in dirs + files:
                    st = os.stat(os.path.join(base, n))
                    out[os.path.join(base, n)] = (st.st_size, st.st_mtime_ns)
            return out

        before = tree()
        for path in ("/", "/api/sessions", f"/api/session?id={S1}", "/api/health", "/api/stats"):
            self.assertEqual(self.srv.request("GET", path)[0], 200, path)
        self.assertTrue(wait_until(lambda: self.srv.json("/api/stats")[1].get("ready")))
        self.assertEqual(tree(), before)

    def test_parallel_requests_on_shared_caches(self):
        ids, errors = [S1, S2, S3, S4, S5, S6], []

        def worker(k):
            """Hit the session and list routes in a different order per thread."""
            for i in range(25):
                sid = ids[(i + k) % len(ids)]
                for path in (f"/api/session?id={sid}", "/api/sessions"):
                    status = self.srv.request("GET", path)[0]
                    if status != 200:
                        errors.append((path, status))

        threads = [threading.Thread(target=worker, args=(k,)) for k in range(12)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
