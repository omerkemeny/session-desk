"""Transcript parsing, the tree/branch rule, defensive reads and the format self-check."""
import json
import os
import time
import unittest

from helpers import S1, S2, FakeHome
from desk import sessions, stats, transcripts as tx


class ParseTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()

    def tearDown(self):
        self.home.close()

    def test_summary_of_one_session(self):
        d = sessions.parse(self.home.path(S1))
        self.assertEqual(d["title"], "Fix the login flow")
        self.assertEqual(d["first"], "Please fix the login redirect loop")
        self.assertEqual(d["last"], "Fixed the loop; tests pass now.")
        self.assertEqual((d["cwd"], d["branch"], d["model"], d["lastBy"]), ("/work/alpha", "main", "model-x", "cli"))
        self.assertEqual(d["files"], {"/work/alpha/login.py": 1})
        # msg_1 is split over two lines and counted once; the sidechain message is skipped.
        self.assertEqual(d["tokens"], (10 + 5 + 100) + (20 + 7) + (3 + 4))
        self.assertNotIn("side work", json.dumps(d["tl"]))
        self.assertEqual([e[0] for e in d["tl"]], ["you", "claude", "tools", "claude"])
        self.assertEqual(d["tl"][2][1], "Edited 1 time, ran 1 command")

    def test_carryover_summary_is_not_a_title(self):
        d = sessions.parse(self.home.path(S2))
        self.assertEqual(d["first"], "Add dark mode to the settings page")
        self.assertEqual(sessions.mission(d, None), "Add dark mode to the settings page")

    def test_transcript_tool_results(self):
        events, files = sessions.transcript(self.home.path(S1))
        tools = [e for e in events if e[0] == "tool"]
        self.assertEqual(tools[0][:2], ["tool", "Edit"])
        self.assertEqual(tools[0][3], "line1\nline2\nline3\nline4\n… +2 lines")
        self.assertEqual((tools[1][1], tools[1][3], tools[1][4]), ("Bash", "Error: 1 failed", 1))
        self.assertEqual(files, {"/work/alpha/login.py": 1})
        self.assertNotIn("side work", json.dumps(events))

    def test_transcript_keeps_only_the_newest_branch(self):
        events, _ = sessions.transcript(self.home.path(S2))
        self.assertEqual([e[1] for e in events], ["Understood.", "Add dark mode to the settings page", "Which colours?", "Use the slate palette", "Done with slate."])

    def test_shown_text(self):
        raw = "<command-name>/review</command-name><command-args></command-args>"
        self.assertEqual(tx.shown(raw), raw)  # without <command-message> the resumed screen shows the tags (case 28)
        self.assertEqual(tx.shown("<command-message>review</command-message>" + raw), "/review")
        self.assertEqual(tx.shown("<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>opus</command-args>"), "/model opus")
        self.assertEqual(tx.shown("<bash-input>ls -la</bash-input>"), "! ls -la")
        self.assertEqual(tx.shown("<system-reminder>x</system-reminder>"), "<system-reminder>x</system-reminder>")  # the CLI shows unknown tags raw
        for hidden in ("<task-notification>t</task-notification>", "<bash-stdout>o</bash-stdout>", "<local-command-stdout>o</local-command-stdout>",
                       "[Request interrupted by user]"):
            self.assertEqual(tx.shown(hidden), "")
        self.assertEqual(tx.shown("plain"), "plain")


class DefensiveTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.dir = os.path.join(self.home.home, "projects", "-work-odd")
        os.makedirs(self.dir)

    def tearDown(self):
        self.home.close()

    def write(self, name, lines, tail=""):
        """Write raw lines into a transcript of the odd project."""
        path = os.path.join(self.dir, name + ".jsonl")
        with open(path, "w") as fh:
            fh.write("".join(line + "\n" for line in lines) + tail)
        return path

    def test_odd_records_never_raise(self):
        odd = [
            '[1, 2, "type":"user"]',
            '{"type":"user","message":"just a string","uuid":5}',
            '{"type":"user","message":{"content":{"not":"a list"}},"origin":"weird","timestamp":12}',
            '{"type":"assistant","message":{"id":"m","content":[{"type":"tool_use","name":"Edit","input":["x"]},"bare",{"type":"text","text":7}],"usage":"lots","model":5}}',
            '{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"t1","name":"mcp__ccd_turn__update_plan","input":{"items":"no","done":3}}],"usage":{"input_tokens":"x"}},"timestamp":"2026-01-01T00:00:00Z","uuid":"u9"}',
            '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":42}]},"timestamp":"2026-01-01T00:00:01Z"}',
            '{"type":"custom-title","customTitle":["no"]}',
            '{"type":"brand-new","uuid":"n1","parentUuid":"u9"}',
        ]
        path = self.write("aaaaaaaa-0000-4000-8000-000000000000", odd)
        d = sessions.parse(path)
        self.assertEqual(d["tokens"], 0)
        sessions.transcript(path)
        stats.stat_file(path)

    def test_format_report_counts_problems(self):
        good = self.home.path(S1)
        sessions.parse(good)
        warn, notes, checked = tx.format_report()
        self.assertEqual((warn, notes), ([], [{"source": "transcripts", "issue": "unknown record type", "count": 1, "field": "some-future-record"}]))
        self.assertEqual(checked["transcriptFiles"], 1)
        lines = [
            '{"type":"user", broken',
            json.dumps({"type": "assistant", "uuid": "a", "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "isSidechain": False, "entrypoint": "cli",
                        "message": {"id": "m", "model": "x", "content": [{"type": "text", "text": "hi"}]}}),
        ]
        sessions.parse(self.write("bbbbbbbb-0000-4000-8000-000000000000", lines, tail='{"type":"user","still being wri'))
        warn, _, _ = tx.format_report()
        found = {(w["issue"], w.get("field")): w["count"] for w in warn}
        self.assertEqual(found[("unparseable lines", None)], 1)  # the unfinished last line is not counted
        self.assertEqual(found[("missing field", "message.usage")], 1)
        self.assertNotIn("files without messages", {w["issue"] for w in warn})

    def test_old_records_missing_a_field_are_notes(self):
        def rec(ts):
            """An assistant record without entrypoint, written at ts."""
            return json.dumps({"type": "assistant", "uuid": "a", "timestamp": ts, "isSidechain": False,
                               "message": {"id": "m", "model": "x", "content": [], "usage": {}}}, separators=(",", ":"))
        sessions.parse(self.write("eeeeeeee-0000-4000-8000-000000000000", [rec("2025-01-01T00:00:00.000Z"), rec("2025-02-01T00:00:00.000Z")]))
        warn, notes, _ = tx.format_report()
        self.assertEqual(warn, [])
        self.assertEqual([(n["issue"], n.get("field"), n["count"]) for n in notes], [("missing field in records older than 14 days", "entrypoint", 2),
                                                                                         ("duplicate uuid", None, 1)])
        now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        sessions.parse(self.write("ffffffff-0000-4000-8000-000000000000", [rec(now)]))
        warn, notes, _ = tx.format_report()
        self.assertEqual([(w["issue"], w.get("field"), w["count"]) for w in warn], [("missing field", "entrypoint", 1)])

    def test_renamed_record_types_show_as_files_without_messages(self):
        for n in "cd":
            sessions.parse(self.write(f"{n * 8}-0000-4000-8000-000000000000", ['{"type":"human","message":{"content":"hello"}}']))
        sessions.parse(self.home.path(S1))
        warn, _, checked = tx.format_report()
        self.assertEqual(checked["filesWithoutMessages"], 2)
        self.assertIn(("files without messages", 2), [(w["issue"], w["count"]) for w in warn])
        self.assertNotIn("hello", json.dumps(warn))

    def test_registry_missing_fields(self):
        with open(os.path.join(self.home.home, "sessions", "9.json"), "w") as fh:
            json.dump({"pid": os.getpid(), "sessionId": S1}, fh)
        with open(os.path.join(self.home.home, "sessions", "10.json"), "w") as fh:
            fh.write("{not json")
        self.assertIn(S1, sessions.holders())
        found = {(w["source"], w["issue"], w.get("field")) for w in tx.format_report()[0]}
        self.assertIn(("registry", "missing field", "status"), found)
        self.assertIn(("registry", "missing field", "statusUpdatedAt"), found)
        self.assertIn(("registry", "unreadable files", None), found)


if __name__ == "__main__":
    unittest.main()
