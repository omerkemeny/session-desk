"""Stats cache durability: atomic replace survives kills, corrupt or old caches rebuild, parallel writers never mix, no temp files stay."""
import glob
import json
import os
import signal
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

from helpers import ROOT, FakeHome, wait_until
from desk import config, stats

WRITER = """
import sys, time
sys.path.insert(0, {root!r})
from desk import config, stats
config.STATS_FILE = {path!r}
files = {{"/p/%d" % i: {{"key": [i, i], "pad": "x" * 2000}} for i in range(3000)}}
print("go", flush=True)
while True:
    stats.stats_save(files)
"""


class StatsCacheTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.path = config.STATS_FILE

    def tearDown(self):
        self.home.close()

    def refresh(self):
        """Run one refresh in this thread and return the result."""
        stats._stats["busy"] = True
        stats.stats_refresh()
        return stats._stats

    def saved(self):
        """The cache file as JSON."""
        with open(self.path) as fh:
            return json.load(fh)

    def test_corrupt_cache_is_rebuilt(self):
        with open(self.path, "w") as fh:
            fh.write('{"v": 1, "files": {"/x": [1, 2')
        st = self.refresh()
        self.assertEqual(st["error"], "")
        self.assertIsNotNone(st["result"])
        self.assertEqual(self.saved()["v"], stats.STATS_VER)

    def test_old_version_is_rebuilt(self):
        p = self.home.path("7aaaaaaa-7777-4777-8777-777777777777")
        st = os.stat(p)
        with open(self.path, "w") as fh:
            json.dump({"v": stats.STATS_VER - 1, "files": {p: {"key": [st.st_mtime_ns, st.st_size], "old": True}}}, fh)
        self.refresh()
        self.assertNotIn("old", self.saved()["files"][p])

    def test_bad_entry_with_a_matching_key_is_recounted(self):
        p = self.home.path("7aaaaaaa-7777-4777-8777-777777777777")
        st = os.stat(p)
        bad = {"key": [st.st_mtime_ns, st.st_size], "sub": False, "proj": "", "entry": "", "remember": False, "msgs": {"m": [1]}, "prompts": {}, "prs": {}, "t0": 0}
        with open(self.path, "w") as fh:
            json.dump({"v": stats.STATS_VER, "files": {p: bad}}, fh)
        st = self.refresh()
        self.assertEqual(st["error"], "")
        self.assertEqual(st["result"]["periods"]["all"]["prs"], 1)

    def test_parallel_saves_never_mix(self):
        payloads = [{f"/p/{k}": {"key": [k, k], "n": k}} for k in range(8)]
        threads = [threading.Thread(target=stats.stats_save, args=(p,)) for p in payloads for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertIn(self.saved()["files"], payloads)
        self.assertEqual(glob.glob(self.path + ".*"), [])

    def test_kill_mid_write_keeps_a_whole_cache_and_old_temps_are_removed(self):
        stats.stats_save({"/first": {"key": [0, 0]}})
        for i in range(6):
            proc = subprocess.Popen([sys.executable, "-c", WRITER.format(root=ROOT, path=self.path)], stdout=subprocess.PIPE, text=True)
            self.assertEqual(proc.stdout.readline().strip(), "go")
            time.sleep(0.05 + 0.04 * i)
            proc.send_signal(signal.SIGKILL)
            proc.wait()
            proc.stdout.close()
            data = self.saved()  # never a half-written file
            self.assertEqual(data["v"], stats.STATS_VER)
        leftovers = glob.glob(self.path + ".*.tmp")
        stats.stats_load()
        self.assertEqual(glob.glob(self.path + ".*.tmp"), [], f"{len(leftovers)} temp files from killed writers stayed")

    def test_counting_runs_in_a_worker_and_skips_unchanged_files(self):
        real = stats.stat_file
        stats.stat_file = mock.Mock(side_effect=AssertionError("counted inside the server"))
        try:
            st = self.refresh()
            self.assertEqual((st["error"], st["result"]["periods"]["all"]["prs"]), ("", 1))
            self.assertEqual(st["done"], st["total"])
            before = os.stat(self.path).st_mtime_ns
            time.sleep(0.02)
            self.refresh()
            self.assertEqual(os.stat(self.path).st_mtime_ns, before)  # nothing changed, nothing rewritten
        finally:
            stats.stat_file = real

    def test_parallel_stats_calls_start_one_refresh(self):
        calls = []
        real = stats.stats_refresh
        stats.stats_refresh = lambda: (calls.append(1), time.sleep(0.3), real())
        try:
            threads = [threading.Thread(target=stats.stats) for _ in range(10)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertTrue(wait_until(lambda: stats.stats().get("ready")))
        finally:
            stats.stats_refresh = real
        self.assertEqual(len(calls), 1)

    def test_shutdown_ends_a_running_worker(self):
        for i in range(300):
            with open(os.path.join(self.home.home, "projects", "-work-zoo", f"abcdef12-0000-4000-8000-{i:012d}.jsonl"), "w") as fh:
                fh.write('{"type":"user","n":1}\n' * 3000)
        t = threading.Thread(target=self.refresh)
        t.start()
        self.assertTrue(wait_until(lambda: stats._stats["proc"] is not None))
        proc = stats._stats["proc"]
        stats.stop_worker()
        t.join(5)
        self.assertIsNotNone(proc.poll())
        self.assertIn("worker ended", stats._stats["error"])  # cut before it finished
        self.assertEqual(glob.glob(self.path + ".*.tmp"), [])

if __name__ == "__main__":
    unittest.main()
