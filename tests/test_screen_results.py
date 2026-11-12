"""Tool results as the CLI's default view prints them under a call (CLI 2.1.322, seen in a scratch HOME with invented sessions)."""
import json
import os
import shutil
import subprocess
import sys
import unittest

import helpers  # noqa: F401  (puts the app folder on the path)
from desk import config
from desk import transcripts as tx

sys.path.insert(0, os.path.join(helpers.ROOT, "tools"))
import screen_check as sc  # noqa: E402

SIX = "one\ntwo\nthree\nfour\nfive\nsix"
EDIT = {"filePath": "/w/a.txt", "structuredPatch": [{"oldStart": 1, "oldLines": 3, "newStart": 1, "newLines": 3, "lines": [" alpha", "-beta", "+BETA", " gamma"]}]}
# (tool, result text, is error, structured result, screen text, quiet); Bash output is quiet since round 7: the default view folds every shell call
SEEN = [
    ("Read", "     1→alpha", False, {"type": "text", "file": {}}, "     1→alpha", 1),
    ("Grep", "Found 2 files", False, {"mode": "files_with_matches", "numFiles": 2}, "Found 2 files", 1),
    ("Glob", "/w/a.txt", False, {"filenames": ["/w/a.txt"], "numFiles": 1}, "/w/a.txt", 1),
    ("Agent", "report", False, {"status": "completed"}, "report", 1),
    ("TodoWrite", "Todos have been modified", False, {"newTodos": []}, "Todos have been modified", 1),
    ("mcp__srv__do_thing", "mcp out", False, [{"type": "text", "text": "mcp out"}], "mcp out", 1),
    ("Bash", "plain", False, None, "plain", 1),
    ("Edit", "updated", False, EDIT, "Added 1 line, removed 1 line\n1  alpha\n2 -beta\n2 +BETA\n3  gamma", 0),
    ("Write", "created", False, {"type": "create", "filePath": "/w/b.txt", "content": "one\ntwo\n"}, "Wrote 2 lines to b.txt\n1 one\n2 two", 0),
    ("Bash", SIX, False, {"stdout": SIX, "stderr": ""}, "one\ntwo\nthree\n… +3 lines", 1),
    ("Bash", "l1\nl2\nl3\nl4", False, {"stdout": "l1\nl2\nl3\nl4", "stderr": ""}, "l1\nl2\nl3\nl4", 1),
    ("Bash", "", False, {"stdout": "", "stderr": "", "noOutputExpected": True}, "Done", 1),
    ("Bash", "", False, {"stdout": "", "stderr": ""}, "(No output)", 1),
    ("Bash", "out", False, {"stdout": "out text", "stderr": "err text"}, "out text\nerr text", 1),
    ("WebFetch", "page", False, {"bytes": 2048, "code": 200, "codeText": "OK"}, "Received 2KB (200 OK)", 0),
    ("WebFetch", "page", False, {"bytes": 512, "code": 404, "codeText": "Not Found"}, "Received 512 bytes (404 Not Found)", 0),
    ("WebSearch", "r", False, {"results": [{"tool_use_id": "s"}], "durationSeconds": 1.5}, "Did 1 search in 2s", 0),
    ("WebSearch", "r", False, {"results": [{}, {}], "durationSeconds": 0.4}, "Did 2 searches in 400ms", 0),
    ("Bash", "Exit code 3\nalpha", True, "Error: Exit code 3\nbeta", "Error: Exit code 3\nalpha", 0),
    ("Bash", "Error: dup text", True, None, "Error: dup text", 0),
    ("Bash", "<tool_use_error>Invented wrapped</tool_use_error>", True, None, "Error: Invented wrapped", 0),
    ("Edit", "<tool_use_error>File has not been read yet. Read it first.</tool_use_error>", True, None, "File must be read first", 0),
]


class ScreenResultTest(unittest.TestCase):
    def test_each_seen_form(self):
        for name, text, err, data, want, quiet in SEEN:
            self.assertEqual(tx.screen_result(name, text, err, data, "/w"), (want, quiet), name)

    def test_edit_outside_the_folder_keeps_its_path_and_counts(self):
        patch = {"structuredPatch": [{"oldStart": 1, "newStart": 1, "lines": ["-a", "+b", "+c"]}]}
        self.assertEqual(tx.screen_result("Edit", "", False, patch, "/w"), ("Added 2 lines, removed 1 line\n1 -a\n1 +b\n2 +c", 0))
        long = {"type": "create", "filePath": "/x/e.txt", "content": "\n".join("abcdefghijk")}
        self.assertEqual(tx.screen_result("Write", "", False, long, "/w").__getitem__(0).split("\n")[0], "Wrote 11 lines to /x/e.txt")
        self.assertTrue(tx.screen_result("Write", "", False, long, "/w")[0].endswith(" 9 i\n10 j\n… +1 line"))


# Group lines of the default view, stored screen (CLI 2.1.322) against the page's rule: (case, CLI words, page words, verdict); groups in screen order.
MCP = "KNOWN"  # sc.WORDS_KNOWN: the default run configures no MCP server, so the CLI draws nothing for those calls; screens/mcp has the configured form
WORDS = [
    ("4", ["Ran 2 shell commands"], ["Ran 2 shell commands"], "same"),
    ("15", ["Searched for 1 pattern, read 1 file"], ["Searched for 1 pattern, read 1 file"], "same"),  # the branch marker between the calls rides along
    ("16", ["Ran 3 shell commands", "Ran 2 shell commands"], ["Called forge, ran 5 shell commands"], MCP),
    ("25", ["Ran 1 shell command"], ["Ran 1 shell command"], "same"),
    ("26", ["Ran 3 shell commands"], ["Ran 3 shell commands"], "same"),
    ("27", ["Read 1 file", "Searched for 2 patterns, ran 1 shell command"], ["Read 1 file", "Searched for 2 patterns, ran 1 shell command", "Called srv"], MCP),
    ("46", ["Ran 1 shell command", "Ran 1 shell command"], ["Ran 1 shell command", "Ran 1 shell command"], "same"),
    ("47", ["Read 3 files"], ["Read 3 files"], "same"),
    ("48", ["Read 1 file"], ["Read 1 file"], "same"),
    ("49", ["Searched for 2 patterns"], ["Searched for 2 patterns"], "same"),
    ("50", ["Read 1 file, ran 1 shell command"], ["Read 1 file, ran 1 shell command"], "same"),
    ("51", ["Searched for 1 pattern, read 1 file, ran 1 shell command"], ["Searched for 1 pattern, read 1 file, ran 1 shell command"], "same"),
    ("52", ["Ran 4 shell commands"], ["Ran 4 shell commands"], "same"),
    ("53", ["Read 1 file", "Searched for 1 pattern, read 1 file"], ["Read 1 file", "Searched for 1 pattern, read 1 file"], "same"),
    ("54", ["Read 3 files, ran 1 shell command"], ["Read 3 files, ran 1 shell command"], "same"),
    ("55", ["Read 2 files"], ["Read 2 files"], "same"),
    ("56", [], ["Called alpha, beta 2 times"], MCP),
    ("57", [], ["Called alpha"], MCP),
    ("58", ["Read 1 file", "Ran 1 shell command"], ["Read 1 file, called alpha, ran 1 shell command"], MCP),
    ("59", [], ["Called alpha"], MCP),
    ("60", [], ["Called alpha 2 times"], MCP),
]
PAGE_JS = """import { readFileSync } from 'node:fs';
import { groupEnd, groupHtml, segments, segHtml } from %s;
const cases = JSON.parse(readFileSync(0, 'utf8')), out = {};
for (const [name, ev] of Object.entries(cases)) {
  const open = new Set(ev.map((_, i) => i)), html = segments(ev, false).map(g => segHtml(ev, g, open, { xp: open })).join('');
  out[name] = [...html.matchAll(/<summary class="ln tool"><span class="g"><\\/span><div class="txt">([^<]*)<\\/div>/g)].map(m => m[1].replace(/&amp;/g, '&'));
  for (let i = 0; i < ev.length; i++) {  // what a closed group draws beside its line: nothing but branch notes
    const k = groupEnd(ev, i); if (k === i) continue;
    const h = groupHtml(ev, i, k), after = h.slice(h.lastIndexOf('</details>') + 10);
    if (after !== '</div>' && !after.startsWith('<div class="gnote">')) out[name].push('under a closed group: ' + after);
    i = k - 1;
  }
}
console.log(JSON.stringify(out));
"""  # the page's own drawing (segments, segHtml, every fold open), group-line words read from its HTML


class GroupWordsTest(unittest.TestCase):
    """The group-line table of tools/screen_check.py, replayed from the stored screens; a change to the CLI's screens or the page's rule shows here."""

    def setUp(self):
        self.saved = config.HOME, config.STATS_FILE

    def tearDown(self):
        config.HOME, config.STATS_FILE = self.saved
        helpers.reset()

    def cases(self):
        """Every case prepared by the screen check without the CLI: {case: prepared case}."""
        out = {}
        for sid in sorted(f[:-6] for f in os.listdir(sc.CASES) if f.endswith(".jsonl")):
            c = sc.prepare(sid)
            shutil.rmtree(c["tmp"], ignore_errors=True)
            out[sc.case_name(sid)] = c
        return out

    def test_table_from_stored_screens(self):
        rows = []
        for name, c in self.cases().items():
            path = os.path.join(sc.SCREENS, name + ".txt")
            if not os.path.exists(path):
                continue
            with open(path) as fh:
                row = (name,) + sc.judge_words(name, c["page"], fh.read().split("\n"))
            if row[3] != "-":
                rows.append(row)
        self.assertEqual(rows, WORDS, "\n".join(sc.words_table(rows)))

    def test_configured_mcp_screens(self):
        """Screens stored with stub MCP servers configured (--mcp): the page's words equal the CLI's and the conversation matches."""
        names = sorted(f[:-4] for f in os.listdir(sc.MCP_SCREENS) if f.endswith(".txt") and not f.endswith(".picker.txt"))
        self.assertEqual(names, ["16", "27", "56", "57", "58", "59", "60"])
        rows = {}
        for sid in sorted(f[:-6] for f in os.listdir(sc.CASES) if f.endswith(".jsonl")):
            if sc.case_name(sid) in names:
                c = sc.prepare(sid, mcp=True)
                shutil.rmtree(c["tmp"], ignore_errors=True)
                with open(os.path.join(sc.MCP_SCREENS, sc.case_name(sid) + ".txt")) as fh:
                    lines = fh.read().split("\n")
                rows[sc.case_name(sid)] = (sc.judge_words(sc.case_name(sid), c["page"], lines, {})[2], sc.judge(sc.case_name(sid), c["want"], c["titles"], lines, c["titles"])[0])
        from test_screen_check import OPEN_FAIL  # data differences still open in desk/ (error cut, case 59)
        self.assertEqual(rows, {n: ("same", "FAIL" if n == "59" and n in OPEN_FAIL else "PASS") for n in names})  # 59: Update/Write errors cut at 4 lines

    def test_port_matches_the_page(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        cases = self.cases()
        src = PAGE_JS % json.dumps("file://" + os.path.join(helpers.ROOT, "web", "src", "transcript_view.js"))
        run = subprocess.run([node, "--input-type=module", "-e", src], input=json.dumps({n: c["events"] for n, c in cases.items()}),
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(run.returncode, 0, run.stderr[-2000:])
        self.assertEqual(json.loads(run.stdout), {n: c["page"] for n, c in cases.items()})

if __name__ == "__main__":
    unittest.main()
