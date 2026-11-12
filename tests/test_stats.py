"""Usage statistics on a tiny fixture: per-period totals and no free text in the output."""
import json
import os
import time
import unittest
from unittest import mock

from helpers import NOW, S3, T1, T2, T3, FakeHome
from desk import config, stats

SECRET_WORDS = ("zebrafruit", "mangosteen", "papaya", "quokka", "acme/widgets", "Opening a PR", "All done")


class StatsTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.files = {p: stats.stat_file(p) for p in (self.home.path(T1), self.home.path(T2), self.home.path(T3))}
        self.out = stats.stats_build(self.files, now=NOW)

    def tearDown(self):
        self.home.close()

    def test_periods(self):
        p = self.out["periods"]
        self.assertEqual(self.out["today"], "2026-06-15")
        self.assertEqual([p[k]["sessions"] for k in ("today", "7d", "30d", "all")], [1, 1, 2, 3])
        self.assertEqual([p[k]["prompts"] for k in ("today", "7d", "30d", "all")], [1, 1, 2, 3])
        self.assertEqual([p[k]["answered"] for k in ("today", "7d", "30d", "all")], [1, 1, 2, 2])
        self.assertEqual(p["all"]["prs"], 1)
        self.assertEqual(p["today"]["commits"], 1)
        # s_m1 is two lines: its usage counts once, at the larger values.
        self.assertEqual(p["today"]["tokens"], {"input": 111, "output": 23, "cacheWrite": 5, "cacheRead": 50})
        self.assertEqual(p["all"]["tokens"], {"input": 118, "output": 26, "cacheWrite": 5, "cacheRead": 50})
        self.assertEqual(p["all"]["turn"], {"median": 50, "p90": 50, "n": 2})
        self.assertEqual(p["all"]["commands"], 2)
        self.assertEqual(p["all"]["projects"], [("zoo", 3)])
        self.assertEqual(self.out["streak"]["current"], 1)

    def test_no_free_text(self):
        text = json.dumps(self.out)
        for word in SECRET_WORDS:
            self.assertNotIn(word, text)
        cached = json.dumps(self.files)
        for word in SECRET_WORDS:
            self.assertNotIn(word, cached)

    def test_background_refresh_and_cache_file(self):
        first = stats.stats()
        self.assertIn("ready", first)
        for _ in range(100):
            res = stats.stats()
            if res.get("ready") and not res.get("updating"):
                break
            time.sleep(0.05)
        self.assertTrue(res["ready"])
        self.assertEqual(res["periods"]["all"]["prs"], 1)
        with open(stats.config.STATS_FILE) as fh:
            saved = fh.read()
        for word in SECRET_WORDS:
            self.assertNotIn(word, saved)


class CacheFileTest(unittest.TestCase):
    def setUp(self):
        self.saved = (config.HOME, config.STATS_FILE)
        config.STATS_FILE = None

    def tearDown(self):
        config.HOME, config.STATS_FILE = self.saved

    def test_cache_file_follows_the_data_folder(self):
        config.HOME = os.path.expanduser("~/.claude")
        self.assertEqual(config.stats_file(), os.path.join(config.HERE, ".stats-cache.json"))
        config.HOME = "/somewhere/else/claude"
        other = config.stats_file()
        self.assertEqual(os.path.dirname(other), config.HERE)
        self.assertRegex(os.path.basename(other), r"^\.stats-cache-[0-9a-f]{12}\.json$")
        config.HOME = "/somewhere/third"
        self.assertNotEqual(config.stats_file(), other)

    def test_temp_file_is_unique_per_process(self):
        home = FakeHome()
        try:
            config.STATS_FILE = os.path.join(home.tmp, "cache.json")
            seen = []
            with mock.patch("os.replace", side_effect=lambda src, dst: seen.append((src, dst))):
                stats.stats_save({})
            self.assertEqual(len(seen), 1)
            self.assertEqual(seen[0][1], config.STATS_FILE)
            self.assertIn(str(os.getpid()), os.path.basename(seen[0][0]))
        finally:
            home.close()


class SubagentFileTest(unittest.TestCase):
    def test_compact_and_spaced_subagent_files_are_read(self):
        home = FakeHome()
        try:
            base = home.path(S3)[:-6] + "/subagents/"
            for name in ("agent-a1", "agent-a2"):
                with open(base + name + ".jsonl") as fh:
                    spaced = '"type": "' in fh.read()
                self.assertEqual(spaced, name == "agent-a2")
                f = stats.stat_file(base + name + ".jsonl")
                self.assertEqual((f["sub"], len(f["msgs"])), (True, 1))
        finally:
            home.close()


if __name__ == "__main__":
    unittest.main()
