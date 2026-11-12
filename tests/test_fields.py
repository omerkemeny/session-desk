"""Per-session list fields (kind, lastTool, lastError, prOpened, waitingSince) and the anomaly counts of the format check, on invented cases."""
import glob
import json
import os
import shutil
import tempfile
import unittest

from helpers import ROOT, FIXTURE, reset
from desk import config, sessions, stats, transcripts as tx

CASES = os.path.join(ROOT, "tests", "fixtures", "cases")


def case_id(n):
    """Session id of parity case n, as tests/fixtures/make_home.py writes it."""
    return f"c{n:07x}-0000-4000-8000-{n:012x}"


class FieldTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-fields-")
        self.home = os.path.join(self.tmp, "claude")
        shutil.copytree(CASES, self.home)
        os.makedirs(os.path.join(self.home, "sessions"))
        self.saved, config.HOME = config.HOME, self.home
        self.saved_stats, config.STATS_FILE = config.STATS_FILE, os.path.join(self.tmp, "stats.json")  # app files stay in the temp folder
        reset()

    def tearDown(self):
        config.HOME, config.STATS_FILE = self.saved, self.saved_stats
        reset()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def path(self, n):
        """Transcript path of case n."""
        return os.path.join(self.home, "projects", "-work-cases", case_id(n) + ".jsonl")

    def listed(self):
        """The list as /api/sessions serves it, by id."""
        return {o["id"]: o for o in sessions.sessions()}

    def test_kind(self):
        out = self.listed()
        self.assertEqual(out[case_id(13)]["kind"], "headless")
        self.assertEqual(out[case_id(14)]["kind"], "interactive")  # typed first, quick replies later
        self.assertEqual(out[case_id(1)]["kind"], "interactive")

    def test_last_tool_and_error_follow_the_shown_branch(self):
        o = self.listed()[case_id(15)]
        self.assertEqual((o["lastTool"], o["lastError"]), ("Grep", True))
        o = self.listed()[case_id(4)]
        self.assertEqual((o["lastTool"], o["lastError"]), ("Bash", False))
        o = self.listed()[case_id(1)]
        self.assertEqual((o["lastTool"], o["lastError"]), ("", False))

    def test_pull_requests_opened(self):
        self.assertEqual(self.listed()[case_id(16)]["prOpened"], 3)
        self.assertEqual(self.listed()[case_id(1)]["prOpened"], 0)

    def test_pull_request_rule_agrees_with_stats(self):
        self.assertEqual((tx.PR_CMD.pattern, tx.PR_URL.pattern), (stats.PR_CMD.pattern, stats.PR_URL.pattern))
        paths = sorted(glob.glob(os.path.join(self.home, "**", "*.jsonl"), recursive=True) + glob.glob(os.path.join(FIXTURE, "**", "*.jsonl"), recursive=True))
        self.assertGreater(len(paths), 20)
        for p in paths:
            self.assertEqual(len(tx.load(p).prs), len(stats.stat_file(p)["prs"]), os.path.basename(p))

    def test_waiting_since(self):
        p = self.path(2)
        end = int(tx.epoch(tx.conversation(tx.load(p))[-1].timestamp) * 1000)
        self.assertEqual(self.listed()[case_id(2)]["waitingSince"], end)
        later = end + 60000
        with open(os.path.join(self.home, "sessions", f"{os.getpid()}.json"), "w") as fh:
            json.dump({"pid": os.getpid(), "sessionId": case_id(2), "status": "idle", "statusUpdatedAt": later}, fh)
        self.assertEqual(self.listed()[case_id(2)]["waitingSince"], later)
        with open(os.path.join(self.home, "sessions", f"{os.getpid()}.json"), "w") as fh:
            json.dump({"pid": os.getpid(), "sessionId": case_id(2), "status": "busy", "statusUpdatedAt": later}, fh)
        self.assertEqual(self.listed()[case_id(2)]["waitingSince"], end)  # a busy status time is not a stop
        os.remove(os.path.join(self.home, "sessions", f"{os.getpid()}.json"))

    def test_anomalies_are_counted_not_shown(self):
        for n in (1, 10, 17):
            sessions.parse(self.path(n))
        warn, notes, checked = tx.format_report()
        a = checked["anomalies"]
        self.assertEqual((a["bad JSON line"], a["unknown record type"], a["duplicate uuid"], a["timestamp going backwards"]), (1, 1, 1, 1))
        self.assertEqual((a["missing parent"], a["two programs"]), (1, 1))
        self.assertIn({"source": "transcripts", "issue": "unknown record type", "count": 1, "field": "a-new-kind"}, notes)
        self.assertEqual({w["issue"] for w in warn}, {"unparseable lines"})
        text = json.dumps([warn, notes, checked])
        self.assertNotIn("Tolerate", text)
        self.assertNotIn("copy", text)


if __name__ == "__main__":
    unittest.main()
