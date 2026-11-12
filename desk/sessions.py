"""Session summaries for the list and garden: titles, live status, behind/also/subs, and whole transcripts for the sidebar."""
import bisect
import os
import re
import subprocess
import time
from collections import deque
from datetime import datetime

from . import config, stats, summaries, terms, transcripts as tx

RECENT = 60  # finished sessions a person typed into that are listed, newest first
RECENT_AUTO = 60  # finished automated sessions (hook or -p runs) that are listed, newest first
AUTO_NAME = re.compile(r"^(side chat|untitled|.+-[0-9a-f]{2})$", re.I)
TITLE_LEN = 60  # characters of a prompt used as a title
CLOCK = time.time  # what "today" is measured by; tests replace it
_cache = {}  # path -> ((mtime_ns, size, inode, ctime_ns), summary), least recently stored first
_views = {}  # path -> ((mtime_ns, size, inode, ctime_ns), list view), least recently stored first
CACHE_MAX = 10000  # list views kept, least recently used dropped first (about 1.5 KB each)
SUMMARY_MAX = 512  # whole summaries kept (at most about 30 KB each), least recently used dropped first
TEXT_MAX = 2000  # characters kept of the latest request, reply and first request in a summary
TL_TEXT = 200  # characters kept per timeline entry of a summary (only whether it is empty is used)
DAYS_KEPT = 7  # newest days kept in a summary's per-day figures; only today's are sent
_full = {}  # path -> (key, (events, files), characters), at most FULL_MAX entries and FULL_CHARS characters
FULL_MAX = 4  # whole transcripts kept for the sidebar
FULL_CHARS = 16 << 20  # text characters those kept transcripts may hold together; the newest one is always kept
_folds = {}  # (path, "list" or "side") -> what the last read folded (_ListFold, _SideFold), at most FOLD_MAX entries
FOLD_MAX = 8  # folded reads kept: an append that only adds rows to the end of the shown conversation folds just those rows
_starts = {"pids": (), "at": 0.0, "map": {}}  # latest process start times from ps
# Every listable transcript seen by the last list pass: its key and where it sits. Finished files with an index entry sit in one sorted list per class
# (automated or not) when shown; files without a valid entry sit in `unknown` until the list loop needs them; tokens are (-mtime_ns, path).
_order = {"home": None, "ix": None, "keys": {}, "at": {}, "ids": {}, "lists": {False: [], True: []}, "unknown": []}
STARTS_TTL = 5  # seconds a ps answer is reused


def process_starts(pids):
    """Start time of each running pid as `ps` prints it in UTC (the registry's procStart format); cached briefly, empty when ps fails."""
    pids = tuple(sorted(set(pids)))
    if not pids:
        return {}
    if _starts["pids"] == pids and time.monotonic() - _starts["at"] < STARTS_TTL:
        return _starts["map"]
    found = {}
    try:
        out = subprocess.run(["ps", "-o", "pid=,lstart=", "-p", ",".join(map(str, pids))], capture_output=True, text=True, timeout=5,
                             env={"TZ": "UTC", "LC_ALL": "C", "PATH": "/bin:/usr/bin"}).stdout
        for line in out.splitlines():
            bits = line.split(None, 1)
            if len(bits) == 2 and bits[0].isdigit():
                found[int(bits[0])] = " ".join(bits[1].split())
    except (OSError, subprocess.SubprocessError):
        found = {}
    _starts.update(pids=pids, at=time.monotonic(), map=found)
    return found


def holders():
    """Map sessionId -> every live process that holds it (running pid, same process the file names, not parked): pid, status, at, name, entry."""
    alive = []
    for p in tx.registry():
        if p["parked"]:
            continue
        try:
            os.kill(p["pid"], 0)
        except (ProcessLookupError, ValueError, OSError, OverflowError):
            continue
        alive.append(p)
    starts = process_starts(p["pid"] for p in alive if p["start"])
    out = {}
    for p in alive:
        if p["start"] and starts.get(p["pid"]) not in (None, p["start"]):
            continue  # the pid now belongs to another process: the file is stale
        out.setdefault(p["sid"], []).append({k: p[k] for k in ("pid", "status", "at", "name", "entry")})
    return out


def live(hold=None):
    """Map sessionId -> (status, statusUpdatedAt, name); busy wins, and a page terminal that only sits at its first prompt does not count."""
    out = {}
    for sid, procs in (holders() if hold is None else hold).items():
        mine = terms.own_pid(sid)
        t0 = terms._terms[sid].t0 if mine else 0
        seen = [p for p in procs if p["pid"] != mine or p["status"] == "busy" or p["at"] > t0 + 20_000]
        if not seen:
            continue
        busy = [p for p in seen if p["status"] == "busy"]
        pick = max(busy or seen, key=lambda p: p["at"])
        out[sid] = ("busy" if busy else pick["status"], pick["at"], pick["name"])
    return out


def behind(sid, d, hold):
    """True when the page terminal sits idle while another copy of the session wrote newer messages."""
    mine = terms.own_pid(sid)
    me = next((p for p in hold.get(sid, []) if p["pid"] == mine), None) if mine else None
    if not me or me["status"] == "busy":
        return False
    base = max(me["at"], terms._terms[sid].t0)
    return (d["lastBy"] != me["entry"] and d["lastAt"] > base + 3000) or terms._replies.get(sid, {}).get("done_at", 0) > base


def elsewhere(sid, hold):
    """Plain names of the other programs that hold a session open."""
    names = {"claude-desktop": "desktop app", "cli": "another terminal"}
    return sorted({names.get(p["entry"], p["entry"] or "another program") for p in hold.get(sid, []) if p["pid"] != terms.own_pid(sid)})


def tool_line(name, inp):
    """One readable line for a tool call."""
    return (name + " " + tx.tool_hint(inp))[:120]


def tool_summary(items):
    """Collapse a run of tool calls into 'Read 6 files, edited 2, ran 3 commands'."""
    n = {"read": 0, "edit": 0, "run": 0, "search": 0, "other": 0}
    for item in items:
        n[tx.tool_kind(item.split(" ", 1)[0])] += 1
    parts = [
        n["read"] and f"read {n['read']} file{'s' * (n['read'] != 1)}",
        n["edit"] and f"edited {n['edit']} time{'s' * (n['edit'] != 1)}",
        n["run"] and f"ran {n['run']} command{'s' * (n['run'] != 1)}",
        n["search"] and f"searched {n['search']} time{'s' * (n['search'] != 1)}",
        n["other"] and f"used {n['other']} other tool{'s' * (n['other'] != 1)}",
    ]
    text = ", ".join(p for p in parts if p)
    return text[:1].upper() + text[1:]


def _read(path, brief=False):
    """Load a transcript once: (transcript, what its conversation shows marking other programs' branches, newest reply time, conversation rows).
    brief: the other programs' marks in place of the view (the list folds the rows' kept facts). A file cut or rewritten under its kept index is read again whole once."""
    for again in (False, True):
        if again:
            tx.discard(path)
        t = tx.load(path)
        conv = tx.conversation(t)
        try:
            marks = tx.elsewhere(t, conv)
            return t, (marks if brief else tx.view(conv, marks)), tx.turn_end(conv), conv
        except tx.Stale:
            if again:
                raise


def day_of(epoch):
    """Calendar day (YYYY-MM-DD) of an epoch second in the stats time zone."""
    return datetime.fromtimestamp(epoch, stats.IL).date().isoformat()


def per_day(t, conv):
    """{day: [tokens, pull requests]} of the shown conversation: this session's own assistant messages and PRs, by row time."""
    msgs, days = {}, {}
    for rec in conv:
        if rec.kind == "assistant" and rec.msg_id and tx.own_message(t, rec) and rec.usage() is not None and rec.epoch is not None:
            msgs[rec.msg_id] = rec  # one message is split over several rows: its last row counts, once
    for rec in msgs.values():
        u = rec.usage()
        days.setdefault(day_of(rec.epoch), [0, 0])[0] += u["input_tokens"] + u["output_tokens"] + u["cache_creation_input_tokens"]
    for when in tx.prs_on(conv).values():
        days.setdefault(day_of(when), [0, 0])[1] += 1
    return {k: days[k] for k in sorted(days)[-DAYS_KEPT:]}


def title_text(text, n):
    """A prompt on one line (whitespace runs become one space, as the CLI's picker prints it), cut at a word boundary."""
    line = " ".join((text or "").split())
    return line if len(line) <= n else line[:n].rsplit(" ", 1)[0] + "\u2026"


def stat_key(stat):
    """Cache key of a transcript: mtime, size, inode (a replaced file has a new inode) and ctime (an in-place rewrite that restores mtime moves it)."""
    return (stat.st_mtime_ns, stat.st_size, stat.st_ino, stat.st_ctime_ns)


def parse(path):
    """Summary of one session for the list: title facts, latest request and reply, timeline, totals; cached by mtime, size and inode."""
    return _parse(path, os.stat(path))


def _parse(path, stat):
    """parse() for a file already stat-ed."""
    key = stat_key(stat)
    hit = _cache.get(path)
    if hit and hit[0] == key:
        _cache[path] = _cache.pop(path, hit)  # mark as recently used
        return hit[1]
    if not tx.SLIM:
        return _parse_whole(path, stat, key)
    for again in (False, True):
        t, marks, end, conv = _read(path, brief=True)
        try:
            return _summary(path, stat, key, t, marks, end, conv)
        except tx.Stale:
            if again:
                raise
            tx.discard(path)
            _folds.pop((path, "list"), None)


class _ListFold:
    """What the list's summary rules folded over a conversation and the file-order messages, so an append folds only the rows it added."""
    __slots__ = ("conv", "first", "lastm", "nm", "cwd", "branch", "model", "last_ts", "last_by", "usage", "tokens", "tl", "files", "newest", "tool", "err",
                 "msgs", "prs")

    def __init__(self):
        self.conv, self.first, self.lastm, self.nm, self.cwd, self.branch, self.model, self.last_ts, self.last_by = [], None, None, 0, "", "", "", "", ""
        self.usage, self.tokens, self.tl, self.files, self.newest, self.tool, self.err = {}, 0, deque(maxlen=80), {}, {}, "", False
        self.msgs, self.prs = {}, tx.prs_start()

    def copy(self):
        """A copy that can fold more rows without changing this one (cached folds are shared between threads)."""
        c = _ListFold.__new__(_ListFold)
        for k in _ListFold.__slots__:
            setattr(c, k, getattr(self, k))
        c.usage, c.files, c.newest, c.msgs, c.prs = dict(self.usage), dict(self.files), dict(self.newest), dict(self.msgs), tx.prs_copy(self.prs)
        c.tl = deque(([e[0], e[1], list(e[2])] if e[0] == "tools" else e for e in self.tl), maxlen=80)
        return c


def _fold_get(path, kind):
    """A kept fold of this path, marked as recently used."""
    f = _folds.pop((path, kind), None)
    if f is not None:
        _folds[(path, kind)] = f
    return f


def _fold_put(path, kind, f):
    """Keep a fold, dropping the least recently used past FOLD_MAX."""
    _folds.pop((path, kind), None)
    _folds[(path, kind)] = f
    while len(_folds) > FOLD_MAX:
        _folds.pop(next(iter(_folds)), None)


def _list_fold(path, t, conv):
    """The list fold of this conversation: the kept one grown by the rows added at the end, or folded whole when anything earlier changed."""
    old = _fold_get(path, "list")
    n, msgs = len(old.conv) if old else 0, t.messages
    same = old is not None and len(conv) >= n and conv[:n] == old.conv and len(msgs) >= old.nm and (
        old.nm == 0 or (msgs[0] is old.first and msgs[old.nm - 1] is old.lastm))
    f = old.copy() if same else _ListFold()
    _fold_rows(f, t, conv[len(f.conv):] if same else conv)
    _fold_messages(f, t, msgs)
    f.conv = conv
    _fold_put(path, "list", f)
    return f


def _fold_rows(f, t, rows):
    """Fold conversation rows into the timeline, edited files, newest prompt and reply, last tool, per-day tokens and pull requests."""
    for item in tx.brief_view(rows):
        if item[0] in ("you", "claude"):
            f.newest[item[0]] = item
            f.tl.append([item[0], item[1][:TL_TEXT]])
        elif item[0] == "tool":
            name, fl = item[2], item[4]
            f.tool = name
            if fl:
                f.files[fl] = f.files.get(fl, 0) + 1
            line = (name + " " + item[3])[:120]
            if f.tl and f.tl[-1][0] == "tools":
                f.tl[-1][2].append(line)
            else:
                f.tl.append(["tools", "", [line]])
        elif item[0] == "result":
            f.err = bool(item[2])
    for rec in rows:
        if rec.kind == "assistant" and rec.msg_id and tx.own_message(t, rec) and rec.usage() is not None and rec.epoch is not None:
            u = rec.usage()
            f.msgs[rec.msg_id] = (day_of(rec.epoch), u["input_tokens"] + u["output_tokens"] + u["cache_creation_input_tokens"])  # its last row counts, once
    tx.prs_fold(f.prs, rows)


def _fold_messages(f, t, msgs):
    """Fold the file-order messages added since the last fold: project, branch, model, newest message time and program, tokens spent."""
    for rec in msgs[f.nm:]:
        f.cwd = rec.cwd or f.cwd
        f.branch = rec.branch or f.branch
        f.last_ts, f.last_by = rec.timestamp or f.last_ts, rec.entry
        if rec.kind == "assistant":
            f.model = rec.model or f.model
            u = rec.usage()
            if rec.msg_id and u is not None and tx.own_message(t, rec):
                was = f.usage.get(rec.msg_id)
                f.usage[rec.msg_id] = u  # one message is split over several lines: count it once
                f.tokens += _spent(u) - (_spent(was) if was else 0)
    f.nm = len(msgs)
    f.first, f.lastm = (msgs[0], msgs[-1]) if msgs else (None, None)


def _spent(u):
    """Tokens a message spent: input, output and cache creation."""
    return u["input_tokens"] + u["output_tokens"] + u["cache_creation_input_tokens"]


def _days(f):
    """Per-day figures of a list fold, as per_day() gives them."""
    days = {}
    for day, n in f.msgs.values():
        days.setdefault(day, [0, 0])[0] += n
    for when in tx.prs_out(f.prs).values():
        days.setdefault(day_of(when), [0, 0])[1] += 1
    return {k: days[k] for k in sorted(days)[-DAYS_KEPT:]}


def _summary(path, stat, key, t, marks, end, conv):
    """parse() from the rows' kept facts, folding only rows an append added when it can: the newest prompt and reply are read again whole."""
    f = _list_fold(path, t, conv)
    prompt, fallback = tx.prompt_title(t)
    prompt = tx.no_tags(tx.own_words(prompt))
    d = {"title": t.custom or t.ai or None, "first": (t.first or None) and t.first[:TEXT_MAX], "prompt": prompt[:TEXT_MAX], "promptTitle": title_text(prompt, TITLE_LEN),
         "fallback": fallback, "days": _days(f), "kind": tx.session_kind(t), "automated": tx.automated(t),
         "consistency": "diverged" if marks else "ok", "lastTool": f.tool,
         "lastError": f.err, "prOpened": len(t.prs), "turnEnd": end, "cwd": f.cwd, "branch": f.branch, "model": f.model, "last": "",
         "tl": deque((list(e) if e[0] != "tools" else [e[0], e[1], list(e[2])] for e in f.tl), maxlen=80), "files": dict(f.files),
         "continuedIn": t.continued}
    for k, item in f.newest.items():
        d["you" if k == "you" else "last"] = tx.brief_text(item)[:TEXT_MAX]
    d["tokens"] = f.tokens
    return _finish(path, stat, key, d, None, f.last_ts, f.last_by)


def _parse_whole(path, stat, key):
    """parse() from the whole view of every row (the path before slim rows, kept as the tests' oracle)."""
    t, items, end, conv = _read(path)
    tool, err = tx.last_tool(items)
    prompt, fallback = tx.prompt_title(t)
    prompt = tx.no_tags(tx.own_words(prompt))
    d = {"title": t.custom or t.ai or None, "first": (t.first or None) and t.first[:TEXT_MAX], "prompt": prompt[:TEXT_MAX], "promptTitle": title_text(prompt, TITLE_LEN),
         "fallback": fallback, "days": per_day(t, conv), "kind": tx.session_kind(t), "automated": tx.automated(t),
         "consistency": "diverged" if any(i[0] == "elsewhere" for i in items) else "ok", "lastTool": tool,
         "lastError": err, "prOpened": len(t.prs), "turnEnd": end, "cwd": "", "branch": "", "model": "", "last": "", "tl": deque(maxlen=80), "files": {},
         "continuedIn": t.continued}
    usage, last_ts, last_by = {}, "", ""
    for rec in t.messages:
        d["cwd"] = rec.cwd or d["cwd"]
        d["branch"] = rec.branch or d["branch"]
        last_ts, last_by = rec.timestamp or last_ts, rec.entry
        if rec.kind == "assistant":
            d["model"] = rec.model or d["model"]
            u = rec.usage()
            if rec.msg_id and u is not None and tx.own_message(t, rec):
                usage[rec.msg_id] = u  # one message is split over several lines: count it once
    for item in items:
        if item[0] in ("you", "claude"):
            d["you" if item[0] == "you" else "last"] = item[1][:TEXT_MAX]
            d["tl"].append([item[0], item[1][:TL_TEXT]])
        elif item[0] == "tool":
            _, _, name, inp = item
            f = tx.edited_file(name, inp)
            if f:
                d["files"][f] = d["files"].get(f, 0) + 1
            if d["tl"] and d["tl"][-1][0] == "tools":
                d["tl"][-1][2].append(tool_line(name, inp))
            else:
                d["tl"].append(["tools", "", [tool_line(name, inp)]])
    return _finish(path, stat, key, d, usage, last_ts, last_by)


def _finish(path, stat, key, d, usage, last_ts, last_by):
    """Totals, timeline and times of a summary; stores it in the cache."""
    if usage is not None:
        d["tokens"] = sum(_spent(u) for u in usage.values())
    d["tl"] = [[e[0], tool_summary(e[2]), e[2][:40]] if e[0] == "tools" else e for e in d["tl"]]
    d["updated"] = int(stat.st_mtime * 1000)
    at = tx.epoch(last_ts) if last_ts else None
    d["lastAt"] = int(at * 1000) if at is not None else 0  # newest message in the file, any branch: when, and by which program
    d["lastBy"] = last_by
    _cache.pop(path, None)
    _cache[path] = (key, d)
    while len(_cache) > min(CACHE_MAX, SUMMARY_MAX):
        _cache.pop(next(iter(_cache)))
    return d


def view(d):
    """The part of a summary the list needs, as short capped texts and counts (what the summary cache keeps on disk)."""
    return {"title": d["title"][:80] if d["title"] else None, "titleAuto": bool(d["title"] and AUTO_NAME.match(d["title"])),
            "promptTitle": d["promptTitle"], "fallback": d["fallback"], "topic": brief(d.get("you"), 70),
            "project": os.path.basename(d["cwd"].rstrip("/")) or "unknown", "branch": d["branch"][:200], "model": d["model"][:200], "updated": d["updated"],
            "tokens": d["tokens"], "ask": d["last"][:400], "last": d["last"][:160].replace("\n", " "), "kind": d["kind"], "automated": d["automated"],
            "consistency": d["consistency"], "lastTool": d["lastTool"][:200], "lastError": d["lastError"], "prOpened": d["prOpened"], "turnEnd": d["turnEnd"],
            "lastAt": d["lastAt"], "lastBy": d["lastBy"][:64], "continuedIn": d["continuedIn"], "shown": bool(d["tl"]),
            "days": {k: list(v) for k, v in d["days"].items()}}


def list_view(path, stat):
    """List view of a session: from memory, else from the summary cache file when the transcript is unchanged, else parsed."""
    return _list_view(path, stat_key(stat), stat)


def _list_view(path, key, stat=None):
    """list_view() by key; the file is stat-ed (and the key renewed) only when it must be parsed. Keeps the file's index entry current."""
    hit = _views.get(path)
    if hit and hit[0] == key:
        v = hit[1]
    else:
        v = summaries.get(path, key)
        if v is None:
            if stat is None:
                stat = os.stat(path)
                key = stat_key(stat)
            v = view(_parse(path, stat))
            summaries.put(path, key, v)
        _views.pop(path, None)
        _views[path] = (key, v)
        while len(_views) > CACHE_MAX:
            _views.pop(next(iter(_views)))
    entry = (key, v["automated"], v["shown"], v["continuedIn"])
    if summaries.index().get(path) != entry:
        summaries.index_put(path, entry)
        if path in _order["keys"] and _order["ix"] is summaries.index():
            _place(path, key)
    return v


def waiting_since(d, lv):
    """Epoch ms the session last stopped working: its newest reply, or the live status time when newer and not busy; 0 when unknown."""
    status, at = lv[0], lv[1]
    return max(d["turnEnd"], int(at) if status not in ("busy", "done") else 0)


OUT_LINES = 400  # lines kept of a command output the CLI shows in full


ERROR_LINES = 10  # lines of an error result the CLI prints whole (CLI 2.1.322, screen cases 59-61)


def cut(text, keep=4):
    """First `keep` lines of an output, each at most 200 characters, then a count of the rest."""
    lines = text.strip().split("\n")
    return "\n".join(x[:200] for x in lines[:keep]) + (f"\n… +{len(lines) - keep} lines" if len(lines) > keep else "")


def cut_error(text):
    """An error result as the CLI prints it: up to ERROR_LINES lines whole, else those lines and "… +N line(s)"."""
    lines = text.strip().split("\n")
    more = len(lines) - ERROR_LINES
    return "\n".join(x[:200] for x in lines[:ERROR_LINES]) + (f"\n… +{more} line{'s' if more != 1 else ''}" if more > 0 else "")


def cut_out(text, full):
    """Command output as the CLI shows it: in full for the newest ! output and local commands, else 3 lines and a count when longer than 4."""
    lines = text.strip().split("\n")
    keep = OUT_LINES if full else 4 if len(lines) <= 4 else 3
    return "\n".join(lines[:keep])[:20000] + (f"\n… +{len(lines) - keep} lines" if len(lines) > keep else "")


def transcript(path):
    """Whole conversation as the CLI shows it on resume: prompts, replies, tool calls with a short result, markers and command output; cached."""
    key = stat_key(os.stat(path))
    hit = _full.get(path)
    if hit and hit[0] == key:
        _full[path] = _full.pop(path)  # mark as recently used
        return _ended(path, hit[1], hit[3])
    for again in (False, True):
        try:
            events, files, open_end = _events(path)
            break
        except tx.Stale:
            if again:
                raise
            tx.discard(path)
            _folds.pop((path, "side"), None)
    size = sum(len(x) for e in events for x in e if isinstance(x, str)) + sum(len(f) for f in files)
    _full.pop(path, None)
    _full[path] = (key, (events, files), size, open_end)
    while len(_full) > 1 and (len(_full) > FULL_MAX or sum(v[2] for v in _full.values()) > FULL_CHARS):
        _full.pop(next(iter(_full)))
    return _ended(path, (events, files), open_end)


def _ended(path, got, open_end):
    """Sidebar events with the CLI's Interrupted line after a call left without a result at the end, unless a live program still runs it."""
    if not open_end:
        return got
    sid = tx.session_id(path)
    if sid in holders() or terms.term_alive(sid) or terms.reply_state(sid) == "running":
        return got
    return got[0] + [["interrupt"]], got[1]


class _SideFold:
    """The sidebar events of a conversation with what folding more rows needs: the rows, other programs' marks, call places, edited files."""
    __slots__ = ("conv", "marks", "events", "by_id", "files", "open_call")


def _side_tail(path, conv, marks):
    """(kept fold, rows added at the end) when an append only added rows that fold on their own, else (None, None)."""
    old = _fold_get(path, "side")
    n = len(old.conv) if old else 0
    if old is None or len(conv) < n or conv[:n] != old.conv:
        return None, None
    new = conv[n:]
    ids = {r.uuid for r in new}
    if any(old.marks.get(u) != marks.get(u) for u in set(old.marks) | set(marks) if u not in ids):
        return None, None  # another program's branch now leaves an earlier row
    if any(r.boundary or r.compact for r in new) or any(x[0] == "out" and x[1] == "bash" for x in tx.brief_view(new)):
        return None, None  # a compaction line or a newer ! output changes how earlier events print
    return old, new


def _events(path):
    """Sidebar events of a transcript, folding each row's items as its body is read again (only the events stay in memory); an append folds only its rows."""
    events, by_id, files, open_call = [], {}, {}, None  # open_call: place of the newest call while no result answered it
    fold = None
    if tx.SLIM:
        t = tx.load(path)
        conv = tx.conversation(t)
        marks = tx.elsewhere(t, conv)
        old, new = _side_tail(path, conv, marks)
        if old is not None:
            events, by_id, files, newest, open_call = list(old.events), dict(old.by_id), dict(old.files), -1, old.open_call
            items = tx.iter_view(new, marks)
        else:
            newest = max((i for i, x in enumerate(tx.brief_view(conv, marks)) if x[0] == "out" and x[1] == "bash"), default=-1)
            items = tx.iter_view(conv, marks)
        fold = _SideFold()
        fold.conv, fold.marks = conv, marks
    else:
        items = _read(path)[1]
        newest = max((i for i, x in enumerate(items) if x[0] == "out" and x[3] == "bash"), default=-1)
    for n, item in enumerate(items):
        if item[0] in ("you", "claude"):
            events.append([item[0], item[1][:20000]])
        elif item[0] == "tool":
            _, tid, name, inp = item
            f = tx.edited_file(name, inp)
            if f:
                files[f] = files.get(f, 0) + 1
            by_id[tid] = open_call = len(events)
            events.append(["tool", name, tx.tool_hint(inp)[:300], "", 0, tx.tool_display(name, inp)[:300], 0])
        elif item[0] == "result" and item[1] in by_id:
            i = by_id[item[1]]
            ev = events[i] = list(events[i])  # kept events are shared with earlier answers: change a copy
            text, quiet = tx.screen_result(ev[1], item[2], item[3], item[4], item[5])
            ev[3], ev[4], ev[6] = (cut_error(text) if item[3] else cut(text) if quiet else text[:20000]), 1 if item[3] else 0, quiet
            if i == open_call:
                open_call = None
        elif item[0] == "out":
            events.append(["out", cut_out(item[1], item[3] == "local" or n == newest), 1 if item[2] else 0])
        elif item[0] in ("compact", "interrupt", "image"):
            events.append(list(item))
        elif item[0] == "elsewhere":
            events.append(["elsewhere", item[1], item[2]])
    if fold is not None:
        fold.events, fold.by_id, fold.files, fold.open_call = events, by_id, files, open_call
        _fold_put(path, "side", fold)
        events, files = list(events), dict(files)
    return events, files, open_call is not None and open_call == len(events) - 1


def brief(text, n):
    """First line of a prompt, cut at a word boundary."""
    line = re.sub(r"\s+", " ", (text or "").strip().split("\n")[0]).strip(" #*`>-")
    return line if len(line) <= n else line[:n].rsplit(" ", 1)[0] + "…"


def forget(paths=()):
    """Drop cached summaries, views, sidebar transcripts and parse states of transcripts that are gone (paths: the current ones, when known)."""
    keep = set(paths) if paths else {p for p in set(_views) | set(_cache) | set(_full) if os.path.exists(p)}
    for store in (_cache, _views, _full):
        for p in [p for p in store if p not in keep]:
            store.pop(p, None)
    for k in [k for k in _folds if k[0] not in keep]:
        _folds.pop(k, None)
    tx.forget(keep)


def mission(d, name):
    """Title as the CLI's resume picker names the session (own title, automatic title, else its prompt); a placeholder name gives way to the prompt."""
    t = tx.no_tags(d["title"] or name or "")
    auto = not t or ((d["titleAuto"] if "titleAuto" in d else bool(AUTO_NAME.match(t))) if d["title"] else bool(AUTO_NAME.match(t)))
    if not auto:
        return t[:80]
    prompt = d["promptTitle"] if "promptTitle" in d else title_text(d.get("first"), TITLE_LEN)
    return prompt or t or d.get("fallback") or "Untitled"


def helpers(path):
    """Short descriptions of a session's subagents that are still running, most recently active first."""
    now = time.time()
    return [label for _, label in sorted((now - at, label) for label, done, at in tx.subagents(path) if not done and now - at < 1800)]


def _unplace(path):
    """Take a transcript out of the sorted lists."""
    at = _order["at"].pop(path, None)
    if at is not None:
        lst = _order["lists"][at[0]] if at[0] is not None else _order["unknown"]
        i = bisect.bisect_left(lst, at[1])
        if i < len(lst) and lst[i] == at[1]:
            del lst[i]


def _place(path, key):
    """Put a transcript with this key where its index entry says: its class list when shown, nowhere when it has nothing to show, else unknown."""
    _unplace(path)
    _order["keys"][path] = key
    e = summaries.index().get(path)
    tok = (-key[0], path)
    if e is not None and e[0] == key:
        if not e[2]:
            return
        where = e[1]
        bisect.insort(_order["lists"][where], tok)
    else:
        where = None
        bisect.insort(_order["unknown"], tok)
    _order["at"][path] = (where, tok)


def _drop(path):
    """Forget a transcript that is gone."""
    _unplace(path)
    _order["keys"].pop(path, None)
    same = _order["ids"].get(tx.session_id(path))
    if same is not None:
        same.discard(path)
        if not same:
            del _order["ids"][tx.session_id(path)]


def _add(path, key):
    """Place a new or changed transcript and remember it under its session id."""
    _place(path, key)
    _order["ids"].setdefault(tx.session_id(path), set()).add(path)


def _fresh():
    """True when the kept order belongs to this data folder and this index; else it is emptied."""
    ix = summaries.index()
    if _order["home"] == config.HOME and _order["ix"] is ix:
        return True
    _order.update(home=config.HOME, ix=ix, keys={}, at={}, ids={}, lists={False: [], True: []}, unknown=[])
    return False


def _found(keys=None):
    """{path: key} of every listable transcript: from a glob and a stat of each, or from the caller's map {path: (mtime_ns, size, inode, ctime_ns)} taken as is."""
    out, known = {}, _order["keys"]
    sid, ok = tx.session_id, tx.SID.fullmatch
    if keys is not None:
        for p, k in keys.items():
            if known.get(p) == k:
                out[p] = known[p]  # unchanged and already known listable: no id check, no stat
            elif ok(sid(p)):
                try:
                    out[p] = tuple(k) if len(k) == 4 else stat_key(os.stat(p))
                except OSError:
                    pass
        return out
    for p in tx.session_paths():
        if not ok(sid(p)):
            continue  # the session routes accept only such ids, so a row for any other file name could not be opened
        try:
            out[p] = stat_key(os.stat(p))
        except OSError:
            continue
    return out


def _sync(found):
    """Bring the kept order to these {path: key}: gone files leave, changed and new ones are placed again."""
    keys = _order["keys"]
    for p in [p for p in keys if p not in found]:
        _drop(p)
    for p, k in found.items():
        if keys.get(p) != k:
            _add(p, k)


def _restat(named, active):
    """Refresh only the named sessions' transcripts (found again) and the active ones' known transcripts in the kept order."""
    for i in named | active:
        paths = set(_order["ids"].get(i, ()))
        if i in named:
            q = tx.find(i)
            if q is not None and tx.SID.fullmatch(tx.session_id(q)):
                paths.add(q)
        for p in paths:
            try:
                k = stat_key(os.stat(p))
            except OSError:
                _drop(p)
                continue
            if _order["keys"].get(p) != k:
                _add(p, k)


def _pick(keep):
    """Paths the list shows, in list order: active sessions first, then the newest RECENT typed and RECENT_AUTO automated finished ones that show something."""
    keys, sid = _order["keys"], tx.session_id
    mine = sorted((-keys[p][0], p) for i in keep for p in _order["ids"].get(i, ()))
    room, pos, lists, unknown = {False: RECENT, True: RECENT_AUTO}, {False: 0, True: 0}, _order["lists"], _order["unknown"]
    picked, upos = [], 0
    while room[False] or room[True]:
        heads = [(lists[c][pos[c]], c) for c in (False, True) if room[c] and pos[c] < len(lists[c])]
        head = min(heads) if heads else None
        u = unknown[upos] if upos < len(unknown) else None
        if u is not None and (head is None or u < head[0]):
            p = u[1]
            if sid(p) in keep:
                upos += 1
                continue
            try:
                _list_view(p, keys[p])  # its entry now places it in a class list (or nowhere)
            except OSError:
                _drop(p)
                continue
            if upos < len(unknown) and unknown[upos] == u:
                upos += 1  # still unknown: leave it for the next pass
            continue
        if head is None:
            break
        tok, c = head
        pos[c] += 1
        p = tok[1]
        if sid(p) in keep:
            continue
        e = summaries.index()[p]
        if e[3] and tx.find(e[3]):
            continue  # the CLI continued it under a new id (its /resume list hides it too)
        room[c] -= 1
        picked.append(tok)
    return [t[1] for t in mine], [t[1] for t in sorted(picked)]


def _row(p, d, lv, hold, today):
    """One list row from a session's list view and its live state."""
    sid = tx.session_id(p)
    status, status_at, name = lv.get(sid, ("done", 0, None))
    rs, me = terms.reply_state(sid), terms._replies.get(sid, {})
    day = d["days"].get(today, (0, 0))
    return {
        "id": sid,
        "title": mission(d, name),
        "topic": d["topic"],
        "project": d["project"],
        "branch": d["branch"],
        "status": "running" if rs == "running" or status == "busy" else "waiting" if rs == "answered" or status != "done" else "done",
        "statusAt": max(status_at, me.get("done_at", 0)),
        "replyError": me.get("error", ""),
        "replyExit": me.get("code") or 0,
        "term": terms.term_alive(sid),
        "also": elsewhere(sid, hold),
        "copies": len(hold.get(sid, [])),
        "subs": helpers(p) if sid in hold else [],
        "behind": behind(sid, d, hold),
        "model": d["model"],
        "updated": d["updated"],
        "tokens": d["tokens"],
        "ask": d["ask"],
        "last": d["last"],
        "kind": d["kind"],
        "automated": d["automated"],
        "consistency": d["consistency"],
        "lastTool": d["lastTool"],
        "lastError": d["lastError"],
        "prOpened": d["prOpened"],
        "waitingSince": waiting_since(d, (status, status_at)),
        "tokensToday": day[0],
        "prsToday": day[1],
    }


def sessions(keys=None, hold=None):
    """Summaries: every live session, the newest finished ones a person typed into (RECENT) and the newest automated ones (RECENT_AUTO).
    keys: optional {path: stat_key} of every transcript the change feed knows (used as the files' state, no glob or stat); hold: optional holders() map."""
    return _sessions(keys, hold, None)


def _sessions(keys, hold, only):
    """sessions(); with `only` (a set of ids) just the rows of those ids and of active sessions are built, the rest of the order comes from the kept index."""
    hold = holders() if hold is None else hold
    lv = live(hold)
    summaries.attach()
    keep = set(lv) | set(terms._replies) | set(terms._terms)
    if only is None or not _fresh():
        _fresh()
        found = _found(keys)
        _sync(found)
        forget(found)
        summaries.index_keep(found)
    else:
        _restat(only, keep)
    mine, rest = _pick(keep)
    today, out = day_of(CLOCK()), []
    keys = _order["keys"]
    for p in mine + rest:
        sid = tx.session_id(p)
        if only is not None and sid not in only and sid not in keep:
            out.append({"id": sid, "status": "done", "title": None, "topic": None})  # a place in the order only; never sent
            continue
        try:
            d = _list_view(p, keys[p])
        except OSError:
            continue
        if not d["shown"]:
            continue
        out.append(_row(p, d, lv, hold, today))
    # Active sessions that share a title get their latest request appended, so each one reads differently.
    shared = {}
    for o in out:
        if o["status"] != "done":
            shared.setdefault(o["title"], []).append(o)
    for same in shared.values():
        for o in same if len(same) > 1 else []:
            tail = brief(tx.no_tags(o["topic"]), 30)
            o["title"] = (o["title"][:40] + " · " + tail)[:80] if tail and tail not in o["title"] else o["title"]
    # Still identical (same first and latest request): number them, oldest first.
    seen = {}
    for o in sorted((o for o in out if o["status"] != "done"), key=lambda o: o["id"]):
        n = seen[o["title"]] = seen.get(o["title"], 0) + 1
        if n > 1:
            o["title"] = o["title"][:74] + f" #{n}"
    return out


PARTIAL_MAX = 100  # ids one partial answer takes; the change feed sends all=true above this


def sessions_for(ids, keys=None, hold=None, settled=False):
    """Partial list answer: rows of the named ids and of every active session (shared titles move together), ids that left, the full order and the day.
    settled: the caller vouches that since the previous list call only the named sessions changed, so only they and the active ones are looked at."""
    want = {i for i in ids if isinstance(i, str) and tx.SID.fullmatch(i)} if ids is not None else set()
    out = _sessions(None, hold, want) if settled else sessions(keys, hold)
    order = [o["id"] for o in out]
    rows = [o for o in out if o["id"] in want or o["status"] != "done"]
    return {"rows": rows, "gone": sorted(want - set(order)), "order": order, "today": day_of(CLOCK())}


def apply_partial(old, part, day=None):
    """The full list a page holds after patching its previous full list (fetched on day) with a partial answer, or None when it must fetch the full list."""
    if day is not None and day != part["today"]:
        return None  # today's figures rolled over without a file change
    have = {o["id"]: o for o in old}
    for o in part["rows"]:
        have[o["id"]] = o
    for i in part["gone"]:
        have.pop(i, None)
    if any(i not in have for i in part["order"]):
        return None  # a session entered the list without being named: fetch everything
    return [have[i] for i in part["order"]]
