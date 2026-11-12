"""Opens each invented case with the real CLI in a scratch HOME and compares its screen with what the app shows.

python3 tools/screen_check.py [--case N] [--keep] [--save] [--jobs N]
Per case: the conversation of `--resume <id>` against sessions.transcript(), the resume picker's title against the app's title,
and the words of each group line against the page's rule (a port of web/src/transcript_view.js groupWords), printed as a table.
Never touches the real home: every run gets a new temporary HOME holding copies of tests/fixtures/cases only.
"""
import argparse
import difflib
import json
import os
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = os.path.join(ROOT, "tests", "fixtures", "cases", "projects", "-work-cases")
SCREENS = os.path.join(ROOT, "tests", "fixtures", "screens")  # stored captures (invented content only), one per case
MCP_SCREENS = os.path.join(SCREENS, "mcp")  # captures with stub MCP servers configured in the scratch HOME (--mcp), MCP cases only
ROWS, COLS = 200, 160  # terminal size: tall enough that a case's whole conversation fits on the CLI's full screen
WAIT = 25  # seconds a CLI gets to draw its screen
QUIET = 1.2  # seconds without output after which the screen counts as drawn
SID = re.compile(r"[0-9a-fA-F-]{8,64}")
NOTICES = (re.compile(r"^Session model .* could not be restored"), re.compile(r"^Background shell command didn't finish"))  # CLI start-up notices that are not part of the conversation
GROUP = re.compile(r"^(Read|Searched|Listed|Called|Ran|Fetched|Wrote|Edited|Updated|Found)\b.*\b(files?|patterns?|director(y|ies)|times?|commands?|search(es)?|pages?)\b|^Called [A-Za-z0-9_-]+(, [A-Za-z0-9_-]+)*$")  # "Called srv": one call to a configured MCP server
PICK_META = re.compile(r"\bago\b.*·|·.*\b(\d+(\.\d+)?\s?(KB|MB|bytes))$")  # second line of a picker entry: age, branch, size
INTERRUPTED = "Interrupted · What should Claude do instead?"
KNOWN = {  # title differences that are documented, not modelled (docs/data-model.md): case -> reason
    "8": "picker leaves out a file with sidechain rows in it (0 real files)",
    "21": "picker leaves out a file with sidechain rows in it (0 real files)",
    "13": "picker leaves out headless sessions; the app lists them as automated",
    "23": "picker lists a session rewound to empty; the app has nothing to show (0 real files)",
}
MCP_UNSET = "MCP server not configured (default run): the CLI draws nothing for its calls and ends the group there; the page draws the configured form, checked with --mcp"
WORDS_KNOWN = {"16": MCP_UNSET, "27": MCP_UNSET, "56": MCP_UNSET, "57": MCP_UNSET, "58": MCP_UNSET, "59": MCP_UNSET, "60": MCP_UNSET}  # group-line word differences that are documented: case -> reason
GROUP_ORDER = (("search", "Searched for", "pattern"), ("read", "Read", "file"), ("bash", "Ran", "shell command"))  # the page's GROUP_WORDS
EXTRA_NAMES = {"43": "notes-43.jsonl"}  # cases also copied under a file name that is not a session id (the picker's view of such files)


# ---------- terminal screen ----------
def _wide(ch):
    """Cells a character takes on the terminal."""
    return 2 if unicodedata.east_asian_width(ch) in "WF" else 1


ESC = re.compile(r"\x1b(?:\[([0-9;?<>=]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[78=>cDEM])")


class Screen:
    """A small terminal: cursor moves, line and screen clears, the alternate screen and scrolling; enough for the CLI's final screen."""

    def __init__(self, rows=ROWS, cols=COLS):
        """An empty screen of rows x cols cells."""
        self.rows, self.cols, self.r, self.c, self.saved = rows, cols, 0, 0, (0, 0)
        self.cells = [[" "] * cols for _ in range(rows)]

    def _blank(self):
        """One empty line."""
        return [" "] * self.cols

    def _down(self):
        """Move to the next line, scrolling at the bottom."""
        if self.r == self.rows - 1:
            self.cells.pop(0)
            self.cells.append(self._blank())
        else:
            self.r += 1

    def _csi(self, p, f):
        """Apply one control sequence."""
        if p[:1] in "?<>=" and p:
            if p in ("?1049", "?1047", "?47") and f in "hl":
                self.cells = [self._blank() for _ in range(self.rows)]
            return
        n = [int(x) if x else 0 for x in p.split(";")] if p else []
        a = (n[0] if n else 0) or 1
        if f == "A":
            self.r = max(0, self.r - a)
        elif f in "BE":
            self.r, self.c = min(self.rows - 1, self.r + a), 0 if f == "E" else self.c
        elif f == "C":
            self.c = min(self.cols - 1, self.c + a)
        elif f == "D":
            self.c = max(0, self.c - a)
        elif f == "G":
            self.c = min(self.cols - 1, a - 1)
        elif f == "d":
            self.r = min(self.rows - 1, a - 1)
        elif f in "Hf":
            self.r = min(self.rows - 1, ((n[0] if n else 1) or 1) - 1)
            self.c = min(self.cols - 1, ((n[1] if len(n) > 1 else 1) or 1) - 1)
        elif f == "K":
            k = n[0] if n else 0
            lo, hi = (self.c, self.cols) if k == 0 else (0, self.c + 1) if k == 1 else (0, self.cols)
            self.cells[self.r][lo:hi] = [" "] * (hi - lo)
        elif f == "J":
            k = n[0] if n else 0
            if k == 0:
                self.cells[self.r][self.c:] = [" "] * (self.cols - self.c)
                self.cells[self.r + 1:] = [self._blank() for _ in range(self.rows - self.r - 1)]
            elif k == 1:
                self.cells[:self.r] = [self._blank() for _ in range(self.r)]
            else:
                self.cells = [self._blank() for _ in range(self.rows)]
        elif f in "LM":
            for _ in range(min(a, self.rows - self.r)):
                if f == "L":
                    self.cells.pop()
                    self.cells.insert(self.r, self._blank())
                else:
                    self.cells.pop(self.r)
                    self.cells.append(self._blank())

    def feed(self, data):
        """Apply terminal output (text with escape sequences)."""
        i = 0
        while i < len(data):
            ch = data[i]
            if ch == "\x1b":
                m = ESC.match(data, i)
                if not m:
                    i += 1
                    continue
                i = m.end()
                s = m.group(0)
                if s == "\x1b7":
                    self.saved = (self.r, self.c)
                elif s == "\x1b8":
                    self.r, self.c = self.saved
                elif m.group(2):
                    self._csi(m.group(1), m.group(2))
                continue
            i += 1
            if ch == "\r":
                self.c = 0
            elif ch == "\n":
                self._down()
            elif ch == "\b":
                self.c = max(0, self.c - 1)
            elif ch == "\t":
                self.c = min(self.cols - 1, (self.c // 8 + 1) * 8)
            elif ch >= " " and ch != "\x7f":
                if self.c >= self.cols:
                    self.c = 0
                    self._down()
                self.cells[self.r][self.c] = ch
                if _wide(ch) == 2 and self.c + 1 < self.cols:
                    self.cells[self.r][self.c + 1] = ""
                self.c += _wide(ch)

    def text(self):
        """The screen as lines of text, trailing blanks removed."""
        return "\n".join("".join(x).rstrip() for x in self.cells).rstrip("\n")


# ---------- reading the screen ----------
def _norm(text):
    """Text compared on both sides: whitespace collapsed, expand hints removed."""
    text = re.sub(r"\s*\(ctrl\+o (to expand|for the summary)\)", "", text)
    return " ".join(text.split())


def conversation_region(screen):
    """Lines of the conversation on a resumed screen: after the logo header, before the prompt box."""
    lines = screen.split("\n")
    end = next((i for i, x in enumerate(lines) if x.startswith("────")), len(lines))
    start = next((i + 1 for i, x in enumerate(lines[:6]) if "▝▝" in x), 0)  # the logo's last line
    return [x for x in lines[start:end] if not re.match(r"^\s*◐ .*· /effort$", x)]


def screen_blocks(lines):
    """The conversation as (kind, text) blocks: you, say (a reply or a tool line), result, group, compact."""
    out = []
    for x in lines:
        if not x.strip():
            continue
        if x.startswith("❯ "):
            out.append(["you", x[2:]])
        elif x.startswith("! "):
            out.append(["you", x])
        elif re.match(r"^\[Image #\d+\]$", x):
            out.append(["you", x])
        elif x.startswith("⏺ "):
            out.append(["say", x[2:]])
        elif x.startswith("✻ "):
            out.append(["compact", x[2:]])
        elif re.match(r"^\s{0,4}⎿\s", x):
            out.append(["result", re.sub(r"^\s{0,4}⎿\s+", "", x)])
        elif x.startswith("     ") and out and out[-1][0] == "result":
            out[-1][1] += "\n" + x[5:]
        elif x.startswith("  ") and not x.startswith("   ") and GROUP.match(x[2:]):
            if not out or out[-1][0] != "group":
                out.append(["group", ""])
        elif x.startswith("  ") and out:
            out[-1][1] += "\n" + x[2:]
        else:
            out.append(["other", x])
    out = [b for b in out if not (b[0] == "say" and any(n.match(b[1]) for n in NOTICES))]
    joined = []
    for b in out:  # stdout and stderr of a ! command are two result blocks on screen; the app sends them as one
        if b[0] == "result" and len(joined) > 1 and joined[-1][0] == "result" and joined[-2][0] == "you" and joined[-2][1].startswith("! "):
            joined[-1] = ["result", joined[-1][1] + "\n" + b[1]]
        else:
            joined.append(b)
    out = joined
    return [(k, _norm(t)) for k, t in out]


def expected_blocks(events, mcp=False):
    """The blocks the CLI's default view should show for the app's sidebar events (sessions.transcript()); mcp: MCP servers configured (--mcp)."""
    out = []
    grouped = ("Read", "Grep", "Glob")
    for e in events:
        k = e[0]
        if k == "you":
            out.append(("you", "[Image #1]" if e[1] == "[Image]" else e[1]))
        elif k == "claude":
            out.append(("say", e[1]))
        elif k == "tool":
            name, res, err, display, quiet = e[1], e[3], e[4], e[5], e[6]
            if name.startswith("mcp__") and mcp:  # configured: the call joins the group line, errors included (screens/mcp 16, 59)
                if not out or out[-1][0] != "group":
                    out.append(("group", ""))
                continue
            if name.startswith("mcp__") and err:
                out.append(("result", res))  # a server the scratch HOME does not configure: no call line, only the error (case 59, 60)
                continue
            if not display or name.startswith("mcp__"):
                continue  # drawn by nothing, or by a server the scratch HOME does not configure
            if name in grouped or name == "Bash":  # every shell call joins "Ran N shell commands", errors included
                if not out or out[-1][0] != "group":
                    out.append(("group", ""))
                continue
            out.append(("say", display))
            if not quiet and res:
                out.append(("result", res))
        elif k == "out":
            out.append(("result", e[1]))
        elif k == "interrupt":
            out.append(("result", INTERRUPTED))
        elif k == "image":
            out.append(("result", "[Image #1]"))  # a resumed session numbers every image #1
        elif k == "compact":
            out += [("compact", "Conversation compacted")] + ([("say", "Compact summary")] if len(e) < 2 or e[1] else [])
    return [(k, _norm(t)) for k, t in out]


def picker_titles(screen):
    """Titles the resume picker lists, top to bottom."""
    lines = screen.split("\n")
    start = next((i + 1 for i, x in enumerate(lines) if x.lstrip().startswith("╰")), 0)
    out = []
    for i in range(start, len(lines) - 1):
        if PICK_META.search(lines[i + 1].strip()) and not PICK_META.search(lines[i].strip()):
            out.append(re.sub(r"^\s*[❯↓↑]?\s*", "", lines[i]).strip())
    return out


def same_title(app, pick):
    """'same', 'intended' (a documented difference) or '' when the app title and the picker's title differ."""
    if app == pick or (app.endswith("…") and pick.startswith(app[:-1].rstrip())) or (pick.endswith("…") and app.startswith(pick[:-1].rstrip())):
        return "same"
    sys.path.insert(0, ROOT)
    from desk import transcripts as tx
    return "intended" if app == tx.no_tags(tx.own_words(pick)) else ""


def screen_groups(lines):
    """Each group line on the screen, top to bottom, with any result lines drawn under it (" ⎿ text"); the interrupt marker is left out (the app sends it as its own event)."""
    out, cur = [], None
    for x in lines:
        if x.startswith("  ") and not x.startswith("   ") and GROUP.match(x[2:]):
            cur = [x[2:]]
            out.append(cur)
        elif cur is not None and re.match(r"^\s{0,4}⎿\s", x):
            cur.append(re.sub(r"^\s{0,4}⎿\s+", "", x))
        elif cur is not None and x.startswith("     ") and len(cur) > 1:
            cur[-1] += "\n" + x[5:]
        elif x.strip():
            cur = None
    return [" ⎿ ".join(_norm(t) for t in g if t != INTERRUPTED) for g in out]


def _silent(e):
    """Port of transcript_view.js silentTool: a call the CLI prints nothing for."""
    return e[0] == "tool" and len(e) >= 6 and e[5] == "" and not e[4]


def _rides(e):
    """Port of transcript_view.js ridesAlong: a silent call or a branch marker inside a group."""
    return isinstance(e, list) and bool(e) and (e[0] == "elsewhere" or _silent(e))


def group_kind(e):
    """Port of transcript_view.js groupKind: search, read, bash, mcp:<server>, or '' for a call drawn on its own."""
    if not isinstance(e, list) or not e or e[0] != "tool" or len(e) < 7 or _silent(e):
        return ""
    n, m = str(e[1]), re.match(r"^mcp__(.+?)__.", str(e[1]))
    return "search" if n in ("Grep", "Glob") else "read" if n == "Read" else "bash" if n == "Bash" else "mcp:" + m.group(1) if m else ""


def group_words(kinds):
    """Port of transcript_view.js groupWords: the page's group line for these call kinds (order search, read, called, ran)."""
    n = {}
    for k in kinds:
        n[k] = n.get(k, 0) + 1
    pl = lambda c, w: f"{c} {w}{'' if c == 1 else 's'}"  # noqa: E731
    parts = [f"{v} {pl(n[k], w)}" for k, v, w in GROUP_ORDER if k in n]
    srv = [k for k in n if k.startswith("mcp:")]
    if srv:
        calls = sum(n[k] for k in srv)
        parts.insert(len(parts) - ("bash" in n), "Called " + ", ".join(k[4:] for k in srv) + (f" {calls} times" if calls > 1 else ""))
    return ", ".join(p[0].lower() + p[1:] if i else p for i, p in enumerate(parts))


def group_end(ev, i):
    """Port of transcript_view.js groupEnd: end (exclusive) of the group starting at i; silent calls and branch markers ride along."""
    if not group_kind(ev[i]):
        return i
    end, j = i + 1, i + 1
    while j < len(ev) and (group_kind(ev[j]) or _rides(ev[j])):
        end = j + 1 if group_kind(ev[j]) else end
        j += 1
    return end


def page_groups(events):
    """The page's group lines (default view, folds open) for the app's sidebar events; a closed group draws nothing under its line but page-only branch notes (groupHtml)."""
    out, i = [], 0
    while i < len(events):
        k = group_end(events, i)
        if k > i:
            out.append(group_words([group_kind(e) for e in events[i:k] if group_kind(e)]))
            i = k
        else:
            i += 1
    return out


def judge_words(name, page, lines, known=None):
    """(CLI group words, page group words, verdict): '-' with no group line on either side, 'same', 'KNOWN' (known, WORDS_KNOWN by default) or 'FAIL'."""
    cli = screen_groups(lines)
    verdict = "-" if not cli and not page else "same" if cli == page else "KNOWN" if name in (WORDS_KNOWN if known is None else known) else "FAIL"
    return cli, page, verdict


def words_table(rows):
    """The group-word table as text lines: case, CLI words, page words, verdict (groups split by ' | ')."""
    out = [f"{'case':<5} {'CLI words':<58} {'page words':<64} verdict"]
    for name, cli, page, v in rows:
        if v != "-":
            out.append(f"{name:<5} {' | '.join(cli) or '(none)':<58} {' | '.join(page) or '(none)':<64} {v}")
    return out


def compare(want, got):
    """Lines of a diff between expected and shown blocks; empty when equal."""
    if want == got:
        return []
    return list(difflib.unified_diff([f"{k}: {t}" for k, t in want], [f"{k}: {t}" for k, t in got], "app", "cli", lineterm="", n=1))


# ---------- scratch HOME and the CLI ----------
def case_name(sid):
    """Case number of a fixture session id (c000001b-... -> 27), else the id's first 8 characters."""
    return str(int(sid[1:8], 16)) if re.fullmatch(r"c[0-9a-f]{7}-0000-4000-8000-[0-9a-f]{12}", sid) else sid[:8]


def companions(path):
    """Other case files a case needs beside it: sessions it continued in, and files named in a `companion` line."""
    out = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if '"continuedInSessionId"' in line or '"screenCheckCompanion"' in line:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                for v in (r.get("continuedInSessionId"), r.get("screenCheckCompanion")):
                    if isinstance(v, str) and os.path.exists(os.path.join(CASES, v + ".jsonl")):
                        out.append(v + ".jsonl")
    return out


STUB = """import json, sys
tools = sys.argv[1:]
for line in sys.stdin:
    try:
        m = json.loads(line)
    except ValueError:
        continue
    if not isinstance(m, dict) or "id" not in m:
        continue
    if m.get("method") == "initialize":
        out = {"result": {"protocolVersion": (m.get("params") or {}).get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "stub", "version": "0"}}}
    elif m.get("method") == "tools/list":
        out = {"result": {"tools": [{"name": t, "description": "Invented tool.", "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}}} for t in tools]}}
    else:
        out = {"error": {"code": -32601, "message": "not supported"}}
    sys.stdout.write(json.dumps(dict(out, jsonrpc="2.0", id=m["id"])) + "\\n")
    sys.stdout.flush()
"""  # a local MCP server over stdio that answers only initialize and tools/list (no network, never runs a tool)
MCP_NAME = re.compile(r'"name":"mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)"')


def mcp_servers(tmp, files):
    """User-scope MCP config for the scratch HOME: one stub server per server name the case files call, listing the tools they call."""
    tools = {}
    for f in files:
        with open(os.path.join(CASES, f), encoding="utf-8", errors="replace") as fh:
            for srv, tool in MCP_NAME.findall(fh.read()):
                tools.setdefault(srv, set()).add(tool)
    if not tools:
        return {}
    stub = os.path.join(tmp, "mcp_stub.py")
    with open(stub, "w") as fh:
        fh.write(STUB)
    return {srv: {"type": "stdio", "command": sys.executable, "args": ["-I", stub] + sorted(t), "env": {}} for srv, t in sorted(tools.items())}


def build_home(tmp, files, mcp=False):
    """A scratch HOME holding copies of the given case files under the project of its work folder, with stub MCP servers when mcp; returns (home, work folder, project folder)."""
    home = os.path.join(tmp, "home")
    work = os.path.join(home, "w")
    os.makedirs(work)
    proj = os.path.join(home, ".claude", "projects", re.sub(r"[^A-Za-z0-9]", "-", work))
    os.makedirs(proj)
    os.makedirs(os.path.join(home, ".claude", "sessions"))
    for f in files:
        with open(os.path.join(CASES, f), encoding="utf-8", errors="replace") as src, open(os.path.join(proj, f), "w", encoding="utf-8") as dst:
            for line in src:
                dst.write(re.sub(r'"cwd":"[^"]*"', json.dumps({"cwd": work}, separators=(",", ":"))[1:-1], line))  # rows were written in the work folder
        st = os.stat(os.path.join(CASES, f))
        os.utime(os.path.join(proj, f), ns=(st.st_atime_ns, st.st_mtime_ns))
    with open(os.path.join(home, ".claude.json"), "w") as fh:
        json.dump({"hasCompletedOnboarding": True, "projects": {work: {"hasTrustDialogAccepted": True}}, "mcpServers": mcp_servers(tmp, files) if mcp else {}}, fh)  # scratch HOME only
    return home, work, proj


def run_cli(binary, home, work, args, ready):
    """Run the CLI in a pseudo-terminal until its screen is drawn, quit it with the keys it names; returns the screen text."""
    import pty
    import fcntl
    import struct
    import termios
    env = {"HOME": home, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TERM": "xterm-256color", "LANG": "en_US.UTF-8", "DISABLE_AUTOUPDATER": "1",
           "DISABLE_TELEMETRY": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "SCREEN_CHECK_HOME": home}
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    p = subprocess.Popen([binary] + args, cwd=work, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True, close_fds=True)
    os.close(slave)
    scr, data, last, t0 = Screen(), b"", time.time(), time.time()

    def pump(secs):
        """Read output for up to secs seconds; False when the CLI closed the terminal."""
        nonlocal data, last
        end = time.time() + secs
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.1)
            if not r:
                continue
            try:
                d = os.read(master, 65536)
            except OSError:
                return False
            if not d:
                return False
            data += d
            last = time.time()
        return True

    try:
        while time.time() - t0 < WAIT:
            alive = pump(0.3)
            scr = Screen()
            scr.feed(data.decode("utf-8", "replace"))
            if not alive or (ready(scr.text()) and time.time() - last > QUIET):
                break
        shown = scr.text()
        for key in (b"\x1b", b"\x03", b"\x03"):  # Esc closes the picker; Ctrl-C twice ends the CLI (it says "Press Ctrl-C again to exit")
            if p.poll() is not None:
                break
            try:
                os.write(master, key)
            except OSError:
                break
            pump(0.4)
    finally:
        os.close(master)
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
    return shown


# ---------- the app's side ----------
def app_side(claude_dir, state):
    """Point the app at the scratch data folder; returns the desk modules (imported once, re-pointed per case)."""
    sys.path.insert(0, ROOT)
    from desk import config, sessions, summaries, transcripts
    config.HOME, config.STATS_FILE = claude_dir, os.path.join(state, "stats.json")
    sessions._cache.clear(), sessions._full.clear(), sessions._views.clear()
    transcripts._found.clear(), transcripts._states.clear()
    summaries.reset()
    return sessions


def prepare(sid, mcp=False):
    """Build the scratch HOME of one case and take the app's side of it (one case at a time: the app keeps module state)."""
    tmp = os.path.realpath(tempfile.mkdtemp(prefix="screen-check-"))  # the CLI keys folder trust by the real path
    files = [sid + ".jsonl"] + [f for f in companions(os.path.join(CASES, sid + ".jsonl")) if f != sid + ".jsonl"]
    home, work, proj = build_home(tmp, files, mcp)
    if case_name(sid) in EXTRA_NAMES:
        shutil.copy2(os.path.join(proj, sid + ".jsonl"), os.path.join(proj, EXTRA_NAMES[case_name(sid)]))
    sessions = app_side(os.path.join(home, ".claude"), tmp)
    events = sessions.transcript(os.path.join(proj, sid + ".jsonl"))[0]
    titles = [o["title"] for o in sessions.sessions()]
    return {"sid": sid, "tmp": tmp, "home": home, "work": work, "want": expected_blocks(events, mcp), "titles": titles, "page": page_groups(events), "events": events}


def judge(name, want, titles, region, shown_titles):
    """(conversation verdict, title verdict, detail lines) for one case's app side, its conversation lines and the picker's titles."""
    detail, diff = [], compare(want, screen_blocks(region))
    if diff:
        detail += ["  conversation:"] + ["    " + x for x in diff]
    if sorted(titles) == sorted(shown_titles):
        tv = "PASS"
    elif len(titles) == len(shown_titles) and all(any(same_title(a, b) for b in shown_titles) for a in titles):
        tv = "PASS (intended)"
        detail.append(f"  title: app {titles} picker {shown_titles} (documented difference)")
    elif name in KNOWN:
        tv = "KNOWN"
        detail.append(f"  title: app {titles} picker {shown_titles} ({KNOWN[name]})")
    else:
        tv = "FAIL"
        detail.append(f"  title: app {titles} picker {shown_titles}")
    return ("FAIL" if diff else "PASS"), tv, detail


def check_case(binary, c, keep, save, mcp=False):
    """Run the CLI on one prepared case: returns (name, conversation verdict, title verdict, detail lines, words row)."""
    name = case_name(c["sid"])
    try:
        conv = run_cli(binary, c["home"], c["work"], ["--resume", c["sid"]], lambda s: "────" in s)
        pick = run_cli(binary, c["home"], c["work"], ["--resume"], lambda s: "Esc to cancel" in s or "No conversations" in s)
        shown_titles = picker_titles(pick)
        if save:
            folder = MCP_SCREENS if mcp else SCREENS
            os.makedirs(folder, exist_ok=True)
            with open(os.path.join(folder, f"{name}.txt"), "w") as fh:
                fh.write("\n".join(conversation_region(conv)).strip("\n") + "\n")
            with open(os.path.join(folder, f"{name}.picker.txt"), "w") as fh:
                fh.write("\n".join(shown_titles) + "\n")
        cv, tv, detail = judge(name, c["want"], c["titles"], conversation_region(conv), shown_titles)
        words = (name,) + judge_words(name, c["page"], conversation_region(conv), {} if mcp else None)
        if words[3] == "KNOWN":
            detail.append(f"  words: {WORDS_KNOWN[name]}")
        if keep:
            detail.append(f"  kept: {c['tmp']}")
        return name, cv, tv, detail, words
    finally:
        if not keep:
            shutil.rmtree(c["tmp"], ignore_errors=True)


def cli_binary():
    """Path of the CLI: DESK_CLAUDE_BIN, else the one on PATH."""
    return os.environ.get("DESK_CLAUDE_BIN") or shutil.which("cl" + "aude") or ""


def main(argv=None):
    """Run the screen check over the cases; exit 1 on any FAIL, 2 when the CLI cannot be started."""
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--case", action="append", help="case number (27) or session id prefix; repeatable")
    ap.add_argument("--keep", action="store_true", help="keep the scratch HOME of each case and print its path")
    ap.add_argument("--save", action="store_true", help="store each screen under tests/fixtures/screens")
    ap.add_argument("--jobs", type=int, default=4, help="cases checked at once")
    ap.add_argument("--mcp", action="store_true", help="configure a local stub MCP server per server name the case calls (scratch HOME only); --save stores under screens/mcp")
    a = ap.parse_args(argv)
    binary = cli_binary()
    try:
        version = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=30, env={"HOME": tempfile.gettempdir(), "PATH": "/usr/bin:/bin"}).stdout.strip()
    except (OSError, subprocess.SubprocessError) as e:
        print(f"SKIP  all cases: the CLI cannot be started ({binary or 'not found'}: {e.__class__.__name__})")
        return 2
    print(f"CLI {version or '(no version)'} at {binary}")
    ids = sorted(f[:-6] for f in os.listdir(CASES) if f.endswith(".jsonl") and SID.fullmatch(f[:-6]))
    if a.case:
        ids = [i for i in ids if any(case_name(i) == c or i.startswith(c) for c in a.case)]
    prepared = [prepare(s, a.mcp) for s in ids]
    results = []
    with ThreadPoolExecutor(max(1, a.jobs)) as pool:
        for r in pool.map(lambda c: check_case(binary, c, a.keep, a.save, a.mcp), prepared):
            name, cv, tv, detail, words = r
            print(f"{cv:<5} conversation  {tv:<15} title  {words[3]:<5} words  case {name}")
            for x in detail:
                print(x)
            results.append(r)
    print("\n".join(["", "Group lines (default view):"] + words_table([r[4] for r in results]) + [""]))
    fails = sum(1 for r in results if r[1] == "FAIL" or r[2] == "FAIL" or r[4][3] == "FAIL")
    conv_pass = sum(1 for r in results if r[1] == "PASS")
    title_pass = sum(1 for r in results if r[2].startswith("PASS"))
    known = sum(1 for r in results if r[2] == "KNOWN")
    wv = [r[4][3] for r in results if r[4][3] != "-"]
    print(f"{len(results)} cases: conversation {conv_pass} PASS {len(results) - conv_pass} FAIL; title {title_pass} PASS {known} KNOWN {len(results) - title_pass - known} FAIL; "
          f"group words {wv.count('same')} same {wv.count('KNOWN')} KNOWN {wv.count('FAIL')} FAIL")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
