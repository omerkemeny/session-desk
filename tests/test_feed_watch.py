"""The change feed under churn: 1,000 random appends, new files, deletions, registry rewrites and renames are each reported within 2 s, with their ids."""
import json
import os
import random
import threading
import time
import unittest
from unittest import mock

from helpers import S1, S2, S3, FakeHome, wait_until
from desk import events, watch

LINE = '{"type":"custom-title","customTitle":"Renamed","sessionId":"x"}\n'
LIMIT = 2.0  # seconds a change may take to be reported
QUIET = LIMIT + 0.5  # seconds a changed thing is left alone, so a later change cannot undo it unseen


class Churn:
    """Random changes against a fake data folder, checked against what the feed's passes report."""
    kernel = True

    def setUp(self):
        self.home = FakeHome()
        self.project = os.path.dirname(self.home.path(S1))
        self.passes, self.lock, self.made = [], threading.Lock(), []
        real = events.snapshot

        def spy():
            """Record each pass: start and end time and the ids it reports."""
            t = time.monotonic()
            out = real()
            with self.lock:
                self.passes.append((t, time.monotonic(), out[1], out[2]))
            return out
        self.patches = [mock.patch.object(events, "snapshot", spy), mock.patch.object(watch, "ENABLED", self.kernel)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        if not getattr(self, "streamed", False):
            events.unsubscribe()
        wait_until(lambda: not events.status()["running"], timeout=5)
        for p in self.patches:
            p.stop()
        self.home.close()

    def new_id(self, i):
        """A fresh session id."""
        return f"cafe{i:04x}-0000-4000-8000-{random.getrandbits(48):012x}"

    def calm(self, names, touched):
        """Names not changed within the last QUIET seconds, so no change is undone before a pass could see it."""
        now = time.monotonic()
        return [n for n in names if now - touched.get(n, -1e9) > QUIET]

    def change(self, i, created, regs, touched):
        """One random change on something left alone for QUIET seconds; returns the session ids it touches."""
        kind = random.choice(("append", "append", "new", "delete", "registry", "rename"))
        free = self.calm(created, touched)
        if kind == "new" or (kind in ("delete", "rename") and not free):
            sid = self.new_id(i)
            with open(os.path.join(self.project, sid + ".jsonl"), "w") as fh:
                fh.write(LINE)
            created.append(sid)
            return {sid}
        if kind == "delete":
            sid = random.choice(free)
            created.remove(sid)
            os.remove(os.path.join(self.project, sid + ".jsonl"))
            return {sid}
        if kind == "rename":
            old = random.choice(free)
            created.remove(old)
            sid = self.new_id(i)
            os.rename(os.path.join(self.project, old + ".jsonl"), os.path.join(self.project, sid + ".jsonl"))
            created.append(sid)
            return {old, sid}
        if kind == "registry":
            files = self.calm([f"r{k}.json" for k in range(60)], touched)
            if not files:
                return set()
            name = random.choice(files)
            touched[name] = time.monotonic()
            sid = self.new_id(i)
            body = {"pid": os.getpid(), "sessionId": sid, "status": random.choice(("busy", "idle", "waiting")), "statusUpdatedAt": i, "entrypoint": "cli"}
            with open(os.path.join(self.home.home, "sessions", name), "w") as fh:
                json.dump(body, fh)
            old, regs[name] = regs.get(name), sid
            return {sid} | ({old} if old else set())
        pick = self.calm([S1, S2] + created, touched)
        if not pick:
            return set()
        sid = random.choice(pick)
        with open(self.home.path(sid) if sid in (S1, S2) else os.path.join(self.project, sid + ".jsonl"), "a") as fh:
            fh.write(LINE)
        return {sid}

    def test_thousand_random_changes_are_all_reported(self):
        random.seed(5 if self.kernel else 6)
        self.assertIsNotNone(events.subscribe())
        self.assertTrue(wait_until(lambda: len(self.passes) >= 2, timeout=5))
        created, regs, touched, log = [], {}, {}, []
        while len(log) < 1000:
            t = time.monotonic()
            ids = self.change(len(log), created, regs, touched)
            for sid in ids:
                touched[sid] = t
            if ids:
                log.append((t, ids))
            time.sleep(0.008)
        time.sleep(LIMIT + 0.5)
        with self.lock:
            passes = list(self.passes)
        missed = []
        for t, ids in log:
            for sid in ids:
                if not any(end >= t and start <= t + LIMIT and (unknown or sid in got) for start, end, got, unknown in passes):
                    missed.append(sid)
        self.assertEqual(missed, [], f"{len(missed)} changes not reported within {LIMIT} s")
        self.assertEqual(events.status()["error"], "")
        if self.kernel and watch.available():
            self.assertTrue(events._scan["kernel"])

    def test_events_name_changed_ids_and_coalesce(self):
        out, self.streamed = [], True
        n = events.subscribe()  # stream() unsubscribes it when it ends
        th = threading.Thread(target=events.stream, args=(out.append, n, lambda: len(out) < 3, 0.5), daemon=True)
        th.start()
        self.assertTrue(wait_until(lambda: len(self.passes) >= 2, timeout=5))
        t0 = time.monotonic()
        for _ in range(5):
            with open(self.home.path(S1), "a") as fh:
                fh.write(LINE)
            time.sleep(0.05)
        with open(self.home.path(S2), "a") as fh:
            fh.write(LINE)
        self.assertTrue(wait_until(lambda: len(out) >= 2, timeout=5))
        first = out[1].decode()
        self.assertIn("event: sessions", first)
        body = json.loads(first.split("data: ", 1)[1].split("\n", 1)[0])
        self.assertIn(S1, body["ids"])
        self.assertFalse(body["all"])
        from test_contract import tables
        self.assertEqual(sorted(body), sorted(tables()["events.sessions"]), "docs/api.md events.sessions differs from what is sent")
        wait_until(lambda: len(out) >= 3, timeout=3)
        seen = set(body["ids"])
        if len(out) >= 3:
            seen |= set(json.loads(out[2].decode().split("data: ", 1)[1].split("\n", 1)[0])["ids"])
            self.assertGreaterEqual(time.monotonic() - t0, 0.5)
        self.assertIn(S2, seen, "the last change of a burst was dropped")
        self.assertLessEqual(len(out), 3, "more than one event per gap")
        th.join(5)


class KernelWatchTest(Churn, unittest.TestCase):
    kernel = True


class TimedScanTest(Churn, unittest.TestCase):
    kernel = False


if __name__ == "__main__":
    unittest.main()
