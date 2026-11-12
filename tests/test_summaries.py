"""The summary cache file: a warm start answers exactly what a cold one does, without re-reading unchanged transcripts; bad files are ignored."""
import json
import os
import shutil
import stat
import unittest

from helpers import ROOT, S1, FakeHome, Served, reset
from desk import sessions, summaries, transcripts as tx

CASES = os.path.join(ROOT, "tests", "fixtures", "cases", "projects")


def text(path):
    """A file's text."""
    with open(path) as fh:
        return fh.read()


def forget():
    """Drop every in-memory cache, as a server restart does."""
    reset()
    sessions._views.clear()
    summaries.reset()


class SummaryCacheTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        for name in os.listdir(CASES):
            shutil.copytree(os.path.join(CASES, name), os.path.join(self.home.home, "projects", name))
        forget()
        self.reads = 0
        self.real_read = sessions._read

        def counted(path, **kw):
            """sessions._read that counts calls."""
            self.reads += 1
            return self.real_read(path, **kw)
        sessions._read = counted

    def tearDown(self):
        sessions._read = self.real_read
        forget()
        self.home.close()

    def listing(self):
        """GET /api/sessions from a fresh server."""
        srv = Served()
        try:
            status, body = srv.json("/api/sessions")
        finally:
            srv.close()
        self.assertEqual(status, 200)
        return body

    def test_warm_start_answers_like_a_cold_one(self):
        cold = self.listing()
        self.assertGreater(self.reads, 30)
        self.assertTrue(summaries.flush())
        mode = stat.S_IMODE(os.stat(summaries.cache_file()).st_mode)
        self.assertEqual(mode, 0o600)
        forget()
        self.reads = 0
        warm = self.listing()
        self.assertEqual(warm, cold)
        self.assertEqual(self.reads, 0)  # nothing was re-read
        self.assertGreaterEqual(summaries._state["loaded"], len(cold))
        self.assertFalse(summaries.flush())  # nothing changed, nothing written

    def test_format_check_counts_known_files_after_a_restart(self):
        cold = self.listing()
        summaries.flush()
        forget()
        self.listing()
        checked = tx.format_report()[2]
        self.assertEqual(checked["transcriptFiles"], 0)  # a warm start reads nothing
        self.assertGreaterEqual(checked["filesKnown"], len(cold))
        self.assertTrue(all(v for c in tx._checks.values() for v in c.values()))  # per-file counters keep non-zero counts only

    def test_changed_transcript_is_read_again(self):
        self.listing()
        summaries.flush()
        forget()
        with open(self.home.path(S1), "a") as fh:
            fh.write(json.dumps({"type": "custom-title", "customTitle": "Renamed later", "sessionId": S1}) + "\n")
        self.reads = 0
        out = {o["id"]: o for o in self.listing()}
        self.assertEqual(out[S1]["title"], "Renamed later")
        self.assertEqual(self.reads, 1)

    def test_corrupt_foreign_or_older_files_are_ignored_and_rebuilt(self):
        cold = self.listing()
        summaries.flush()
        path = summaries.cache_file()
        good = text(path)
        bad = [b"\x00garbage{", b"[]", json.dumps(dict(json.loads(good), v=summaries.VERSION - 1)).encode(),
               json.dumps(dict(json.loads(good), code="other")).encode(), json.dumps(dict(json.loads(good), home="/elsewhere")).encode()]
        for body in bad:
            with open(path, "wb") as fh:
                fh.write(body)
            forget()
            self.assertEqual(self.listing(), cold)
            self.assertEqual(summaries._state["loaded"], 0)
            self.assertTrue(summaries.flush())  # rebuilt
            self.assertGreater(len(json.loads(text(path))["entries"]), 30)

    def test_bad_entries_are_dropped_one_by_one(self):
        self.listing()
        summaries.flush()
        path = summaries.cache_file()
        data = json.loads(text(path))
        keys = sorted(data["entries"])
        data["entries"][keys[0]][1]["extra"] = 1  # unknown field
        data["entries"][keys[1]][1]["ask"] = "x" * 5000  # longer than the list ever sends
        data["entries"][keys[2]][0] = ["a", 1, 2]  # bad key
        data["entries"]["/outside/x.jsonl"] = data["entries"][keys[3]]  # not under the data folder
        with open(path, "w") as fh:
            json.dump(data, fh)
        forget()
        entries, rejected = summaries.read(path)
        self.assertEqual(rejected, 4)
        self.assertEqual(len(entries), len(keys) - 3)

    def test_deleted_transcripts_leave_the_file(self):
        self.listing()
        summaries.flush()
        gone = self.home.path(S1)
        os.remove(gone)
        sessions.list_view(tx.session_paths()[0], os.stat(tx.session_paths()[0]))
        summaries._state["dirty"] = True
        summaries.flush()
        self.assertNotIn(os.path.realpath(gone), json.loads(text(summaries.cache_file()))["entries"])


if __name__ == "__main__":
    unittest.main()
