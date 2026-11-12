"""The JSON the server sends matches the tables in docs/api.md: no undocumented field or event kind, no documented one missing."""
import os
import re
import shutil
import time
import unittest

from helpers import ROOT, FakeHome, Served

DOC = os.path.join(ROOT, "docs", "api.md")
CASES = os.path.join(ROOT, "tests", "fixtures", "cases", "projects")


def tables():
    """Each '### name' table of docs/api.md as {name: {field: cells}}."""
    out, cur = {}, None
    with open(DOC) as fh:
        for line in fh:
            if line.startswith("### "):
                cur = out.setdefault(line[4:].strip(), {})
            elif cur is not None and line.startswith("| `"):
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                cur[cells[0].strip("`")] = cells[1:]
    return out


class ContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = FakeHome()
        for name in os.listdir(CASES):
            shutil.copytree(os.path.join(CASES, name), os.path.join(cls.home.home, "projects", name))
        cls.srv = Served()
        cls.doc = tables()

    @classmethod
    def tearDownClass(cls):
        cls.srv.close()
        cls.home.close()

    def check(self, name, sent):
        """Every sent key is documented under name; every documented key not marked optional was sent."""
        doc = self.doc[name]
        self.assertEqual(sorted(set(sent) - set(doc)), [], f"sent but not in docs/api.md ({name})")
        need = {k for k, cells in doc.items() if "optional" not in cells[0]}
        self.assertEqual(sorted(need - set(sent)), [], f"documented but not sent ({name})")

    def test_sessions_and_events(self):
        status, items = self.srv.json("/api/sessions")
        self.assertEqual(status, 200)
        for o in items:
            self.check("sessions[]", o)
        kinds, lengths = set(), {k: int(c[0]) for k, c in self.doc["session.events"].items()}
        for o in items:
            status, body = self.srv.json("/api/session?id=" + o["id"])
            self.check("session", body)
            for ev in body["events"]:
                self.assertIn(ev[0], lengths, "event kind not in docs/api.md")
                self.assertEqual(len(ev), lengths[ev[0]], ev[0])
                kinds.add(ev[0])
        self.assertEqual(sorted(set(lengths) - kinds), [], "documented event kinds never sent by the fixtures")

    def test_stats(self):
        res = self.srv.json("/api/stats")[1]
        self.check("stats", res)
        for _ in range(200):
            if res.get("ready") and not res.get("updating"):
                break
            time.sleep(0.05)
            res = self.srv.json("/api/stats")[1]
        self.assertTrue(res["ready"])
        self.check("stats", res)
        self.assertEqual(sorted(res["periods"]), ["30d", "7d", "all", "today"])
        for p in res["periods"].values():
            self.check("stats.periods.all", p)

    def test_health(self):
        h = self.srv.json("/api/health")[1]
        self.check("health", h)
        self.check("health.termhost", h["termhost"])
        self.check("health.events", h["events"])
        self.check("health.workers.events", h["workers"]["events"])
        self.check("health.workers.stats", h["workers"]["stats"])
        self.check("health.formatChecked", h["formatChecked"])
        self.assertEqual(sorted(h["workers"]), ["events", "stats"])

    def test_doc_lists_every_table_it_names(self):
        self.assertTrue({"sessions[]", "session", "session.events", "stats", "stats.periods.all", "health"} <= set(self.doc))
        self.assertTrue(all(re.fullmatch(r"\d+", c[0]) for c in self.doc["session.events"].values()))


if __name__ == "__main__":
    unittest.main()
