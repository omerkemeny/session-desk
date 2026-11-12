"""One synthetic session per display rule (tests/fixtures/cases), checked through the server and through tools/parity.py."""
import os
import shutil
import sys
import tempfile
import unittest

from helpers import ROOT, reset
from desk import config, sessions, transcripts as tx

sys.path.insert(0, os.path.join(ROOT, "tools"))
import parity  # noqa: E402

CASES = os.path.join(ROOT, "tests", "fixtures", "cases")


def case_id(n):
    """Session id of parity case n, as tests/fixtures/make_home.py writes it."""
    return f"c{n:07x}-0000-4000-8000-{n:012x}"


class CaseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-cases-")
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

    def said(self, n):
        """(role, text) of every prompt and reply the sidebar shows for case n."""
        return [(e[0], e[1]) for e in sessions.transcript(self.path(n))[0] if e[0] in ("you", "claude")]

    def test_branching_follows_the_newest_checkpoint(self):
        self.assertEqual(self.said(1), [("you", "Branch base request"), ("claude", "Base answer"),
                                        ("you", "Terminal branch request"), ("claude", "Terminal branch answer")])
        d = sessions.parse(self.path(1))
        self.assertEqual((d["you"], d["last"]), ("Terminal branch request", "Terminal branch answer"))
        self.assertEqual(d["lastBy"], "claude-desktop")  # the other program still wrote the newest line, which drives "behind"

    def test_grown_branch_interrupted_turn_and_queued_prompt(self):
        self.assertEqual([t for _, t in self.said(2)], ["First request", "First answer", "Stopped request", "Second request", "Second answer",
                                                        "Queued request", "Answer to the queued request"])

    def test_compaction_keeps_only_the_preserved_tail(self):
        self.assertEqual([t for _, t in self.said(3)], ["Kept request", "Kept answer", "New request", "New answer"])
        d = sessions.parse(self.path(3))
        self.assertEqual(sessions.mission(d, None), "Old request")  # the title still names what the session was for
        self.assertEqual(d["tokens"], 6)  # tokens spent before the compaction still count

    def test_parallel_tool_calls_keep_both_results(self):
        tools = [e for e in sessions.transcript(self.path(4))[0] if e[0] == "tool"]
        self.assertEqual([(e[2], e[3]) for e in tools], [("echo one", "one"), ("echo two", "two")])

    def test_injected_records_are_not_turns(self):
        self.assertEqual([t for r, t in self.said(5) if r == "you"], ["Real first request", "<system-reminder>note</system-reminder>", "Follow-up request"])
        self.assertEqual(sessions.mission(sessions.parse(self.path(5)), None), "Real first request")

    def test_renamed_session_titles(self):
        self.assertEqual(sessions.mission(sessions.parse(self.path(6)), None), "Second name")
        self.assertEqual(sessions.mission(sessions.parse(self.path(7)), None), "Automatic only")

    def test_sidechain_skipped_and_split_message_counted_once(self):
        d = sessions.parse(self.path(8))
        self.assertEqual(d["tokens"], 15)
        self.assertEqual([t for _, t in self.said(8)], ["Count tokens", "Part one", "Part two"])

    def test_forked_rows_do_not_count_as_own_tokens(self):
        self.assertEqual(sessions.parse(self.path(9))["tokens"], 7)
        self.assertEqual([t for _, t in self.said(9)], ["Parent request", "Parent answer", "Fork request", "Fork answer"])

    def test_missing_parent_is_bridged_by_time(self):
        self.assertEqual([t for _, t in self.said(10)], ["Before the gap", "Answer before", "After the gap", "Answer after"])

    def test_continued_session_leaves_the_list(self):
        ids = {o["id"] for o in sessions.sessions()}
        self.assertNotIn(case_id(11), ids)
        self.assertIn(case_id(12), ids)

    def test_markers_and_command_output(self):
        evs = sessions.transcript(self.path(18))[0]
        self.assertEqual(evs, [["you", "Start here"], ["claude", "Started"], ["you", "Long request"], ["interrupt"], ["you", "! ls"],
                               ["out", "one\ntwo\nwarn", 1], ["you", "<command-name>/cost</command-name><command-args></command-args>"], ["out", "Total cost: 0", 0], ["you", "Look at this"], ["image"], ["image"],
                               ["claude", "Two pictures"], ["you", "[Image]"], ["claude", "One picture"]])
        self.assertEqual(sessions.transcript(self.path(3))[0][0], ["compact", 0])  # transcript-only summary: no "Compact summary" line
        self.assertEqual(sessions.transcript(self.path(19))[0][0], ["compact", 1])
        d = sessions.parse(self.path(18))
        self.assertEqual((d["you"], d["last"]), ("[Image]", "One picture"))  # markers and output never become the topic

    def test_compaction_tips_follow_the_last_row(self):
        for n in (19, 20):
            self.assertEqual([t for _, t in self.said(n)][2:], ["Branch two request", "Branch two answer"])

    def test_bridge_skips_sidechain_rows_and_progress_lines(self):
        self.assertEqual([t for _, t in self.said(21)], ["Before the gap", "Answer before", "After the gap", "Answer after"])
        self.assertEqual([t for _, t in self.said(22)], ["Before progress", "Answer after progress"])

    def test_explicit_checkpoints(self):
        self.assertEqual(sessions.transcript(self.path(23))[0], [])
        self.assertEqual([t for _, t in self.said(24)], ["Kept request", "Kept answer"])

    def test_results_matched_by_call_id_and_parallel_checkpoint(self):
        tool = [e for e in sessions.transcript(self.path(25))[0] if e[0] == "tool"]
        self.assertEqual([(e[3], e[4]) for e in tool], [("Error: it failed", 1)])
        tools = [e for e in sessions.transcript(self.path(26))[0] if e[0] == "tool"]
        self.assertEqual([(e[2], e[3]) for e in tools], [("one", "out one"), ("two", "out two"), ("three", "out three")])

    def test_command_output_length_and_tool_display(self):
        evs = sessions.transcript(self.path(27))[0]
        six = "\n".join("line %d" % i for i in range(1, 7))
        self.assertEqual([e[1] for e in evs if e[0] == "out"], ["line 1\nline 2\nline 3\n… +3 lines", six, six])
        self.assertEqual([e[5] for e in evs if e[0] == "tool"], [
            "Read(/w/a.txt)", "Update(/w/a.txt)", "Write(/w/b.txt)", "Bash(make)", 'Search(pattern: "needle", path: "/w")', 'Search(pattern: "**/*.py")',
            "Explore(Look around)", "Agent(Helper)", "Fetch(https://example.com/x)", 'Web Search("weather")', "", 'srv - do_thing (MCP)(query: "q1")',
            "Skill(foo)"])

    def test_automated_runs(self):
        auto = {n: sessions.parse(self.path(n))["automated"] for n in (1, 13, 14, 28)}
        self.assertEqual(auto, {1: False, 13: True, 14: False, 28: True})
        self.assertEqual(sessions.parse(self.path(28))["kind"], "interactive")

    def test_other_program_branch_is_marked(self):
        evs = sessions.transcript(self.path(1))[0]
        self.assertEqual(evs[:3], [["you", "Branch base request"], ["claude", "Base answer"], ["elsewhere", "desktop app", 2]])
        self.assertEqual(sessions.parse(self.path(1))["consistency"], "diverged")
        self.assertEqual(sessions.parse(self.path(2))["consistency"], "ok")

    def test_titles_as_the_resume_picker_names_them(self):
        want = {29: "Picker later request", 30: "Empty first request", 31: "Reminder later second line", 32: "/review pr twelve", 33: "/status",
                34: "Pasted body second pasted line", 35: "Typed words", 36: "Words after the reminder",
                37: "Long request word0 word1 word2 word3 word4 word5 word6\u2026", 38: "Line one line two line three", 39: case_id(39)[:8],
                40: "(session)", 41: "Far first request"}
        self.assertEqual({n: sessions.mission(sessions.parse(self.path(n)), None) for n in want}, want)
        listed = {o["id"]: o["title"] for o in sessions.sessions()}
        self.assertEqual({n: listed[case_id(n)] for n in want}, want)

    def test_title_source_order(self):
        self.assertEqual(sessions.mission(sessions.parse(self.path(6)), "Registry name"), "Second name")  # own title first
        self.assertEqual(sessions.mission(sessions.parse(self.path(7)), "Registry name"), "Automatic only")  # then the automatic one
        self.assertEqual(sessions.mission(sessions.parse(self.path(29)), "Registry name"), "Registry name")  # then a name the person gave the live process
        self.assertEqual(sessions.mission(sessions.parse(self.path(29)), "alpha-3f"), "Picker later request")  # a placeholder gives way to the prompt

    def test_checker_agrees_with_the_server(self):
        hold = parity.registry(config.HOME)
        lv = sessions.live(sessions.holders())
        for p in sorted(tx.session_paths()):
            want, got = parity.expected(p, hold, sessions.brief), parity.actual(p, sessions, lv)
            self.assertEqual([f for f in parity.FIELDS if want[f] != got[f]], [], os.path.basename(p))


if __name__ == "__main__":
    unittest.main()
