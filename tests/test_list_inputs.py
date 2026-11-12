"""The list routes get the change feed's transcript stat keys and holders map only when the data functions take them, and those inputs equal
what the data module would compute itself after a series of changes."""
import inspect
import json
import os
import time
import unittest
from unittest import mock

from helpers import S1, S2, S3, FakeHome, wait_until
from desk import events, sessions, transcripts as tx, web

LINE = '{"type":"custom-title","customTitle":"Renamed","sessionId":"x"}\n'


def put(path, mode="a"):
    """Write one record to a transcript and close it."""
    with open(path, mode) as fh:
        fh.write(LINE)


class Feed:
    """A fake data folder with the change feed running."""

    def setUp(self):
        self.home = FakeHome()
        self.assertIsNotNone(events.subscribe())
        self.assertTrue(wait_until(lambda: events.list_inputs() is not None, timeout=5))

    def tearDown(self):
        events.unsubscribe()
        wait_until(lambda: not events.status()["running"], timeout=5)
        self.home.close()

    def settle(self):
        """Wait until a feed pass ran after now, so its view covers every change made before."""
        t = time.monotonic()
        self.assertTrue(wait_until(lambda: (events._feed.get("pub") or {}).get("at", 0) > t + 0.05, timeout=5))


class PassingTest(Feed, unittest.TestCase):
    def test_given_only_to_functions_that_take_them(self):
        seen = []

        def takes(keys=None, hold=None):
            """Stand-in for the data module's list with the new optional inputs."""
            seen.append(("takes", keys, hold))
            return []

        def plain():
            """Stand-in for today's list."""
            seen.append(("plain",))
            return []
        with mock.patch.object(sessions, "sessions", takes):
            web.list_all()
        with mock.patch.object(sessions, "sessions", plain):
            web.list_all()
        got = events.list_inputs()
        self.assertEqual(seen[0][0], "takes")
        self.assertEqual(seen[0][1], got["keys"])
        self.assertEqual(seen[0][2], got["hold"])
        self.assertEqual(seen[1], ("plain",))

    def test_partial_answer_carries_the_counter_its_inputs_are_valid_for(self):
        seen = []

        def part(ids, holders=None, file_keys=None):
            """Stand-in partial list taking the inputs under their other names."""
            seen.append((ids, holders, file_keys))
            return {"rows": [], "gone": list(ids), "order": [], "today": "x"}
        with mock.patch.object(sessions, "sessions_for", part):
            out = web.rows_for([S1])
        self.assertEqual(seen[0][0], [S1])
        self.assertIsNotNone(seen[0][1])
        self.assertIsNotNone(seen[0][2])
        self.assertLessEqual(out["n"], events._feed["count"])

    def test_nothing_is_given_without_a_fresh_pass(self):
        seen = []

        def takes(keys=None, hold=None):
            """Stand-in list."""
            seen.append((keys, hold))
            return []
        with mock.patch.object(events, "FRESH", -1), mock.patch.object(sessions, "sessions", takes):
            web.list_all()
        self.assertEqual(seen, [(None, None)])


class EqualityTest(Feed, unittest.TestCase):
    def test_inputs_equal_the_data_module_after_a_series_of_changes(self):
        project = os.path.dirname(self.home.path(S1))
        steps = [
            lambda: self.home.register(S2),
            lambda: put(self.home.path(S1)),
            lambda: put(os.path.join(project, "abcdef12-0000-4000-8000-000000000001.jsonl"), "w"),
            lambda: self.home.register(S3, status="busy"),
            lambda: os.remove(os.path.join(self.home.home, "sessions", "1.json")),
            lambda: put(self.home.path(S3)),
            lambda: os.remove(os.path.join(project, "abcdef12-0000-4000-8000-000000000001.jsonl")),
        ]
        for step in steps:
            step()
            self.settle()
            got = events.list_inputs()
            want = {p: sessions.stat_key(os.stat(p)) for p in tx.session_paths()}
            self.assertEqual({p: k for p, k in got["keys"].items() if p in want}, want)
            self.assertEqual(set(got["keys"]), set(want))
            self.assertEqual(got["hold"], sessions.holders())
            plain = json.dumps(sessions.sessions(), sort_keys=True)
            params = inspect.signature(sessions.sessions).parameters
            if "keys" in params and "hold" in params:
                fed = json.dumps(sessions.sessions(keys=got["keys"], hold=got["hold"]), sort_keys=True)
            else:
                with mock.patch.object(sessions, "holders", lambda: got["hold"]):
                    fed = json.dumps(sessions.sessions(), sort_keys=True)
            self.assertEqual(fed, plain)


if __name__ == "__main__":
    unittest.main()
