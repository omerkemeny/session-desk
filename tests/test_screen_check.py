"""tools/screen_check.py without the CLI: the screen buffer, the screen reader and the comparison, on canned and stored captures."""
import os
import shutil
import sys
import unittest

from helpers import ROOT, reset
from desk import config

sys.path.insert(0, os.path.join(ROOT, "tools"))
import screen_check as sc  # noqa: E402

KNOWN_FAIL = {  # case -> (conversation, title) verdicts that are documented differences (screen_check.KNOWN)
    "8": ("PASS", "KNOWN"), "21": ("PASS", "KNOWN"), "13": ("PASS", "KNOWN"), "23": ("PASS", "KNOWN"),
}
OPEN_FAIL = {  # case -> verdicts of differences found in round 10 and not yet fixed in the app
}


def screen(data, rows=6, cols=20):
    """Text of a small screen after data."""
    s = sc.Screen(rows, cols)
    s.feed(data)
    return s.text()


class ScreenBufferTest(unittest.TestCase):
    def test_cursor_moves_and_clears(self):
        self.assertEqual(screen("abc\x1b[2;3Hxy\x1b[1;2H\x1b[K"), "a\n  xy")
        self.assertEqual(screen("one\r\n\x1b[1Btwo\x1b[2G\x1b[1AZ"), "one\n Z\ntwo")
        self.assertEqual(screen("aaaa\x1b[3G\x1b[1K"), "   a")
        self.assertEqual(screen("aa\r\nbb\x1b[1;1H\x1b[J"), "")
        self.assertEqual(screen("aa\r\nbb\x1b[2;1H\x1b[1J"), "\nbb")

    def test_alternate_screen_styles_and_titles(self):
        self.assertEqual(screen("old\r\x1b[?1049h\x1b[38;5;174mnew\x1b[0m\x1b]0;title\x07\x1b(B\x0f"), "new")
        self.assertEqual(screen("ab\x1b7\x1b[3;1Hcd\x1b8ef"), "abef\n\ncd")

    def test_scrolling_wrapping_and_wide_characters(self):
        self.assertEqual(screen("1\r\n2\r\n3\r\n4", rows=3, cols=5), "2\n3\n4")
        self.assertEqual(screen("abcdefg", rows=3, cols=5), "abcde\nfg")
        self.assertEqual(screen("界x", rows=1, cols=5), "界x")

    def test_insert_and_delete_lines(self):
        self.assertEqual(screen("a\r\nb\x1b[1;1H\x1b[1L", rows=3), "\na\nb")
        self.assertEqual(screen("a\r\nb\x1b[1;1H\x1b[1M", rows=3), "b")


CANNED = """ ▐▛███▛█   Logo v0
▝▜██████▀  Model line
 ▝▝   ▝▝   ~/w

❯ First request
  second line

⏺ An answer
  over two lines

! ls
  ⎿  out
  ⎿  err

  Read 2 files, searched for 1 pattern

⏺ Bash(make)
  ⎿  built
     done

✻ Conversation compacted (ctrl+o for the summary)

⏺ Session model x could not be restored (not a model this version recognizes)
                                                    ◐ medium · /effort
────────────────
❯
────────────────"""


class ScreenReaderTest(unittest.TestCase):
    def test_blocks_of_a_resumed_screen(self):
        self.assertEqual(sc.screen_blocks(sc.conversation_region(CANNED)), [
            ("you", "First request second line"), ("say", "An answer over two lines"), ("you", "! ls"), ("result", "out err"),
            ("group", ""), ("say", "Bash(make)"), ("result", "built done"), ("compact", "Conversation compacted")])
        self.assertEqual(sc.screen_groups(sc.conversation_region(CANNED)), ["Read 2 files, searched for 1 pattern"])

    def test_page_group_rule(self):
        tool = lambda name, err=0, display="x": ["tool", name, "", "", err, display, 1]  # noqa: E731
        ev = [["you", "go"], tool("Bash"), tool("Read"), tool("TodoWrite", display=""), tool("Grep", 1), tool("Glob"), tool("Edit"), tool("mcp__srv__a"),
              tool("mcp__srv__b"), tool("mcp__two__c"), ["claude", "x"], tool("Read")]
        self.assertEqual(sc.page_groups(ev), ["Searched for 2 patterns, read 1 file, ran 1 shell command", "Called srv, two 3 times", "Read 1 file"])
        self.assertEqual(sc.page_groups([["tool", "Read", "", "", 0, "Read(a)"]]), [], "an older server without the quiet item keeps one line per call")
        self.assertEqual(sc.judge_words("x", ["Read 1 file"], ["  Read 1 file"]), (["Read 1 file"], ["Read 1 file"], "same"))
        self.assertEqual(sc.judge_words("x", ["Read 2 files"], ["  Read 1 file", "", "  Read 1 file"])[2], "FAIL")
        self.assertEqual(sc.judge_words("57", ["Called alpha 1 time"], [])[2], "KNOWN")
        self.assertEqual(sc.judge_words("x", [], ["⏺ Done"])[2], "-")

    def test_expected_blocks_from_events(self):
        events = [["you", "First request\nsecond line"], ["claude", "An answer\nover two lines"], ["you", "! ls"], ["out", "out\nerr", 1],
                  ["tool", "Read", "/a", "x", 0, "Read(/a)", 1], ["tool", "Grep", "p", "x", 0, "Search(pattern: \"p\")", 1],
                  ["tool", "TodoWrite", "", "x", 0, "", 1], ["tool", "Edit", "/a", "built\ndone", 0, "Bash(make)", 0],
                  ["compact"], ["image"], ["interrupt"], ["elsewhere", "terminal", 2]]
        self.assertEqual(sc.expected_blocks(events)[:8], sc.screen_blocks(sc.conversation_region(CANNED)))
        self.assertEqual(sc.expected_blocks(events)[8:], [("say", "Compact summary"), ("result", "[Image #1]"), ("result", sc.INTERRUPTED)])
        self.assertEqual(sc.expected_blocks([["compact", 0]]), [("compact", "Conversation compacted")])

    def test_compare_prints_both_sides(self):
        self.assertEqual(sc.compare([("you", "a")], [("you", "a")]), [])
        diff = sc.compare([("you", "a")], [("you", "b")])
        self.assertIn("-you: a", diff)
        self.assertIn("+you: b", diff)

    def test_picker_titles_and_title_rules(self):
        pick = "──\n  Resume session (1 of 2)\n  ╭──╮\n  │ ⌕ Search… │\n  ╰──╯\n    w\n  ❯ First title\n    9 months ago · main · 1.7KB\n" \
               "  ↓ Second title\n    2 days ago · main · 796 bytes\n    Ctrl+A to show all projects · Esc to cancel"
        self.assertEqual(sc.picker_titles(pick), ["First title", "Second title"])
        self.assertEqual(sc.same_title("Long words…", "Long words and more"), "same")
        self.assertEqual(sc.same_title("Typed", 'Typed <pasted_content id="p1">x</pasted_content id="p1">'), "intended")
        self.assertEqual(sc.same_title("One", "Two"), "")


class StoredScreensTest(unittest.TestCase):
    """Every screen stored by `screen_check.py --save` against what the app shows now for the same case."""

    def setUp(self):
        self.saved = config.HOME, config.STATS_FILE

    def tearDown(self):
        config.HOME, config.STATS_FILE = self.saved
        reset()

    def test_each_stored_screen(self):
        ids = sorted(f[:-6] for f in os.listdir(sc.CASES) if f.endswith(".jsonl"))
        checked, got, why = 0, {}, []
        for sid in ids:
            name = sc.case_name(sid)
            path = os.path.join(sc.SCREENS, name + ".txt")
            if not os.path.exists(path):
                continue
            c = sc.prepare(sid)
            try:
                with open(path) as fh:
                    conv = fh.read()
                with open(os.path.join(sc.SCREENS, name + ".picker.txt")) as fh:
                    titles = [x for x in fh.read().split("\n") if x]
                cv, tv, detail = sc.judge(name, c["want"], c["titles"], conv.split("\n"), titles)
            finally:
                shutil.rmtree(c["tmp"], ignore_errors=True)
            checked += 1
            if (cv, tv.split(" ")[0]) != ("PASS", "PASS"):
                got[name] = (cv, tv.split(" ")[0])
                why += [f"case {name}:"] + detail
        self.assertGreaterEqual(checked, 61)
        self.assertEqual(got, dict(KNOWN_FAIL, **OPEN_FAIL), "\n".join(why))


if __name__ == "__main__":
    unittest.main()
