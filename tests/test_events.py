"""Change-feed signature: every change is seen, recent and live transcripts at once, old ones by the periodic full scan, at a bounded cost."""
import os
import time
import unittest
from unittest import mock

from helpers import S1, S2, S3, FakeHome, wait_until
from desk import events, liveness, watch

LINE = '{"type":"custom-title","customTitle":"Renamed","sessionId":"x"}\n'


class SignatureTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.saved = events.FULL
        old = time.time() - 2 * 86400
        self.cold = self.home.path(S2)
        os.utime(self.cold, (old, old))
        self.project = os.path.dirname(self.home.path(S1))

    def tearDown(self):
        events.FULL = self.saved
        self.home.close()

    def append(self, path):
        """Append one record, as the CLI does while it works."""
        with open(path, "a") as fh:
            fh.write(LINE)

    def test_recent_transcript_change_is_seen_at_once(self):
        events.FULL = 3600
        a = events.signature()
        self.assertEqual(events.signature(), a)
        self.append(self.home.path(S1))
        self.assertNotEqual(events.signature(), a)

    def test_new_and_removed_transcripts_are_seen_at_once(self):
        events.FULL = 3600
        a = events.signature()
        new = os.path.join(self.project, "abcdef12-0000-4000-8000-000000000009.jsonl")
        with open(new, "w") as fh:
            fh.write(LINE)
        b = events.signature()
        self.assertNotEqual(b, a)
        os.remove(new)
        self.assertEqual(events.signature(), a)

    def test_old_transcript_change_is_seen_by_the_full_scan(self):
        events.FULL = 3600
        a = events.signature()
        self.append(self.cold)
        events.FULL = 0
        self.assertNotEqual(events.signature(), a)

    def test_old_transcript_change_is_seen_by_the_rotation_without_a_full_scan(self):
        events.FULL = 3600
        a = events.signature()
        self.append(self.cold)
        with mock.patch.object(events, "CYCLE", 1e-9), mock.patch.object(events, "_full_scan", side_effect=AssertionError("full scan")):
            time.sleep(0.01)
            self.assertNotEqual(events.signature(), a)

    def test_old_transcript_of_a_live_session_is_seen_at_once(self):
        events.FULL = 3600
        self.home.register(S2)
        a = events.signature()
        self.append(self.cold)
        self.assertNotEqual(events.signature(), a)

    def test_quick_pass_stats_only_recent_and_live_transcripts(self):
        events.FULL = 3600
        old = time.time() - 2 * 86400
        for i in range(200):
            p = os.path.join(self.project, f"abcdef12-0000-4000-8000-{i:012d}.jsonl")
            with open(p, "w") as fh:
                fh.write(LINE)
            os.utime(p, (old, old))
        os.utime(self.project, (old, old))
        events.signature()
        real, seen = os.stat, []
        with mock.patch("os.stat", side_effect=lambda p, *a, **k: (seen.append(p), real(p, *a, **k))[1]):
            events.signature()
        jsonl = [p for p in seen if str(p).endswith(".jsonl")]
        self.assertLess(len(jsonl), 20, f"{len(jsonl)} transcripts checked on a quick pass")

    def test_full_scan_result_matches_a_fresh_start(self):
        events.FULL = 0
        self.append(self.cold)
        a = events.signature()
        events._scan.update(at=0.0, dirs=None, files={}, acc=0, hot=set(), home=None)
        self.assertEqual(events.signature(), a)


class RotationTest(unittest.TestCase):
    """At scale the rotation stats a bounded slice a pass: files changed in the last days come round first, and a changing watch list never restarts it."""

    def setUp(self):
        self.home = FakeHome()
        self.saved = events.FULL, events.FULL_WATCHED
        events.FULL = events.FULL_WATCHED = 3600
        project = os.path.dirname(self.home.path(S1))
        old = time.time() - 30 * 86400
        self.old = []
        for i in range(300):
            p = os.path.join(project, f"abcdef12-0000-4000-8000-{i:012d}.jsonl")
            with open(p, "w") as fh:
                fh.write(LINE)
            os.utime(p, (old, old))
            self.old.append(p)
        self.days = os.path.join(project, "abcdef12-0000-4000-8000-999999999999.jsonl")
        with open(self.days, "w") as fh:
            fh.write(LINE)
        two = time.time() - 2 * 86400
        os.utime(self.days, (two, two))
        os.utime(project, (old, old))

    def tearDown(self):
        events.FULL, events.FULL_WATCHED = self.saved
        events._scan.update(kernel=False, watched=set(), cold=None)
        self.home.close()

    def seen(self, path):
        """True once the feed's known key of path equals the file's key."""
        return events._scan["files"].get(path) == events._key(path)

    def test_a_file_changed_days_ago_comes_round_before_months_old_ones(self):
        events.signature()
        with open(self.days, "a") as fh:
            fh.write(LINE)
        with mock.patch.object(events, "ROTATE_MAX", 1):
            passes = next((k for k in range(1, 400) if (events.signature(), self.seen(self.days))[1]), None)
        self.assertIsNotNone(passes)
        self.assertLessEqual(passes, 20, f"seen after {passes} passes behind {len(self.old)} older files")

    def test_watch_list_changes_never_restart_the_rotation(self):
        class Fake:
            """A kernel watch whose watched set changes on every call, as it does while cold files keep waking."""
            def __init__(self, paths):
                self.paths, self.n, self.fds = paths, 0, []

            def want(self, wanted):
                self.n += 1
                self.fds = [self.paths[self.n % len(self.paths)]]
                return set(self.fds)

            def wait(self, timeout):
                return set()

            def close(self):
                pass

        feed = {"watch": Fake([self.home.path(S1), self.home.path(S3)])}
        events.signature()
        for p in self.old:
            with open(p, "a") as fh:
                fh.write(LINE)
        with mock.patch.object(watch, "available", return_value=True), mock.patch.object(events, "ROTATE_MAX", 1):
            for _ in range(1200):
                events._scan["wlist"] = None  # a cold file woke: the watch list is rebuilt
                events.kernel_wait(feed, 0)
                events.signature()
                if all(self.seen(p) for p in self.old):
                    break
        self.assertEqual([p for p in self.old if not self.seen(p)], [], "old files the rotation never reached")


class BudgetTest(unittest.TestCase):
    def test_watch_cap_follows_the_descriptor_limit(self):
        self.assertEqual(watch.budget(256), 48)
        self.assertEqual(watch.budget(2048), 512)
        self.assertEqual(watch.budget(8192), 2048)
        self.assertEqual(watch.budget(1 << 20), watch.MAX_FDS)
        self.assertEqual(watch.budget(100), 0)


class WatchOrderTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.project = os.path.dirname(self.home.path(S1))
        old = time.time() - 2 * 86400
        for i in range(30):  # more project folders than a small cap
            d = os.path.join(self.home.home, "projects", f"-extra-{i:02d}")
            os.makedirs(d)
            p = os.path.join(d, f"abcdef12-0000-4000-8000-{i:012d}.jsonl")
            with open(p, "w") as fh:
                fh.write(LINE)
            os.utime(p, (old, old))
        self.cold = self.home.path(S2)
        os.utime(self.cold, (old, old))

    def tearDown(self):
        self.home.close()

    def test_live_then_registry_then_warm_then_folders_then_the_rest(self):
        self.home.register(S2)
        events.signature()
        wl = events.watch_list()
        reg, proj = os.path.join(self.home.home, "sessions"), os.path.join(self.home.home, "projects")
        regfile = os.path.join(reg, "1.json")
        warm = self.home.path(S1)
        self.assertEqual(wl[0], self.cold)  # live although old
        self.assertLess(wl.index(regfile), wl.index(warm))
        self.assertLess(wl.index(warm), wl.index(reg))
        self.assertLess(wl.index(proj), wl.index(self.project))
        old = [p for p in wl if p.endswith(".jsonl") and os.path.basename(os.path.dirname(p)).startswith("-extra-")]
        self.assertTrue(old and all(wl.index(self.project) < wl.index(p) for p in old))
        self.assertEqual(len(wl), len(set(wl)))

    def test_registry_file_replaced_by_rename_is_left_to_its_folder_watch(self):
        self.home.register(S2)
        reg = os.path.join(self.home.home, "sessions")
        f = os.path.join(reg, "1.json")
        liveness.holders()
        self.assertIn(f, liveness.registry_watch())
        tmp = os.path.join(reg, ".1.json.tmp")
        with open(f) as fh, open(tmp, "w") as out:
            out.write(fh.read().replace('"idle"', '"busy"'))
        os.replace(tmp, f)
        liveness.holders(True, frozenset(), frozenset({reg}))
        self.assertNotIn(f, liveness.registry_watch())
        with open(f) as fh:
            text = fh.read()
        with open(f, "w") as fh:  # written in place: the folder watch would miss it
            fh.write(text.replace('"busy"', '"idle"'))
        liveness.holders(True, frozenset(), frozenset({f}))
        self.assertIn(f, liveness.registry_watch())


@unittest.skipUnless(watch.available(), "no kernel watch here")
class SmallCapLatencyTest(WatchOrderTest):
    """With fewer watches than folders, a live transcript is still watched and a cold one is seen by the rotation within about a second."""

    def seen(self, path, limit):
        """Seconds until the feed counter moves after one append to path; fails past limit."""
        n = events._feed["count"]
        t = time.monotonic()
        with open(path, "a") as fh:
            fh.write(LINE)
        self.assertTrue(wait_until(lambda: events._feed["count"] != n, timeout=limit + 1, step=0.005), f"{path} not seen")
        return time.monotonic() - t

    def test_live_change_is_kernel_fast_and_cold_change_within_cycle(self):
        self.home.register(S2)
        with mock.patch.object(watch, "MAX_FDS", 8):
            self.assertIsNotNone(events.subscribe())
            try:
                wait_until(lambda: events._scan.get("kernel") and len(events._scan["watched"]) == 8, timeout=5)
                time.sleep(1.2)
                self.assertIn(self.cold, events._scan["watched"])
                self.assertLess(self.seen(self.cold, 0.3), 0.3)
                far = os.path.join(self.home.home, "projects", "-extra-29", "abcdef12-0000-4000-8000-000000000029.jsonl")
                self.assertNotIn(far, events._scan["watched"])
                time.sleep(0.5)
                self.assertLess(self.seen(far, 1.5), 1.5)
                wait_until(lambda: far in events._scan["watched"], timeout=3)
                self.assertIn(far, events._scan["watched"])  # a cold file that woke moves up the watch list
            finally:
                events.unsubscribe()
                wait_until(lambda: not events.status()["running"], timeout=5)


class ListInputsTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()

    def tearDown(self):
        events.unsubscribe()
        wait_until(lambda: not events.status()["running"], timeout=5)
        self.home.close()

    def test_offered_only_while_a_fresh_pass_ran_and_equal_to_the_data_module(self):
        from desk import sessions
        self.assertIsNone(events.list_inputs())
        self.home.register(S1)
        self.assertIsNotNone(events.subscribe())
        self.assertTrue(wait_until(lambda: events.list_inputs() is not None, timeout=5))
        got = events.list_inputs()
        self.assertEqual(got["n"], events._feed["count"])
        self.assertEqual(got["hold"], sessions.holders())
        for p in (self.home.path(S1), self.home.path(S2), self.home.path(S3)):
            self.assertEqual(got["keys"][p], sessions.stat_key(os.stat(p)))
        got["hold"].clear()
        self.assertTrue(events.list_inputs()["hold"])  # each caller gets its own copy
        with mock.patch.object(events, "FRESH", -1):
            self.assertIsNone(events.list_inputs())


if __name__ == "__main__":
    unittest.main()
