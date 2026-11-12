"""The only module that knows the transcript, live-process registry and subagent file formats; reads are defensive and self-checked."""
import glob
import json
import os
import re
import sys
import threading
import time
import weakref
from collections import Counter
from itertools import islice
from types import SimpleNamespace
from datetime import datetime

from . import config

EDITS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}
RUN_TOOL = "Bash"
AGENT_TOOLS = ("Agent", "Task")
SID = re.compile(r"[0-9a-fA-F-]{8,64}")
INTERRUPT = "[Request interrupted"
USAGE_KEYS = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
# Fields every record of a kind carries today, with their JSON types; an absent or retyped one means the format moved.
EXPECT = {
    "user": (("uuid", str), ("timestamp", str), ("isSidechain", bool), ("cwd", str), ("entrypoint", str), ("message", dict), ("message.content", (str, list))),
    "assistant": (("uuid", str), ("timestamp", str), ("isSidechain", bool), ("entrypoint", str), ("message", dict), ("message.content", (str, list)),
                  ("message.id", str), ("message.model", str), ("message.usage", dict)),
    "custom-title": (("customTitle", str),),
}
RECENT_DAYS = 14  # a field absent only from records older than this is a note, not a warning
REGISTRY_EXPECT = (("pid", int), ("sessionId", str), ("status", str), ("statusUpdatedAt", (int, float)))
_lock = threading.Lock()
_checks = {}  # path -> counters from the latest read of that file, non-zero ones only
_registry = {"files": 0, "bad": 0, "missing": Counter(), "odd": Counter()}
_found = {}  # (data folder, session id) -> transcript path last found, checked to still exist before use
FOUND_MAX = 4096  # paths kept by find()
UNKNOWN_NAMES = 32  # distinct unknown record type names counted per file; more are counted under one name


def _s(v):
    """The value when it is a string, else an empty string."""
    return v if isinstance(v, str) else ""


def _n(v):
    """The value when it is a number, else 0."""
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def epoch(ts):
    """ISO timestamp to epoch seconds, or None."""
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# ---------- where things live ----------
def _home():
    """Data folder, escaped for glob patterns."""
    return glob.escape(config.HOME)


def session_paths():
    """Every main transcript: projects/<encoded-cwd>/<sessionId>.jsonl."""
    return glob.glob(os.path.join(_home(), "projects", "*", "*.jsonl"))


def all_paths():
    """Main transcripts plus the transcripts of their subagents."""
    return session_paths() + glob.glob(os.path.join(_home(), "projects", "*", "*", "subagents", "**", "*.jsonl"), recursive=True)


def find(sid):
    """Transcript path of a session id, or None; ids are checked so they cannot widen the search."""
    if not isinstance(sid, str) or not SID.fullmatch(sid):
        return None
    key = (config.HOME, sid)
    hit = _found.get(key)
    if hit and os.path.isfile(hit):
        return hit
    hits = glob.glob(os.path.join(_home(), "projects", "*", sid + ".jsonl"))
    with _lock:
        _found.pop(key, None)
        if hits:
            _found[key] = hits[0]
        while len(_found) > FOUND_MAX:
            _found.pop(next(iter(_found)))
    return hits[0] if hits else None


def forget(paths):
    """Drop remembered paths and parse states of transcripts that are no longer among these main transcript paths."""
    paths = set(paths)
    with _lock:
        for k in [k for k, v in _found.items() if k[0] == config.HOME and v not in paths]:
            del _found[k]
        for p in [p for p in _states if p not in paths]:
            del _states[p]


def discard(path):
    """Drop the kept parse state of one transcript, so the next load() reads it whole."""
    with _lock:
        _states.pop(path, None)


def session_id(path):
    """Session id of a main transcript path."""
    return os.path.basename(path)[:-6]


def is_subagent(path):
    """True for a subagent's transcript."""
    return os.sep + "subagents" + os.sep in path


def subagents(path):
    """Subagents of a session as (label, finished, seconds since their transcript last changed)."""
    out = []
    for meta in glob.glob(glob.escape(path[:-6]) + "/subagents/**/*.meta.json", recursive=True):
        try:
            with open(meta) as fh:
                m = json.load(fh)
            age = os.path.getmtime(meta[:-10] + ".jsonl")
        except (OSError, ValueError):
            continue
        if isinstance(m, dict):
            out.append((str(m.get("description") or m.get("agentType") or "subagent")[:60], bool(m.get("finished")), age))
    return out


# ---------- transcript records ----------
class Record:
    """One transcript line; every field is read through a named accessor. A slim row (at set) keeps no body: parts() and body() read it again by offset."""
    __slots__ = ("raw", "msg", "at", "fx")

    def __init__(self, raw, at=None, fx=None):
        self.raw, self.at, self.fx = raw, at, fx
        m = raw.get("message")
        self.msg = m if isinstance(m, dict) else {}

    def full(self):
        """This row with its whole body (read again from the file for a slim row; raises Stale when the file no longer holds it)."""
        if self.at is None:
            return self
        rd = _Reader()
        try:
            return rd.full(self)
        finally:
            rd.close()

    def body(self):
        """The row's whole JSON object."""
        return self.full().raw

    kind = property(lambda s: s.raw.get("type"))
    uuid = property(lambda s: _s(s.raw.get("uuid")) or None)
    parent = property(lambda s: _s(s.raw.get("parentUuid")) or None)
    sidechain = property(lambda s: bool(s.raw.get("isSidechain")))
    session = property(lambda s: _s(s.raw.get("sessionId")))
    cwd = property(lambda s: _s(s.raw.get("cwd")))
    branch = property(lambda s: _s(s.raw.get("gitBranch")))
    entry = property(lambda s: _s(s.raw.get("entrypoint")))
    timestamp = property(lambda s: _s(s.raw.get("timestamp")))
    epoch = property(lambda s: epoch(s.raw.get("timestamp")))
    meta = property(lambda s: bool(s.raw.get("isMeta")))
    compact = property(lambda s: bool(s.raw.get("isCompactSummary")))
    title = property(lambda s: _s(s.raw.get("customTitle")) or None)
    ai_title = property(lambda s: _s(s.raw.get("aiTitle")) or None)
    msg_id = property(lambda s: _s(s.msg.get("id")) or None)
    boundary = property(lambda s: s.raw.get("type") == "system" and s.raw.get("subtype") == "compact_boundary")
    stopped = property(lambda s: isinstance(s.msg.get("stop_reason"), str) and not s.raw.get("isApiErrorMessage"))
    continued_in = property(lambda s: _s(s.raw.get("continuedInSessionId")) or None)
    turn_origin = property(lambda s: _s(s.raw.get("turnOrigin")) or "none")

    @property
    def human(self):
        """True when a person typed this record (no origin, or origin kind human)."""
        o = self.raw.get("origin")
        return (o.get("kind") if isinstance(o, dict) else None) in (None, "human")

    @property
    def model(self):
        """Model name, empty for a placeholder such as <synthetic>."""
        m = _s(self.msg.get("model"))
        return "" if m.startswith("<") else m

    @property
    def moves_leaf(self):
        """True for a row that counts as the newest written row: main session, not a file snapshot or fork briefing."""
        a = self.raw.get("attachment")
        return not (self.sidechain or (self.kind == "system" and self.raw.get("subtype") == "file_snapshot")
                    or (self.kind == "attachment" and isinstance(a, dict) and a.get("type") == "fork_briefing"))

    def leaf(self):
        """A last-prompt checkpoint as (has leafUuid key, leafUuid or None, explicit)."""
        v = self.raw.get("leafUuid")
        return "leafUuid" in self.raw, _s(v) or None, self.raw.get("explicit") is True

    def preserved(self):
        """Messages a compaction kept: (anchor uuid, [uuids]) from the list, ('segment', head, tail, anchor), or None."""
        m = self.raw.get("compactMetadata")
        if not isinstance(m, dict) or not (m.get("preservedMessages") or m.get("preservedSegment")):
            return None
        pm = m.get("preservedMessages")
        if pm:
            ids = pm.get("uuids") if isinstance(pm, dict) else None
            return (_s(pm.get("anchorUuid")) if isinstance(pm, dict) else "", [u for u in ids if isinstance(u, str)] if isinstance(ids, list) else [])
        seg = m.get("preservedSegment") if isinstance(m.get("preservedSegment"), dict) else {}
        return ("segment", _s(seg.get("headUuid")), _s(seg.get("tailUuid")), _s(seg.get("anchorUuid")))

    def queued(self):
        """A prompt typed while the session worked, stored as an attachment: its text parts, or None when it is not a person's prompt."""
        if self.at is not None:
            return self.full().queued()
        a = self.raw.get("attachment")
        if self.kind != "attachment" or not isinstance(a, dict) or a.get("type") != "queued_command" or a.get("isMeta"):
            return None
        o = a.get("origin")
        if a.get("commandMode", "prompt") != "prompt" or (o.get("kind") if isinstance(o, dict) else None) not in (None, "human"):
            return None
        p = a.get("prompt")
        return [p] if isinstance(p, str) else [_s(b.get("text")) for b in p if isinstance(b, dict) and b.get("type") == "text"] if isinstance(p, list) else []

    def usage(self):
        """Token counts of an assistant message as a dict of USAGE_KEYS, or None."""
        u = self.msg.get("usage")
        if isinstance(u, tuple):
            return dict(zip(USAGE_KEYS, u))
        return {k: _n(u.get(k)) for k in USAGE_KEYS} if isinstance(u, dict) else None

    def has(self, block):
        """True when the content holds a block of this type (tool_use, tool_result, image)."""
        c = self.msg.get("content")
        return isinstance(c, (list, tuple)) and any(isinstance(b, dict) and b.get("type") == block for b in c)

    def ids(self, block):
        """Ids of the tool calls (block tool_use) or of the calls answered (tool_result) in the content, as parts() gives them; works on a slim row."""
        c, key = self.msg.get("content"), "id" if block == "tool_use" else "tool_use_id"
        return [_s(b.get(key)) or None for b in c if isinstance(b, dict) and b.get("type") == block] if isinstance(c, (list, tuple)) else []

    def parts(self):
        """Content in order: ('text', s), ('tool', id, name, input), ('result', toolId, text, isError), ('image',)."""
        if self.at is not None:
            return self.full().parts()
        c = self.msg.get("content")
        if isinstance(c, str):
            return [("text", c)]
        out = []
        for b in c if isinstance(c, list) else []:
            t = b.get("type") if isinstance(b, dict) else None
            if t == "text":
                out.append(("text", _s(b.get("text"))))
            elif t == "tool_use":
                inp = b.get("input")
                out.append(("tool", _s(b.get("id")) or None, _s(b.get("name")) or "Tool", inp if isinstance(inp, dict) else {}))
            elif t == "tool_result":
                out.append(("result", _s(b.get("tool_use_id")) or None, _result_text(b.get("content")), bool(b.get("is_error"))))
            elif t == "image":
                out.append(("image",))
        return out


def _result_text(c):
    """Text of a tool result, which is a string or a list of text blocks."""
    if isinstance(c, str):
        return c
    return "\n".join(_s(x.get("text")) for x in c if isinstance(x, dict) and x.get("type") == "text") if isinstance(c, list) else ""


_EXPECT = {k: [(f, f.split("."), t) for f, t in v] for k, v in EXPECT.items()}


# ---------- slim rows: what the rules need, the body left in the file ----------
SLIM = True  # keep rows without bodies (tests set False to run the whole-row path as the oracle)
ROW_BYTES = 1500  # memory a kept slim row may take, measured with tracemalloc (tests/test_slim.py)
BRIEF_TEXT = 200  # characters of each prompt and reply a slim row keeps for the list (the timeline's TL_TEXT)
_KEEP = ("type", "uuid", "parentUuid", "isSidechain", "sessionId", "cwd", "gitBranch", "entrypoint", "timestamp", "isMeta", "isCompactSummary", "subtype",
         "isApiErrorMessage", "isVisibleInTranscriptOnly", "turnOrigin")  # top-level fields the rules read
_SHARE = frozenset(("type", "sessionId", "cwd", "gitBranch", "entrypoint", "subtype", "turnOrigin"))  # values repeated on every row: one copy
_FLAGS = frozenset(("isSidechain", "isMeta", "isCompactSummary", "isApiErrorMessage", "isVisibleInTranscriptOnly"))  # fields read only for truth
_NOFX = ((), None)  # facts of a row that shows nothing and has no pull-request part, shared
_TYPE_ONLY = {}  # shared skeleton blocks that carry only their type, by type (bounded by the few block types)


class Stale(OSError):
    """A slim row could not be read again at its offset: the file was cut, replaced or rewritten since it was indexed."""


def _trim(r):
    """Drop toolUseResult fields screen_result() never reads (file copies, original files)."""
    tur = r.get("toolUseResult")
    if isinstance(tur, dict) and not RESULT_KEYS.issuperset(tur):
        r["toolUseResult"] = {x: v for x, v in tur.items() if x in RESULT_KEYS}


class _Reader:
    """One open handle that reads slim rows' bodies again, checking the file is the one indexed and each line is whole and the same row."""
    __slots__ = ("fh", "src")

    def __init__(self):
        self.fh = self.src = None

    def full(self, rec):
        """The row with its body; raises Stale when the bytes at its offset are not that whole row any more."""
        if rec.at is None:
            return rec
        src, pos = rec.at
        off, n = pos >> 32, pos & 0xFFFFFFFF
        if self.src is not src:
            self.close()
            self.fh, self.src = open(src[0], "rb"), src
            if os.fstat(self.fh.fileno()).st_ino != src[1] or self.fh.read(len(src[2])) != src[2]:
                raise Stale(src[0])
        self.fh.seek(off)
        b = self.fh.read(n)
        if len(b) != n or not b.endswith(b"\n"):
            raise Stale(src[0])
        try:
            r = json.loads(b.decode("utf-8", "replace"))
        except ValueError:
            raise Stale(src[0]) from None
        if not isinstance(r, dict) or r.get("uuid") != rec.raw.get("uuid") or r.get("type") != rec.raw.get("type"):
            raise Stale(src[0])
        _trim(r)
        return Record(r, None, rec.fx)

    def close(self):
        """Close the handle."""
        if self.fh is not None:
            self.fh.close()
        self.fh = self.src = None


def _skeleton(c):
    """Content without text: block types plus the tool-call ids the rules match on."""
    if isinstance(c, str):
        return ""
    if not isinstance(c, list):
        return c if c is None else None
    out = []
    for b in c:
        if not isinstance(b, dict):
            out.append(None)
            continue
        t = b.get("type")
        if t == "tool_use":
            out.append({"type": t, "id": b.get("id")})
        elif t == "tool_result":
            out.append({"type": t, "tool_use_id": b.get("tool_use_id")})
        elif isinstance(t, str) and t in ("text", "thinking", "image", "redacted_thinking"):
            out.append(_TYPE_ONLY.setdefault(t, {"type": t}))
        else:
            out.append({"type": t})
    return tuple(out)


def _brief(rec):
    """What a row shows, cut for the list: (you|claude, text), (tool, id, name, hint, edited file), (result, id, isError), (kind,) for the rest."""
    out = []
    for x in _shows(rec):
        if x[0] in ("you", "claude"):
            out.append((x[0], x[1][:BRIEF_TEXT]))
        elif x[0] == "tool":
            out.append(("tool", x[1], x[2], tool_hint(x[3])[:120], edited_file(x[2], x[3])))
        elif x[0] == "result":
            out.append(("result", x[1], x[3]))
        elif x[0] == "out":
            out.append(("out", x[3]))
        else:
            out.append((x[0],))
    return tuple(out)


def _prf(rec):
    """The row's part in the pull-request rule: (epoch, ((call id, pr|mcppr|''), ...)) for calls, (epoch, ((call id, not counted, link key), ...)) for results."""
    e = rec.epoch
    if e is None:
        return None
    if rec.kind == "assistant" and rec.has("tool_use"):
        return e, tuple((p[1], "pr" if PR_CMD.search(shell_command(p[2], p[3])) else "mcppr" if opens_pr_tool(p[2]) else "") for p in rec.parts() if p[0] == "tool" and p[1])
    if rec.kind == "user" and rec.has("tool_result"):
        out = []
        for p in rec.parts():
            if p[0] == "result":
                urls = PR_URL.findall(p[2])
                out.append((p[1], bool(p[3] or "already exists" in p[2]), "/".join(urls[-1]) if urls else None))
        return e, tuple(out)
    return None


def _slim(rec, src, off, n):
    """A row that keeps only what the rules read, its list facts and where its whole line sits in the file."""
    r, m = rec.raw, rec.msg
    s = {}
    for k in _KEEP:
        if k in r:
            v = r[k]
            if k in _FLAGS and not v:
                continue  # read only for truth: an absent flag reads the same
            s[k] = sys.intern(v) if k in _SHARE and type(v) is str and len(v) < 512 else v
    o = r.get("origin")
    if isinstance(o, dict) and o.get("kind") is not None:
        s["origin"] = {"kind": o["kind"]}
    a = r.get("attachment")
    if isinstance(a, dict):
        s["attachment"] = {"type": a.get("type")}
    cm = r.get("compactMetadata")
    if isinstance(cm, dict):
        s["compactMetadata"] = {k: cm[k] for k in ("preservedMessages", "preservedSegment") if k in cm}
    if m:
        sm = {}
        for k in ("id", "model", "stop_reason"):
            if k in m:
                sm[k] = sys.intern(m[k]) if k != "stop_reason" and type(m[k]) is str and len(m[k]) < 512 else m[k]  # one message spans rows: one id text
        u = m.get("usage")
        if isinstance(u, dict):
            sm["usage"] = tuple(_n(u.get(k)) for k in USAGE_KEYS)  # usage() reads the numbers back by USAGE_KEYS
        if "content" in m:
            sm["content"] = _skeleton(m["content"])
        s["message"] = sm
    fx = (_brief(rec) or (), _prf(rec))
    return Record(s, (src, (off << 32) | n) if n < 1 << 32 else None, _NOFX if fx == _NOFX else fx)


def brief_view(conv, marks=None):
    """view() for the list, from the rows' kept facts (no body read): see _brief; ('elsewhere', program, count) after a row named in marks."""
    out = []
    for rec in conv:
        for i, x in enumerate(_facts(rec)[0]):
            out.append(x + (rec, i) if x[0] in ("you", "claude") else x)
        if marks and rec.uuid in marks:
            out.append(("elsewhere",) + tuple(marks[rec.uuid]))
    return out


def brief_text(item):
    """Whole text of a brief_view() prompt or reply item (its row read again when slim)."""
    return _shows(item[2].full())[item[3]][1]


def _facts(rec):
    """(brief shows, pull-request part) of a row: kept on rows read by load(), else worked out."""
    return rec.fx if rec.fx is not None else (_brief(rec), _prf(rec))


def _expect(r, kind, chk):
    """Count expected fields a record lacks or carries with another type, apart for records older than RECENT_DAYS."""
    old = None
    for name, path, types in _EXPECT.get(kind, ()):
        cur, issue = r, None
        for part in path:
            if not isinstance(cur, dict) or part not in cur:
                issue = "missing"
                break
            cur = cur[part]
        else:
            if not isinstance(cur, types) or (types is int and isinstance(cur, bool)):
                issue = "odd"
        if issue:
            if old is None:
                t = epoch(r.get("timestamp")) if isinstance(r.get("timestamp"), str) else None
                old = (t if t is not None else chk["mtime"]) < chk["cutoff"]  # no timestamp: judge by the file's age
            chk[("old_" if old else "") + issue][name] += 1


def records(path, kinds=("user", "assistant"), results_for=None):
    """Yield Records of the given kinds (None: any record with a uuid), skipping tool-result lines that name none of results_for; bad lines are counted."""
    chk = {"size": 0, "mtime": 0.0, "cutoff": time.time() - RECENT_DAYS * 86400, "lines": 0, "bad": 0, "unreadable": 0, "records": Counter(),
           "missing": Counter(), "odd": Counter(), "old_missing": Counter(), "old_odd": Counter()}
    marks = [f'"type":"{k}"' for k in kinds] if kinds else None
    spaced = [f'"type": "{k}"' for k in kinds] if kinds else None  # the same JSON written with spaces
    try:
        st = os.stat(path)
        chk["size"], chk["mtime"] = st.st_size, st.st_mtime
        with open(path, errors="replace") as fh:
            for line in fh:
                if marks is None:
                    if '"uuid"' not in line:
                        continue
                else:
                    for m in marks:
                        if m in line:
                            break
                    else:
                        if '"type": "' not in line or not any(m in line for m in spaced):
                            continue
                if results_for is not None and '"tool_result"' in line and ('"type":"user"' in line or '"type": "user"' in line) and not any(i in line for i in results_for):
                    continue
                chk["lines"] += 1
                try:
                    r = json.loads(line)
                except ValueError:
                    chk["bad"] += line.endswith("\n")  # a last line still being written is not an error
                    continue
                if not isinstance(r, dict):
                    chk["bad"] += 1
                    continue
                kind = r.get("type")
                if kinds and kind not in kinds:
                    continue
                chk["records"][kind] += 1
                _expect(r, kind, chk)
                yield Record(r)
    except OSError:
        chk["unreadable"] = 1
    finally:
        with _lock:
            _checks[path] = _kept_check(chk)


# ---------- the conversation `claude --resume` loads ----------
ROWS = ("user", "assistant", "system", "attachment")  # tree rows: uuid + parentUuid
LOADED = ROWS + ("progress", "last-prompt", "custom-title", "ai-title", "continued-in")
BRIDGE_MS = 5000  # a row whose parent is missing joins the newest earlier row at most this much older
FIRST_SKIP = re.compile(r"^\s*(<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])")


KNOWN = frozenset(LOADED + (
    "summary", "queue-operation", "mode", "permission-mode", "agent-name", "file-history-snapshot", "file-history-delta", "cost-state", "bridge-session",
    "api-request", "api-request-shape", "api-request-blob", "frame-link", "isolation-latch", "atis-latch", "tools-used", "pr-link", "relocated",
    "session-owner", "artifact-comment-monitor", "artifact-autoreact-ledger"))  # record types seen in CLI files; others are counted as unknown
_LOADED_B = frozenset(k.encode() for k in LOADED)
_KNOWN_B = frozenset(k.encode() for k in KNOWN)
INTERACTIVE = ("cli", "claude-desktop")  # entrypoints of programs a person types into
HEADLESS = "sdk-cli"  # entrypoint of the headless CLI (-p)
PR_CMD = re.compile(r"(?:^|[;&|\s(])gh pr create\b")  # same rule as desk/stats.py
PR_URL = re.compile(r"https://github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)")
HEAD = 4096  # leading bytes compared to notice a file that was rewritten rather than appended to
STATE_MAX = 16  # transcripts whose parse state is kept for reading only appended bytes
STATE_BYTES = 256 << 20  # source bytes the kept states other than the newest file's may cover together (slim rows: about 0.27 bytes of memory each, 70 MB)
STATE_ACTIVE = 2 * 3600  # only files written this recently keep their state (they are the ones that grow)
RESULT_KEYS = frozenset(("stdout", "stderr", "noOutputExpected", "structuredPatch", "type", "content", "filePath", "bytes", "code", "codeText", "results",
                         "durationSeconds"))  # toolUseResult fields screen_result() reads; a kept row drops the rest (file copies, original files)
ANOMALIES = ("bad JSON line", "unknown record type", "missing parent", "duplicate uuid", "timestamp going backwards", "two programs")
_states = {}  # path -> _State, least recently used first


class Transcript:
    """One transcript read once: rows by uuid in file order, parents, titles, the CLI's checkpoint state and file-order facts."""
    __slots__ = ("sid", "rows", "parent", "custom", "ai", "last", "newest", "checkpoint", "explicit", "cleared", "keyed",
                 "continued", "first", "messages", "entries", "prs", "origins", "lp", "first_cmd", "tick", "size", "dups", "box", "mk", "__weakref__")

    def __init__(self, sid):
        self.sid, self.rows, self.parent, self.messages, self.entries, self.prs, self.origins = sid, {}, {}, [], set(), set(), set()
        self.custom = self.ai = self.last = self.newest = self.checkpoint = self.continued = self.first = self.lp = self.first_cmd = None
        self.explicit = self.cleared = self.keyed = self.tick = False
        self.size = self.dups = 0
        self.box = self.mk = None


def _new_check():
    """Empty per-file counters for the format self-check."""
    return {"size": 0, "mtime": 0.0, "cutoff": time.time() - RECENT_DAYS * 86400, "lines": 0, "bad": 0, "unreadable": 0, "records": Counter(),
            "missing": Counter(), "odd": Counter(), "old_missing": Counter(), "old_odd": Counter(), "anomalies": Counter(), "unknown": Counter()}


class _State:
    """Parse state of one main transcript up to its last complete line, so a grown file is read from where it stopped."""
    __slots__ = ("t", "skip", "newest_ts", "prev_ts", "pending", "tools", "chk", "offset", "head", "ino", "reader", "src", "miss", "waiting", "recount")

    def __init__(self, sid):
        self.t, self.skip, self.newest_ts, self.prev_ts, self.pending, self.tools = Transcript(sid), {}, "", "", {}, set()
        self.t.box = _Box()
        self.chk, self.offset, self.head, self.ino, self.reader, self.src = _new_check(), 0, b"", None, None, None
        self.miss, self.waiting, self.recount = 0, {}, False  # rows whose parent is missing, by that parent; recount after a replaced row

    def view(self):
        """A state that shares this one's rows (no copy): only finish() and the read-only rules may run on it; _compact copies before relinking."""
        c, t = _State.__new__(_State), Transcript.__new__(Transcript)
        for k in Transcript.__slots__[:-1]:
            setattr(t, k, getattr(self.t, k))
        c.t, c.skip, c.newest_ts, c.prev_ts, c.pending, c.tools = t, self.skip, self.newest_ts, self.prev_ts, self.pending, self.tools
        self.reader = c.reader = weakref.ref(t)  # while this view lives, the next append copies the state instead of growing the shared rows
        c.chk = {k: (Counter(v) if isinstance(v, Counter) else v) for k, v in self.chk.items()}
        c.offset, c.head, c.ino, c.src = self.offset, self.head, self.ino, self.src
        c.miss, c.waiting, c.recount = self.miss, self.waiting, self.recount
        return c

    def copy(self):
        """A copy that can take more lines or be finished without changing this state."""
        c, t = _State.__new__(_State), Transcript.__new__(Transcript)
        for k in Transcript.__slots__[:-1]:
            setattr(t, k, getattr(self.t, k))
        t.rows, t.parent, t.messages, t.entries, t.prs, t.origins = dict(t.rows), dict(t.parent), list(t.messages), set(t.entries), set(t.prs), set(t.origins)
        c.t, c.skip, c.newest_ts, c.prev_ts, c.pending, c.tools = t, dict(self.skip), self.newest_ts, self.prev_ts, dict(self.pending), set(self.tools)
        c.chk = {k: (Counter(v) if isinstance(v, Counter) else v) for k, v in self.chk.items()}
        c.offset, c.head, c.ino, c.reader, c.src = self.offset, self.head, self.ino, None, self.src
        c.miss, c.waiting, c.recount = self.miss, dict(self.waiting), self.recount
        return c

    def finish(self):
        """The transcript, with the whole-file anomaly counts set in the check counters (missing parents counted by the append)."""
        t, a = self.t, self.chk["anomalies"]
        if self.recount:
            self.miss, self.waiting, self.recount = 0, {}, False
            for p in t.parent.values():
                if p and p not in t.rows:
                    self.miss += 1
                    self.waiting[p] = self.waiting.get(p, 0) + 1
        a["missing parent"] = self.miss
        a["two programs"] = int(len(t.entries) > 1)
        a["bad JSON line"] = self.chk["bad"]
        return t


def _wanted(line):
    """Cheap byte test before JSON parsing: 2 when any "type" value in the line is a kind load() uses, 1 when one is another known kind, else 0."""
    known = 0
    for mark in (b'"type":"', b'"type": "'):
        n, i = len(mark), line.find(mark)
        while i >= 0:
            j = line.find(b'"', i + n)
            if j < 0:
                break
            word = line[i + n:j]
            if word in _LOADED_B:
                return 2
            if word in _KNOWN_B:
                known = 1
            i = line.find(mark, j)
    return known


def _feed(st, line, complete, at=0):
    """Apply one raw line (bytes, with or without its newline, starting at byte offset at) to a parse state; see docs/data-model.md."""
    chk = st.chk
    want = _wanted(line)
    if want < 2:
        if line.strip() and not want:
            try:
                r = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                chk["bad"] += complete  # a last line still being written is not an error
                return
            if isinstance(r, dict):
                _unknown(chk, r.get("type"))
            else:
                chk["bad"] += 1
        return
    chk["lines"] += 1
    try:
        r = json.loads(line.decode("utf-8", "replace"))
    except ValueError:
        chk["bad"] += complete
        return
    if not isinstance(r, dict):
        chk["bad"] += 1
        return
    k = r.get("type")
    if k not in LOADED:
        if k not in KNOWN:
            _unknown(chk, k)
        return
    chk["records"][k] += 1
    _expect(r, k, chk)
    _trim(r)
    rec, t = Record(r), st.t
    u = rec.uuid
    if k in ("user", "assistant"):
        _pr_step(st, rec)
    if k == "progress":
        if u:
            st.skip[u] = st.skip.get(rec.parent, rec.parent)
    elif k in ROWS:
        if not u:
            return
        dup = u in t.rows
        if dup:
            chk["anomalies"]["duplicate uuid"] += 1
            t.dups += 1
            st.recount = True
        keep = _slim(rec, st.src, at, len(line)) if SLIM and complete and st.src else Record(r, None, (_brief(rec) or (), _prf(rec)) if SLIM else None)
        p = st.skip.get(rec.parent, rec.parent)
        if keep.at is not None and p in t.rows:
            p = t.rows[p].raw["uuid"]  # one copy of each uuid text: the parent's own
            if keep.raw.get("parentUuid") == p:
                keep.raw["parentUuid"] = p
        t.rows[u], t.parent[u] = keep, p
        if not st.recount:
            st.miss -= st.waiting.pop(u, 0)
            if p and p not in t.rows:
                st.miss += 1
                st.waiting[p] = st.waiting.get(p, 0) + 1
        if rec.entry:
            t.entries.add(rec.entry)
        if k == "user" and t.first is None:
            t.first, cmd, tick = first_parts(rec)
            t.first_cmd, t.tick = t.first_cmd or cmd, t.tick or tick
        if k in ("user", "assistant") and not rec.sidechain:
            t.messages.append(keep)
            if k == "user" and not rec.meta and not rec.compact and not rec.has("tool_result"):
                t.origins.add(rec.turn_origin)
            if (k == "assistant" and rec.stopped) or (k == "user" and rec.human and not rec.meta and not rec.has("tool_result")):
                t.continued = None
        if rec.moves_leaf:
            ts = rec.timestamp
            if ts and ts < st.prev_ts:
                chk["anomalies"]["timestamp going backwards"] += 1
            st.prev_ts = ts or st.prev_ts
            t.last, t.explicit, t.cleared = u, False, False
            if ts > st.newest_ts:
                t.newest, st.newest_ts = u, ts
        if rec.boundary:
            t.checkpoint, t.explicit = None, False
    elif k == "last-prompt":
        if isinstance(r.get("lastPrompt"), str):
            t.lp = (at + max(line.find(b'"lastPrompt"'), 0), r["lastPrompt"])
        keyed, leaf, explicit = rec.leaf()
        t.keyed = t.keyed or keyed
        if leaf:
            t.explicit, t.checkpoint, t.cleared = explicit or (t.explicit and leaf == t.checkpoint), leaf, False
        elif keyed and explicit:
            t.cleared, t.checkpoint, t.explicit = True, None, False
    elif k == "custom-title" and isinstance(r.get("customTitle"), str):
        t.custom = r["customTitle"]
    elif k == "ai-title" and isinstance(r.get("aiTitle"), str):
        t.ai = r["aiTitle"]
    elif k == "continued-in":
        t.continued = rec.continued_in


def _kept_check(chk):
    """A file's check counters as _checks keeps them: zero counts and the read's own bookkeeping left out."""
    out = {}
    for k, v in chk.items():
        if k in ("mtime", "cutoff"):
            continue
        if isinstance(v, Counter):
            v = {n: c for n, c in v.items() if c}
        if v:
            out[k] = v
    return out


def _unknown(chk, kind):
    """Count a record of an unknown type, keeping at most UNKNOWN_NAMES distinct names per file."""
    chk["anomalies"]["unknown record type"] += 1
    name = str(kind)[:40]
    chk["unknown"][name if name in chk["unknown"] or len(chk["unknown"]) < UNKNOWN_NAMES else "(other)"] += 1


def _pr_step(st, rec):
    """Count pull requests opened, by the rule desk/stats.py uses: a PR command or connector call whose result is not an error."""
    if rec.kind == "assistant":
        if not rec.has("tool_use") or rec.epoch is None:
            return
        for p in rec.parts():
            if p[0] != "tool" or not p[1] or p[1] in st.tools:
                continue
            _, tid, name, inp = p
            st.tools.add(tid)
            if PR_CMD.search(shell_command(name, inp)):
                st.pending[tid] = "pr"
            elif opens_pr_tool(name):
                st.pending[tid] = "mcppr"
    elif st.pending and rec.has("tool_result") and rec.epoch is not None:
        for p in rec.parts():
            if p[0] != "result" or p[1] not in st.pending:
                continue
            what = st.pending.pop(p[1])
            if p[3] or "already exists" in p[2]:
                continue
            urls = PR_URL.findall(p[2]) if what == "pr" else [(p[1], "")]
            if urls:
                st.t.prs.add("/".join(urls[-1]))


def prs_on(rows):
    """Pull requests opened on these rows by the _pr_step rule: {link or call id: epoch seconds of the earliest call that opened it}."""
    calls, out, seen = {}, {}, set()
    if SLIM:
        return prs_fold((calls, out, seen), rows)[1]
    for rec in rows:
        if rec.kind == "assistant" and rec.has("tool_use") and rec.epoch is not None:
            for p in rec.parts():
                if p[0] == "tool" and p[1] and p[1] not in seen:
                    seen.add(p[1])
                    calls[p[1]] = ("pr" if PR_CMD.search(shell_command(p[2], p[3])) else "mcppr" if opens_pr_tool(p[2]) else "", rec.epoch)
        elif rec.kind == "user" and rec.has("tool_result") and rec.epoch is not None:
            for p in rec.parts():
                what, when = calls.pop(p[1], ("", 0)) if p[0] == "result" else ("", 0)
                if not what or p[3] or "already exists" in p[2]:
                    continue
                urls = PR_URL.findall(p[2]) if what == "pr" else [(p[1], "")]
                if urls:
                    k = "/".join(urls[-1])
                    out[k] = min(out.get(k, when), when)
    return out


def prs_start():
    """Empty running state of prs_on(): (open calls, links opened, call ids seen)."""
    return {}, {}, set()


def prs_copy(ps):
    """A copy of a prs_on() running state."""
    return dict(ps[0]), dict(ps[1]), set(ps[2])


def prs_out(ps):
    """{link or call id: epoch of the earliest call that opened it} of a running state."""
    return ps[1]


def prs_fold(ps, rows):
    """Fold more rows (from their kept facts) into a prs_on() running state, in place; returns it."""
    calls, out, seen = ps
    for rec in rows:
        f = _facts(rec)[1]
        if f is None:
            continue
        when, parts = f
        if rec.kind == "assistant":
            for tid, what in parts:
                if tid not in seen:
                    seen.add(tid)
                    calls[tid] = (what, when)
            continue
        for tid, bad, link in parts:
            what, at = calls.pop(tid, ("", 0))
            if not what or bad:
                continue
            k = (link if what == "pr" else tid + "/")
            if k:
                out[k] = min(out.get(k, at), at)
    return ps


def _advance(st, path):
    """Feed the complete lines written since the state's offset; returns the unfinished last line, or None when the file was rewritten."""
    with open(path, "rb") as fh:
        fs = os.fstat(fh.fileno())
        head = fh.read(HEAD)
        if st.ino is not None and (fs.st_ino != st.ino or fs.st_size < st.offset or head[:len(st.head)] != st.head):
            return None
        st.ino, st.head, st.chk["mtime"] = fs.st_ino, head, fs.st_mtime
        if st.src is None or st.src[1] != fs.st_ino or len(st.src[2]) < min(len(head), HEAD):
            st.src = (path, fs.st_ino, head)  # what a slim row's re-read checks: same file, same first bytes
        fh.seek(st.offset)
        rest = b""
        for line in fh:
            if not line.endswith(b"\n"):
                rest = line
                break
            _feed(st, line, True, st.offset)
            st.offset += len(line)
    st.chk["size"] = st.offset + len(rest)
    return rest


def _keep(path, st):
    """Store a parse state for later appends when its file is recent, evicting the least recently used past the limits."""
    try:
        recent = time.time() - os.path.getmtime(path) < STATE_ACTIVE
    except OSError:
        recent = False
    with _lock:
        _states.pop(path, None)
        if recent:
            _states[path] = st
        newest = max(_states, key=lambda p: _states[p].chk.get("mtime") or 0, default=None)  # kept whatever its size: the live file that grows
        while len(_states) > STATE_MAX or sum(s.offset for p, s in _states.items() if p != newest) > STATE_BYTES:
            _states.pop(next(p for p in _states if p != newest))


def load(path, fresh=False):
    """Read a main transcript, only its appended bytes when a parse state is kept (fresh=True reads it all); see docs/data-model.md."""
    sid = os.path.basename(path)[:-6]
    with _lock:
        st = None if fresh else _states.pop(path, None)
    if st is not None and st.reader is not None and st.reader() is not None:
        st = st.copy()  # a reader may still walk the shared rows: grow a copy
    try:
        st = st or _State(sid)
        tail = _advance(st, path)
        if tail is None:  # shrank, replaced or rewritten: read it again from the start
            st = _State(sid)
            tail = _advance(st, path)
    except OSError:
        chk = _new_check()
        chk["unreadable"] = 1
        with _lock:
            _checks[path] = _kept_check(chk)
        return Transcript(sid)
    if tail.strip():
        snap = st.copy()
        _feed(snap, tail, False, snap.offset)
    else:
        snap = st.view()  # nothing to add: share the rows instead of copying them
    t = snap.finish()
    if snap.t.rows is st.t.rows:
        st.miss, st.waiting, st.recount = snap.miss, snap.waiting, snap.recount  # a recount on the shared rows holds for the state too
    t.size = snap.offset + len(tail)
    with _lock:
        _checks[path] = _kept_check(snap.chk)
    _keep(path, st)
    return t


def session_kind(t):
    """headless when only the headless CLI wrote the session's rows, else interactive."""
    return "headless" if HEADLESS in t.entries and not t.entries.intersection(INTERACTIVE) else "interactive"


def automated(t):
    """True when nobody typed into the session: only the headless CLI wrote it, or every prompt row carries turnOrigin sdk."""
    return session_kind(t) == "headless" or t.origins == {"sdk"}


PROGRAMS = {"claude-desktop": "desktop app", "cli": "terminal", "sdk-cli": "terminal"}  # entrypoint -> name the page prints


def elsewhere(t, conv):
    """Branches another program wrote off the shown conversation: {shown row uuid: (program, prompts and replies left out)}."""
    mk = t.mk
    if mk is not None and mk[0] is conv:
        return dict(mk[1])  # worked out with the conversation, by the append
    return _marks(_elsewhere_raw(t.rows, t.parent, conv)[2])


def _mine(conv):
    """Program that wrote the shown end: the newest user or assistant row of the conversation with an entrypoint."""
    return next((PROGRAMS.get(r.entry, "") for r in reversed(conv) if r.kind in ("user", "assistant") and r.entry), "")


def _elsewhere_raw(rows, parent, conv):
    """elsewhere() before empty counts are dropped: (program of the shown end, shown uuids, {shown uuid: (program, count)})."""
    shown, mine, out = {r.uuid for r in conv}, _mine(conv), {}
    for u, rec in rows.items():
        _elsewhere_add(out, u, rec, rows, parent, shown, mine)
    return mine, shown, out


def _elsewhere_add(out, u, rec, rows, parent, shown, mine):
    """Count one row in elsewhere() when another program wrote it on a branch that leaves the shown conversation."""
    if u in shown or rec.sidechain or rec.kind not in ("user", "assistant") or not mine or PROGRAMS.get(rec.entry, mine) == mine:
        return
    cur, seen = parent.get(u), set()
    while cur and cur not in shown and cur not in seen:
        seen.add(cur)
        cur = parent.get(cur)
    if cur in shown:
        n = sum(1 for x in (_facts(rec)[0] if SLIM else _shows(rec)) if x[0] in ("you", "claude"))
        prog, have = out.get(cur, (PROGRAMS[rec.entry], 0))
        out[cur] = (prog, have + n)


def _marks(out):
    """elsewhere()'s answer from its raw counts."""
    return {u: v for u, v in out.items() if v[1]}


def last_tool(items):
    """(name of the newest tool call, whether the newest tool result is an error) in a view() list."""
    name = next((i[2] for i in reversed(items) if i[0] == "tool"), "")
    return name, next((bool(i[3]) for i in reversed(items) if i[0] == "result"), False)


def turn_end(conv):
    """Epoch milliseconds of the newest assistant row in a conversation, 0 when none has a time."""
    for rec in reversed(conv):
        if rec.kind == "assistant":
            e = rec.epoch
            return int(e * 1000) if e is not None else 0
    return 0


def _compact(t, info=None):
    """Apply the newest compaction like the CLI: relink the messages it kept and drop rows written before it; True when relinked.
    info (a dict) gets what an appended row needs to be placed the same way: anchor, keep, gone."""
    keys = list(t.rows)
    marks = [i for i, u in enumerate(keys) if t.rows[u].boundary]
    kept = [i for i in marks if t.rows[keys[i]].preserved()]
    if not kept:
        return False
    if info is not None:
        info["marked"] = True
    t.rows, t.parent = dict(t.rows), dict(t.parent)  # the rows may be shared with a kept parse state: relink and drop on a copy
    last, keep, anchor = marks[-1], [], None
    if kept[-1] == last:
        p = t.rows[keys[last]].preserved()
        if p[0] == "segment":
            _, head, cur, anchor = p
            seen = set()
            while cur in t.rows and cur not in seen and (not keep or keep[-1] != head):
                seen.add(cur)
                keep.append(cur)
                cur = t.parent.get(cur)
            if not keep or keep[-1] != head:
                return False
            keep.reverse()
        else:
            anchor, keep = p
        if any(u not in t.rows for u in keep):
            return False
        if keep:
            prev = anchor
            for u in keep:
                t.parent[u], prev = prev, u
            for u in keys:
                if t.parent.get(u) == anchor and u != keep[0]:
                    t.parent[u] = keep[-1]
    held = set(keep)
    gone = {u for u in keys[:last] if u not in held}
    if info is not None:
        info.update(anchor=anchor, keep=keep, gone=gone)
    for u in gone:
        del t.rows[u], t.parent[u]
    if keep and gone:
        for u, rec in t.rows.items():
            if rec.kind in ("user", "assistant") and t.parent.get(u) in gone:
                t.parent[u] = keep[-1]
    return bool(keep)


def _above(t, a, b):
    """True when row b is row a or one of its ancestors."""
    seen = set()
    while a and a not in seen:
        if a == b:
            return True
        seen.add(a)
        a = t.parent.get(a)
    return False


def _below(t, b):
    """Rows that have row b among their ancestors (b included), in one pass over the parent links."""
    kids = {}
    for u, p in t.parent.items():
        if p:
            kids.setdefault(p, []).append(u)
    out, todo = {b}, [b]
    while todo:
        for k in kids.get(todo.pop(), ()):
            if k not in out:
                out.add(k)
                todo.append(k)
    return out


def _message_at(t, u):
    """The nearest user or assistant row at or above u."""
    seen = set()
    while u in t.rows and u not in seen:
        if t.rows[u].kind in ("user", "assistant"):
            return u
        seen.add(u)
        u = t.parent.get(u)
    return None


def _leaf(t, compacted):
    """The user or assistant row the resumed conversation ends at: the newest checkpoint, or the last row when it grew from it."""
    if t.cleared:
        return None
    cp, last, pos = t.checkpoint, t.last, {u: i for i, u in enumerate(t.rows)}
    start = last
    if not t.keyed and last and t.newest and t.newest != last:  # no checkpoint ever written: newest row grown from the last one
        best, below = "", _below(t, last)
        for u, rec in t.rows.items():
            if u != last and u in below and not rec.sidechain and rec.timestamp and rec.timestamp >= best:
                start, best = u, rec.timestamp
    if not compacted or (t.explicit and cp in t.rows and not t.rows[cp].sidechain):
        pick = cp if cp in t.rows else None
        if pick and not t.explicit and last in t.rows and last != pick and _above(t, last, pick):
            pick = last
        hit = _message_at(t, pick if pick or compacted else start)
        if hit:
            return hit
    named = set(t.parent.values())
    under = {t.parent[u] for u, r in t.rows.items() if r.kind in ("user", "assistant") and t.parent.get(u)}
    tips = []
    for u in t.rows:
        m = None if u in named else _message_at(t, u)
        if m and m not in under and m not in tips:
            tips.append(m)
    if len(tips) > 1:
        m = _message_at(t, cp if cp in tips else last)
        if m:
            return m
    pool = tips or [u for u, r in t.rows.items() if not r.sidechain and not (r.kind == "system" and r.raw.get("subtype") == "file_snapshot")]
    return max(pool, key=lambda u: (t.rows[u].epoch or float("-inf"), -pos[u])) if pool else None


def _walk(t, leaf, info=None):
    """Rows from the root or the compaction boundary down to the leaf; a missing parent is bridged by time (info["bridged"] set when tried)."""
    chain, seen, cur = [], set(), leaf
    while cur and cur not in seen:
        seen.add(cur)
        chain.append(cur)
        p = t.parent.get(cur)
        if not p:
            break
        if p in t.rows and p not in seen:
            cur = p
            continue
        if info is not None:
            info["bridged"] = True
        at, side, cur, best = t.rows[cur].epoch, t.rows[cur].sidechain, None, None
        for u, r in t.rows.items() if at is not None else ():
            e = r.epoch
            if u not in seen and r.sidechain == side and e is not None and e <= at and not (r.kind == "system" and r.raw.get("subtype") == "file_snapshot"):
                if best is None or e > best[0]:
                    best = (e, u)
        if best and (at - best[0]) * 1000 <= BRIDGE_MS:
            cur = best[1]
    return chain[::-1], seen


def _in_block(rec, mid):
    """True for rows that sit inside one assistant message's block: its pieces, tool results, meta rows, attachments, system notes."""
    if rec.kind == "assistant":
        return rec.msg_id == mid
    if rec.kind == "user":
        return rec.meta or rec.has("tool_result")
    return rec.kind == "attachment" or (rec.kind == "system" and not rec.boundary)


def _recover(t, chain, seen):
    """Bring back pieces of each assistant message on side branches (parallel tool calls) and their tool results, in file order."""
    pos = {u: i for i, u in enumerate(t.rows)}
    by_id, results, by_call = {}, {}, {}
    for u, rec in t.rows.items():
        if rec.kind == "assistant" and rec.msg_id:
            by_id.setdefault(rec.msg_id, []).append(u)
        elif rec.kind == "user" and rec.has("tool_result"):
            if t.parent.get(u):
                results.setdefault(t.parent[u], []).append(u)
            for i in rec.ids("tool_result"):
                if i:
                    by_call.setdefault(i, []).append(u)
    where, spans, done = {u: i for i, u in enumerate(chain)}, [], set()
    for u in chain:
        mid = t.rows[u].msg_id if t.rows[u].kind == "assistant" else None
        if not mid or mid in done:
            continue
        done.add(mid)
        group = by_id.get(mid, [u])
        extra = [g for g in group if g not in seen]
        for g in group:
            extra += [x for x in results.get(g, ()) if x not in seen and x not in extra]
            for i in t.rows[g].ids("tool_use"):
                extra += [x for x in by_call.get(i, ()) if x not in seen and x not in extra]  # matched by call id only
        seen.update(extra)
        end = max(where[g] for g in group if g in where) + 1
        while end < len(chain) and _in_block(t.rows[chain[end]], mid):
            end += 1
        if extra:
            spans.append([where[u], end, sorted(extra, key=pos.get)])
    merged = []
    for sp in sorted(spans):
        if merged and sp[0] < merged[-1][1]:
            merged[-1][1], merged[-1][2] = max(merged[-1][1], sp[1]), sorted(merged[-1][2] + sp[2], key=pos.get)
        else:
            merged.append(sp)
    out, at = [], 0
    for start, end, extra in merged:
        out += chain[at:start + 1]
        i = 0
        for k in range(start + 1, end):
            while i < len(extra) and pos[extra[i]] < pos[chain[k]]:
                out.append(extra[i])
                i += 1
            out.append(chain[k])
        out += extra[i:]
        at = end
    return out + chain[at:]


def _after(t, leaf, seen):
    """Non-message rows hanging below the leaf, such as prompts queued after the last reply, oldest first."""
    kids = {}
    for u, rec in t.rows.items():
        if t.parent.get(u) and rec.kind not in ("user", "assistant"):
            kids.setdefault(t.parent[u], []).append(u)
    out, todo = [], [leaf]
    while todo:
        for k in kids.get(todo.pop(0), ()):
            if k not in seen:
                seen.add(k)
                out.append(k)
                todo.append(k)
    return sorted(out, key=lambda u: t.rows[u].timestamp)


def conversation(t):
    """Rows of the conversation the CLI shows on resume, in order; t is a load() result (it is changed by compaction).
    A kept file's result is extended by the rows an append added when they can only add to it (_Memo), else worked out whole."""
    box = t.box
    if not SLIM or not MEMO or box is None:
        return _conversation_whole(t)
    with box.lock:
        return _conversation_memo(t, box)


MEMO = True  # extend a kept file's conversation by the append (tests compare with False)
_memo_counts = Counter()  # how conversation() answered a kept file: build, extend, same (the tests read the direction)


class _Box:
    """Shared by a kept parse state and every transcript read from it: the latest _Memo and the lock that guards it."""
    __slots__ = ("memo", "lock")

    def __init__(self):
        self.memo, self.lock = None, threading.Lock()


class _Memo:
    """conversation() and elsewhere() of one kept file at a row count, with the indexes that let later rows extend them."""
    __slots__ = ("n", "last", "dups", "sig", "fast", "comp", "own", "rows", "parent", "pos", "by_id", "results", "by_call", "kids", "childless",
                 "under", "miss", "leaf", "chain", "cidx", "mfirst", "callmsg", "mlist", "spans", "xowner", "merged", "out", "opos", "seen",
                 "convrecs", "after", "conv", "shown", "mine", "eout", "marks")


class _Full(Exception):
    """The append touched what earlier rows decided: work the conversation out whole."""


def _sig(t):
    """The transcript facts the end row is picked from besides the rows."""
    return t.checkpoint, t.explicit, t.cleared, t.last, t.newest, t.keyed


def _conversation_memo(t, box):
    """conversation() of a kept file: the kept answer when nothing moved, extended when the append only adds, else worked out whole."""
    rows0, m = t.rows, box.memo
    n, new = len(rows0), None
    if m is not None and m.dups == t.dups and n >= m.n:
        k = n - m.n
        tail = list(islice(reversed(rows0.items()), k + 1))
        if m.n == 0 or (len(tail) == k + 1 and tail[k][1] is m.last):
            new = tail[:k][::-1]
    if new is not None:
        if not new and m.sig == _sig(t):
            _memo_counts["same"] += 1
            return _memo_answer(t, m)
        if m.fast:
            try:
                _memo_extend(t, m, new, n)
                _memo_counts["extend"] += 1
                return _memo_answer(t, m)
            except _Full:
                pass
    _memo_counts["build"] += 1
    box.memo = None
    m = _memo_build(t, n)
    box.memo = m
    return _memo_answer(t, m)


def _memo_answer(t, m):
    """The kept conversation as a new list, with the compacted rows and the elsewhere() answer set on the transcript."""
    if m.own:
        t.rows, t.parent = m.rows, m.parent
    conv = list(m.conv)
    t.mk = (conv, m.marks)
    return conv


def _memo_index(m, items, rows, parent):
    """Add rows (uuid, row) to the indexes the recovery, the queued-prompt walk and the tips read."""
    for u, rec in items:
        p = parent.get(u)
        m.pos[u] = len(m.pos)
        k = rec.kind
        if k == "assistant":
            if rec.msg_id:
                m.by_id.setdefault(rec.msg_id, []).append(u)
        elif k == "user" and rec.has("tool_result"):
            if p:
                m.results.setdefault(p, []).append(u)
            for i in rec.ids("tool_result"):
                if i:
                    m.by_call.setdefault(i, []).append(u)
        if p and k not in ("user", "assistant"):
            m.kids.setdefault(p, []).append(u)
        if p and k in ("user", "assistant"):
            m.under.add(p)
        if p and p not in rows:
            m.miss.add(p)


def _memo_build(t, n):
    """Work the conversation out whole, keeping what an append needs to extend it."""
    raw = t.rows
    last = next(reversed(raw.values())) if raw else None
    info = {}
    compacted = _compact(t, info)
    rows, parent = t.rows, t.parent
    m = _Memo()
    m.n, m.last, m.dups, m.sig = n, last, t.dups, _sig(t)
    m.comp = (info["anchor"], info["keep"], info["gone"]) if "gone" in info else None
    m.own = rows is not raw
    m.rows, m.parent = (rows, parent) if m.own else (None, None)
    m.fast = t.keyed and not (info.get("marked") and m.comp is None)
    m.pos, m.by_id, m.results, m.by_call, m.kids, m.under, m.miss = {}, {}, {}, {}, {}, set(), set()
    _memo_index(m, rows.items(), rows, parent)
    named = set(parent.values())
    m.childless = {u for u in rows if u not in named}
    m.mfirst, m.callmsg, m.mlist, m.spans, m.xowner, m.merged, m.out, m.opos = {}, {}, [], [], {}, [], [], []
    leaf = _leaf(t, compacted)
    m.leaf, m.chain, m.cidx, m.seen, m.after = leaf, [], {}, set(), []
    if leaf:
        winfo = {}
        m.chain, m.seen = _walk(t, leaf, winfo)
        m.fast = m.fast and not winfo.get("bridged")
        m.cidx = {u: i for i, u in enumerate(m.chain)}
        _memo_out(m, rows, _memo_recover(m, rows, 0), 0)
        m.after = _memo_after(m, rows, leaf)
    else:
        m.fast = False
    m.convrecs = [rows[u] for u in m.out]
    m.conv = m.convrecs + [rows[u] for u in m.after]
    m.mine, m.shown, m.eout = _elsewhere_raw(rows, parent, m.conv)
    m.marks = _marks(m.eout)
    return m


def _memo_recover(m, rows, s0):
    """_recover() for the messages that first show at chain place s0 or later; returns their spans (start, end, extra rows in file order)."""
    chain, seen, cidx, pos, out = m.chain, m.seen, m.cidx, m.pos, []
    for i in range(s0, len(chain)):
        u = chain[i]
        rec = rows[u]
        mid = rec.msg_id if rec.kind == "assistant" else None
        if not mid or mid in m.mfirst:
            continue
        m.mfirst[mid] = i
        group, calls = m.by_id.get(mid, [u]), []
        extra = [g for g in group if g not in seen]
        for g in group:
            extra += [x for x in m.results.get(g, ()) if x not in seen and x not in extra]
            for c in rows[g].ids("tool_use"):
                calls.append(c)
                extra += [x for x in m.by_call.get(c, ()) if x not in seen and x not in extra]  # matched by call id only
        m.mlist.append((i, mid, calls))
        for c in calls:
            m.callmsg.setdefault(c, i)
        seen.update(extra)
        end = max(cidx[g] for g in group if g in cidx) + 1
        while end < len(chain) and _in_block(rows[chain[end]], mid):
            end += 1
        if extra:
            sp = (i, end, sorted(extra, key=pos.get))
            m.spans.append(sp)
            out.append(sp)
            for x in extra:
                m.xowner[x] = i
    return out


def _memo_out(m, rows, spans, s0):
    """Merge new spans and lay the chain out from place s0 with the recovered rows in file order (the end of _recover())."""
    merged, pos, chain, out, opos = [], m.pos, m.chain, m.out, m.opos
    for sp in spans:
        if merged and sp[0] < merged[-1][1]:
            merged[-1][1], merged[-1][2] = max(merged[-1][1], sp[1]), sorted(merged[-1][2] + sp[2], key=pos.get)
        else:
            merged.append([sp[0], sp[1], sp[2]])
    at = s0
    for start, end, extra in merged:
        opos.extend(range(len(out), len(out) + start + 1 - at))
        out += chain[at:start + 1]
        i = 0
        for k in range(start + 1, end):
            while i < len(extra) and pos[extra[i]] < pos[chain[k]]:
                out.append(extra[i])
                i += 1
            opos.append(len(out))
            out.append(chain[k])
        out += extra[i:]
        at = end
    opos.extend(range(len(out), len(out) + len(chain) - at))
    out += chain[at:]
    m.merged += merged


def _memo_after(m, rows, leaf):
    """_after() from the kept index of non-message rows by parent."""
    out, todo, added = [], [leaf], set()
    while todo:
        for k in m.kids.get(todo.pop(0), ()):
            if k not in m.seen and k not in added:
                added.add(k)
                out.append(k)
                todo.append(k)
    return sorted(out, key=lambda u: rows[u].timestamp)


def _memo_extend(t, m, new, n):
    """Extend a memo by the rows an append added (in file order); raises _Full when they reach into what earlier rows decided."""
    if any(rec.boundary for _, rec in new) or any(u in m.miss for u, _ in new):
        raise _Full  # a compaction line, or a row earlier rows named as their missing parent
    praw = t.parent
    if m.own:
        rows, parent = dict(m.rows), dict(m.parent)
        anchor, keep, gone = m.comp
        for u, rec in new:
            p = praw.get(u)
            if keep and p == anchor and u != keep[0]:
                p = keep[-1]
            if keep and gone and rec.kind in ("user", "assistant") and p in gone:
                p = keep[-1]
            rows[u], parent[u] = rec, p
        m.rows, m.parent = rows, parent
    else:
        rows, parent = t.rows, praw
    _memo_index(m, new, rows, parent)
    for u, _ in new:
        m.childless.add(u)
    for u, _ in new:
        m.childless.discard(parent.get(u))
    e = SimpleNamespace(rows=rows, parent=parent)
    leaf = _memo_leaf(t, m, e)
    walked, cur, cidx = [], leaf, m.cidx
    while cur not in cidx:
        if cur in walked:
            raise _Full
        walked.append(cur)
        p = parent.get(cur)
        if not p or p not in rows:
            raise _Full  # a new root or a missing parent bridged by time
        cur = p
    if cur != m.leaf:
        raise _Full  # the end moved to another branch
    walked.reverse()
    old_len = len(m.chain)
    for u in walked:
        cidx[u] = len(m.chain)
        m.chain.append(u)
    s = m.merged[-1][0] if m.merged and m.merged[-1][1] >= old_len else old_len  # a block that ran to the old end may take the new rows in
    for u in walked:
        if u in m.xowner:
            s = min(s, m.xowner[u])
    for u in set(walked).union(u for u, _ in new):
        rec = rows[u]
        if rec.kind == "assistant":
            s = min(s, m.mfirst.get(rec.msg_id, s))
        elif rec.kind == "user" and rec.has("tool_result"):
            pr = rows.get(parent.get(u) or "")
            if pr is not None and pr.kind == "assistant":
                s = min(s, m.mfirst.get(pr.msg_id, s))
            for i in rec.ids("tool_result"):
                s = min(s, m.callmsg.get(i, s))
    for ms in reversed(m.merged):
        if ms[1] <= s:
            break
        if ms[0] < s:
            s = ms[0]
            break
    while m.spans and m.spans[-1][0] >= s:
        for x in m.spans.pop()[2]:
            m.seen.discard(x)
            m.xowner.pop(x, None)
    while m.mlist and m.mlist[-1][0] >= s:
        i, mid, calls = m.mlist.pop()
        m.mfirst.pop(mid, None)
        for c in calls:
            if m.callmsg.get(c) == i:
                del m.callmsg[c]
    while m.merged and m.merged[-1][1] > s:
        m.merged.pop()
    cut = m.opos[s] if s < old_len else len(m.out)
    old_tail = set(m.out[cut:]).union(m.after)
    del m.out[cut:], m.opos[s:], m.convrecs[cut:]
    m.seen.update(walked)
    _memo_out(m, rows, _memo_recover(m, rows, s), s)
    m.convrecs += [rows[u] for u in m.out[cut:]]
    m.after = _memo_after(m, rows, leaf)
    m.conv = m.convrecs + [rows[u] for u in m.after]
    m.leaf, m.n, m.last, m.sig = leaf, n, new[-1][1] if new else m.last, _sig(t)
    new_tail = set(m.out[cut:]).union(m.after)
    ids, mine = {u for u, _ in new}, _mine(m.conv)
    if (old_tail - new_tail) or (new_tail - old_tail - ids) or mine != m.mine:
        m.mine, m.shown, m.eout = _elsewhere_raw(rows, parent, m.conv)  # shown rows moved under earlier rows: counted again whole
    else:
        m.shown |= new_tail
        m.eout = dict(m.eout)
        for u, rec in new:
            _elsewhere_add(m.eout, u, rec, rows, parent, m.shown, mine)
    m.marks = _marks(m.eout)


def _memo_leaf(t, m, e):
    """_leaf() for a kept file with a checkpoint written, reading the kept tips index after a compaction; raises _Full for the rarer rules."""
    if t.cleared or not t.keyed:
        raise _Full
    rows, cp, last = e.rows, t.checkpoint, t.last
    compacted = bool(m.comp and m.comp[1])
    hit = None
    if not compacted or (t.explicit and cp in rows and not rows[cp].sidechain):
        pick = cp if cp in rows else None
        if pick and not t.explicit and last in rows and last != pick and _above(e, last, pick):
            pick = last
        hit = _message_at(e, pick if pick or compacted else last)
    if hit:
        return hit
    if not compacted:
        raise _Full
    tips = set()
    for u in m.childless:
        x = _message_at(e, u)
        if x and x not in m.under:
            tips.add(x)
    if len(tips) > 1:
        x = _message_at(e, cp if cp in tips else last)
        if x:
            return x
    if not tips:
        raise _Full
    return max(tips, key=lambda u: (rows[u].epoch or float("-inf"), -m.pos[u]))


def _conversation_whole(t):
    """conversation() from every row (the rule as written; also the tests' oracle with SLIM = False)."""
    leaf = _leaf(t, _compact(t))
    if not leaf:
        return []
    chain, seen = _walk(t, leaf)
    chain = _recover(t, chain, seen) + _after(t, leaf, seen)
    return [t.rows[u] for u in chain]


def view(conv, marks=None):
    """What the conversation shows, in order: ('you', text), ('claude', text), ('tool', id, name, input), ('result', id, text, isError, structured, cwd),
    ('compact', 1 when the CLI prints its Compact summary line), ('interrupt',), ('out', text, isError, 'bash' or 'local') for ! and local command output, ('image',) per image beside a typed prompt,
    ('elsewhere', program, count) after a row named in marks (see elsewhere())."""
    return list(iter_view(conv, marks))


def iter_view(conv, marks=None):
    """view() one item at a time, so a caller can fold each row's bodies away before the next row is read again."""
    rd = _Reader()  # slim rows are read again through one handle, in conversation order
    try:
        for i, rec in enumerate(conv):
            shows = _shows(rd.full(rec))
            if shows and shows[0] == ("compact",):  # the CLI prints "Compact summary" only when the summary row is not transcript-only
                s = next((r for r in conv[i + 1:] if r.kind == "user" and r.compact), None)
                shows = [("compact", 1 if s and not s.raw.get("isVisibleInTranscriptOnly") else 0)]
            yield from shows
            if marks and rec.uuid in marks:
                yield ("elsewhere",) + tuple(marks[rec.uuid])
    finally:
        rd.close()


def _shows(rec):
    """What one row shows; see view()."""
    out = []
    if rec.kind == "assistant":
        for p in rec.parts():
            if p[0] == "text" and p[1].strip():
                out.append(("claude", p[1].strip()))
            elif p[0] == "tool":
                out.append(p)
    elif rec.kind == "user" and not rec.meta and not rec.compact:
        parts = rec.parts()
        res = [p for p in parts if p[0] == "result"]
        if res:
            tur = rec.raw.get("toolUseResult") if len(res) == 1 else None
            return [p + (tur, rec.cwd) for p in res]
        said = False
        for p in parts:
            x = p[1].strip() if p[0] == "text" else ""
            o = command_output(x)
            if o:
                out.append(("out",) + o + ("bash" if x.startswith("<bash-") else "local",))
            elif x.startswith(INTERRUPT):
                out.append(("interrupt",))
            elif shown(x):
                out.append(("you", shown(x)))
                said = True
        images = sum(1 for p in parts if p[0] == "image")
        out += [("image",)] * images if said else [("you", "[Image]")] if images else []
    elif rec.kind == "attachment":
        out += [("you", x) for x in (shown(q.strip()) for q in rec.queued() or ()) if x]
    elif rec.boundary:
        out.append(("compact",))
    return out


OUTPUT_TAGS = (("bash-stdout", "bash-stderr"), ("local-command-stdout", "local-command-stderr"))  # ! command and local slash-command output


def command_output(text):
    """(stdout and stderr joined, has stderr) of a ! command or local command output text, or None for other text and empty output."""
    for so, se in OUTPUT_TAGS:
        if text.startswith("<" + so) or text.startswith("<" + se):
            o = re.search(f"<{so}>(.*?)</{so}>", text, re.S)
            e = re.search(f"<{se}>(.*?)</{se}>", text, re.S)
            std, err = (o.group(1).strip() if o else ""), (e.group(1).strip() if e else "")
            body = "\n".join(x for x in (std, err) if x)
            return (body, bool(err)) if body else None
    return None


def _tag(text, name):
    """Content of the first non-empty <name ...>...</name> element in text, like the CLI's tag reader; None when absent."""
    for m in re.finditer(f"<{name}(?=[\\s>])[^>]*>(.*?)</{name}>", text, re.S | re.I):
        if m.group(1):
            return m.group(1)
    return None


PASTED = re.compile(r'\n{0,2}<pasted_content id="([0-9a-f]{4})">\n((?:.*?\n)?)</pasted_content id="\1">\n{0,2}', re.S)  # the CLI's pasted block
PASTED_ANY = re.compile(r'<pasted_content(?:\s[^>]*)?>(.*?)</pasted_content(?:\s[^>]*)?>', re.S)  # other pasted wrappers, any id or spacing
TITLE_WINDOW = 65536  # the CLI's resume picker reads only this many bytes from each end of a transcript


def unwrap_pasted(text):
    """Text with the CLI's pasted blocks replaced by what was pasted (the CLI shows the body, not the wrapper)."""
    return PASTED.sub(lambda m: m.group(2)[:-1], text) if "<pasted_content" in text else text


def strip_tags(text):
    """Text without <tag>...</tag> elements whose closing tag follows, as the CLI cleans a title (system reminders, command tags)."""
    if "</" not in text:
        return text
    out, pos = [], 0
    for m in re.finditer(r"<([a-z][A-Za-z0-9_-]*)(?:>|\s[^>]*>)", text):
        if m.start() < pos:
            continue
        end = text.find(f"</{m.group(1)}>", m.end())
        if end < 0:
            continue
        out.append(text[pos:m.start()])
        pos = end + len(m.group(1)) + 3
        pos += text.startswith("\n", pos)
    return "".join(out) + text[pos:] if out else text


def own_words(text):
    """Text without pasted wrappers the CLI left in place: the typed words around them, or what was pasted when nothing was typed."""
    if "<pasted_content" not in text:
        return text
    words = " ".join(PASTED_ANY.sub(" ", text).split())
    return words or PASTED_ANY.sub(lambda m: m.group(1), text).strip()


WRAP = r"[A-Za-z]\w*[-_][\w-]*"  # a wrapper tag name: holds a hyphen or underscore (pasted_content, system-reminder), unlike words a person types (<b>, Vec<T>)
ELEMENT = re.compile(r"<(" + WRAP + r")(?:\s[^<>]*)?>(.*?)</\1(?:\s[^<>]*)?>", re.S)  # a whole <wrapper attr>...</wrapper> element
TAG = re.compile(r"</?" + WRAP + r"(?:\s[^<>]*)?/?>|<" + WRAP + r"(?:\s[^<>]*)?$")  # one opening, closing or cut-off wrapper tag


def no_tags(text):
    """A title without wrapper tags (the app's step beyond the picker): typed words outside wrapper elements, else the text inside them, else empty."""
    if "<" not in text:
        return text
    words = " ".join(TAG.sub(" ", ELEMENT.sub(" ", text)).split())
    return words or " ".join(TAG.sub(" ", text).split())


def first_parts(rec):
    """A user record by the CLI's first-prompt rule: (prompt text or None, slash command without arguments or None, saw a <tick> prompt)."""
    if rec.kind != "user" or rec.meta or rec.compact or rec.has("tool_result"):
        return None, None, False
    c = rec.msg.get("content")
    texts = [c] if isinstance(c, str) else [b["text"] for b in c if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)] if isinstance(c, list) else []
    cmd, tick = None, False
    for x in texts:
        if not x:
            continue
        a = unwrap_pasted(x).replace("\n", " ").strip()
        name = _tag(a, "command-name")
        if name:
            args = (_tag(a, "command-args") or "").strip()
            if not args:
                cmd = cmd or name
                continue
            return f"{name} {args}", cmd, tick
        b = _tag(a, "bash-input")
        if b:
            return "! " + b, cmd, tick
        if FIRST_SKIP.match(a):
            tick = tick or a.startswith("<tick>")
            continue
        return (a[:200].strip() + "\u2026" if len(a) > 200 else a), cmd, tick
    return None, cmd, tick


def first_prompt(rec):
    """A user record's text by the CLI's first-prompt rule, or None."""
    return first_parts(rec)[0]


def prompt_title(t):
    """The prompt text the CLI's resume picker names an untitled session by, cleaned like the CLI: (text, shown when the text cleans to nothing)."""
    lp = t.lp[1] if t.lp and t.lp[0] >= t.size - TITLE_WINDOW else ""
    raw = lp or t.first or t.first_cmd or ("Proactive session" if t.tick else "")
    if not raw:
        return "", "(session)"
    if raw.startswith("<tick>"):
        return "", "Autonomous session"
    return strip_tags(unwrap_pasted(raw)).strip(), t.sid[:8]


def own_message(t, rec):
    """True for a record this session wrote itself, not one copied in from the session it was forked from."""
    return rec.session in ("", t.sid)


# ---------- text conventions inside messages ----------
HIDDEN_TAGS = ("<task-notification", "<bash-stdout", "<bash-stderr", "<local-command-stdout", "<local-command-stderr")  # shown as notes or output, never as a prompt


def shown(text):
    """User text as the CLI shows it as a prompt: /command args, ! shell line, other text raw (tags too); empty for output, notes and interrupt markers."""
    if text.startswith("<command-") and "<command-message>" in text:
        m = re.search(r"<command-name>(.*?)</command-name>", text, re.S)
        a = re.search(r"<command-args>(.*?)</command-args>", text, re.S)
        return (m.group(1).strip() + " " + (a.group(1).strip() if a else "")).strip() if m else ""
    if text.startswith("<bash-input>"):
        return "! " + re.sub(r"</?bash-input>", "", text.split("</bash-input>")[0]).strip()
    if text.startswith("<command-"):
        return text  # command tags without <command-message> show raw on the resumed screen (CLI 2.1.322)
    if text.startswith(HIDDEN_TAGS) or text.startswith(INTERRUPT):
        return ""
    return text


def prompt_kind(rec):
    """How a main-chain user record without tool results counts: (label, isMemorySave); label is meta, carryover, interrupt, prompt, end or skip."""
    parts = rec.parts()
    texts = [p[1].lstrip() for p in parts if p[0] == "text"]
    text = next((x for x in texts if not x.startswith("<system-reminder>")), "")
    if rec.meta:
        return "meta", text.startswith("# Remember")
    if rec.compact:
        return "carryover", False
    if text.startswith(INTERRUPT):
        return "interrupt", False
    human, image = rec.human, any(p[0] == "image" for p in parts)
    if human and ((text and (not text.startswith("<") or text.startswith(("<command-message>", "<pasted_content")))) or (not text and image)):
        return "prompt", text.startswith("<command-message>remember")
    return ("end" if not human or text.startswith("<task-notification>") else "skip"), False


# ---------- tool calls ----------
def tool_hint(inp):
    """Most telling argument of a tool call."""
    hint = inp.get("file_path") or inp.get("command") or inp.get("pattern") or inp.get("description") or inp.get("url") or inp.get("query") or ""
    return str(hint).replace("\n", " ")


TOOL_LABELS = {"Edit": "Update", "MultiEdit": "Update", "WebFetch": "Fetch", "WebSearch": "Web Search", "Grep": "Search", "Glob": "Search"}  # CLI 2.1.322
UNSHOWN_TOOLS = ("TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "NotebookEdit")  # the CLI drew no line for these in a resumed session


def tool_display(name, inp):
    """The line the CLI's detailed view prints for a tool call, such as Update(/a.txt) or srv - do_thing (MCP)(query: "x"); empty when it prints none."""
    if name in UNSHOWN_TOOLS:
        return ""
    if name.startswith("mcp__") and name.count("__") >= 2:
        _, server, tool = name.split("__", 2)
        args = ", ".join(f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in inp.items())
        return f"{server} - {tool} (MCP)({args})"
    if name in AGENT_TOOLS:
        kind = _s(inp.get("subagent_type"))
        return f"{kind if kind and kind != 'general-purpose' else 'Agent'}({_s(inp.get('description'))})"
    if name in ("Grep", "Glob"):
        return "Search(" + ", ".join(f"{k}: {json.dumps(inp[k], ensure_ascii=False)}" for k in ("pattern", "path") if isinstance(inp.get(k), str)) + ")"
    if name == "WebSearch":
        return f"Web Search({json.dumps(_s(inp.get('query')), ensure_ascii=False)})"
    if name == "Skill":
        return f"Skill({_s(inp.get('skill'))})"
    return f"{TOOL_LABELS.get(name, name)}({tool_hint(inp) if name in ('Read', 'Edit', 'MultiEdit', 'Write', 'Bash', 'WebFetch') else ''})"


GROUPED_TOOLS = ("Read", "Grep", "Glob")  # the default view folds these into "Read N files" / "Searched for N patterns" without result lines
QUIET_TOOLS = GROUPED_TOOLS + AGENT_TOOLS + UNSHOWN_TOOLS  # successful calls the CLI prints no result line for (CLI 2.1.322)
WRAPPED_ERROR = re.compile(r"^\s*<tool_use_error>(.*?)</tool_use_error>\s*$", re.S)
ERROR_SUMMARIES = {("Edit", "File has not been read yet"): "File must be read first"}  # errors the CLI prints as its own short line
WRITE_LINES = 10  # lines of a new file the CLI prints under Write


def _plural(n, word):
    """'1 line', '2 lines'."""
    return f"{n} {word}{'' if n == 1 else 's'}"


def _rel(path, cwd):
    """A file path as the CLI prints it: relative to the session folder when inside it."""
    return path[len(cwd) + 1:] if cwd and path.startswith(cwd.rstrip("/") + "/") else path


def _size(n):
    """Byte count as the CLI's Fetch line prints it: 512 bytes, 2KB, 1.5MB."""
    for unit, k in (("MB", 1 << 20), ("KB", 1 << 10)):
        if n >= k:
            return f"{n / k:.1f}".rstrip("0").rstrip(".") + unit
    return f"{n} bytes"


def _patch(patch):
    """Diff lines of a structured patch as the CLI prints them, with the counts of added and removed lines."""
    out, add, rem = [], 0, 0
    for h in patch if isinstance(patch, list) else []:
        if not isinstance(h, dict):
            continue
        o, n = _n(h.get("oldStart")) or 1, _n(h.get("newStart")) or 1
        for ln in h.get("lines") if isinstance(h.get("lines"), list) else []:
            ln = _s(ln)
            if ln.startswith("-"):
                out.append((o, "-" + ln[1:]))
                o, rem = o + 1, rem + 1
            elif ln.startswith("+"):
                out.append((n, "+" + ln[1:]))
                n, add = n + 1, add + 1
            else:
                out.append((n, " " + ln[1:]))
                o, n = o + 1, n + 1
    w = max((len(str(i)) for i, _ in out), default=1)
    return [f"{str(i).rjust(w)} {x}" for i, x in out], add, rem


def screen_result(name, text, error, tur, cwd=""):
    """A tool result as the CLI's default view prints it under the call: (text, quiet); quiet is 1 when a successful call shows no result line."""
    if error:
        m = WRAPPED_ERROR.match(text)
        x = (m.group(1) if m else text).strip()
        for (tool, says), short in ERROR_SUMMARIES.items():
            if name == tool and says in x:
                return short, 0
        return (x if x.startswith("Error") else "Error: " + x if x else "Error"), 0
    if name in QUIET_TOOLS or name.startswith("mcp__") or not isinstance(tur, dict):
        return text, 1
    if name == RUN_TOOL:
        out = "\n".join(x for x in (_s(tur.get("stdout")).strip("\n"), _s(tur.get("stderr")).strip("\n")) if x)
        if not out.strip():
            return ("Done" if tur.get("noOutputExpected") else "(No output)"), 1
        lines = out.split("\n")
        return ("\n".join(lines) if len(lines) <= 4 else "\n".join(lines[:3]) + f"\n… +{_plural(len(lines) - 3, 'line')}"), 1  # folded into "Ran N shell commands"
    if name in ("Edit", "MultiEdit") or (name == "Write" and tur.get("type") == "update"):
        lines, add, rem = _patch(tur.get("structuredPatch"))
        head = ", ".join(x for x in (add and "Added " + _plural(add, "line"), rem and ("removed " if add else "Removed ") + _plural(rem, "line")) if x)
        return "\n".join(([head] if head else []) + lines), 0
    if name == "Write":
        body = _s(tur.get("content")).split("\n")
        body = body[:-1] if body and body[-1] == "" else body
        w = len(str(min(len(body), WRITE_LINES)))
        shown = [f"{str(i + 1).rjust(w)} {x}" for i, x in enumerate(body[:WRITE_LINES])]
        more = [f"… +{_plural(len(body) - WRITE_LINES, 'line')}"] if len(body) > WRITE_LINES else []
        return "\n".join([f"Wrote {_plural(len(body), 'line')} to {_rel(_s(tur.get('filePath')), cwd)}"] + shown + more), 0
    if name == "WebFetch" and isinstance(tur.get("bytes"), int):
        return f"Received {_size(tur['bytes'])} ({_n(tur.get('code'))} {_s(tur.get('codeText'))})".replace(" )", ")"), 0
    if name == "WebSearch" and isinstance(tur.get("results"), list):
        n, secs = sum(1 for r in tur["results"] if not isinstance(r, str)), _n(tur.get("durationSeconds"))
        took = f"{round(secs * 1000)}ms" if secs < 1 else f"{round(secs)}s"
        return f"Did {_plural(n, 'search').replace('searchs', 'searches')} in {took}", 0
    return text, 0


def tool_kind(name):
    """Family of a tool: read, edit, run, search or other."""
    return "read" if name == "Read" else "edit" if name in EDITS else "run" if name == RUN_TOOL else "search" if name in ("Grep", "Glob") else "other"


def short_tool(name):
    """Tool name without its mcp__server__ prefix."""
    return name.split("__")[-1] if name.startswith("mcp__") else name


def edited_file(name, inp, notebooks=False):
    """File an edit tool changed, or an empty string."""
    if name not in EDITS:
        return ""
    return str(inp.get("file_path") or (inp.get("notebook_path") if notebooks else "") or "")


def shell_command(name, inp):
    """Shell command of a run-tool call, or an empty string."""
    return str(inp.get("command") or "") if name == RUN_TOOL else ""


def opens_pr_tool(name):
    """True for a connector tool that opens a pull request."""
    return "pull_request_create" in name or "create_pull_request" in name


def plan_step(plan, ticked, name, inp):
    """Task-list steps newly checked off by one plan or todo tool call; plan is the live list of [text, status]."""
    if name == "mcp__ccd_turn__update_plan":
        if isinstance(inp.get("items"), list):
            plan[:] = [[str(x.get("content", "")), x.get("status")] for x in inp["items"] if isinstance(x, dict)]
        cur = next((i for i, x in enumerate(plan) if x[1] == "in_progress"), None)
        if inp.get("advance") and cur is not None:
            plan[cur][1] = "completed"
            nxt = next((i for i in range(cur + 1, len(plan)) if plan[i][1] == "pending"), None)
            if nxt is not None:
                plan[nxt][1] = "in_progress"
        done = inp.get("done")
        for i in done if isinstance(done, list) else []:
            if isinstance(i, int) and 0 < i <= len(plan):
                plan[i - 1][1] = "completed"
        i = inp.get("start")
        if isinstance(i, int) and 0 < i <= len(plan) and plan[i - 1][1] != "completed":
            plan[i - 1][1] = "in_progress"
    elif name == "mcp__ccd_turn__wrap_up":
        for x in plan:
            if x[1] == "in_progress":
                x[1] = "completed"
    elif name == "TodoWrite" and isinstance(inp.get("todos"), list):
        plan[:] = [[str(x.get("content", "")), x.get("status")] for x in inp["todos"] if isinstance(x, dict)]
    elif name == "TaskUpdate" and inp.get("status") == "completed":
        plan.append(["task " + str(inp.get("taskId")), "completed"])
    else:
        return 0
    new = {x[0] for x in plan if x[1] == "completed"} - ticked
    ticked |= new
    return len(new)


# ---------- live-process registry ----------
def registry():
    """Entries of sessions/*.json as dicts pid, sid, status, at, name, entry, start (procStart), parked; unreadable files and odd fields are counted."""
    out, chk = [], {"files": 0, "bad": 0, "missing": Counter(), "odd": Counter()}
    for path in glob.glob(os.path.join(_home(), "sessions", "*.json")):
        chk["files"] += 1
        try:
            with open(path) as fh:
                o = json.load(fh)
        except (OSError, ValueError):
            chk["bad"] += 1
            continue
        if not isinstance(o, dict):
            chk["bad"] += 1
            continue
        for name, types in REGISTRY_EXPECT:
            if name not in o:
                chk["missing"][name] += 1
            elif not isinstance(o[name], types) or isinstance(o[name], bool):
                chk["odd"][name] += 1
        try:
            pid = int(o["pid"])
        except (KeyError, TypeError, ValueError):
            continue
        named = o.get("nameSource") in (None, "user", "peer")  # a derived name is the CLI's automatic one, not a title
        out.append({"pid": pid, "sid": _s(o.get("sessionId")) or None, "status": o.get("status"), "at": _n(o.get("statusUpdatedAt")),
                    "name": (_s(o.get("name")) or None) if named else None, "entry": _s(o.get("entrypoint")),
                    "start": " ".join(_s(o.get("procStart")).split()), "parked": o.get("parkedJobId") is not None})
    with _lock:
        _registry.update(chk)
    return out


# ---------- self-check ----------
def format_report():
    """(warnings, notes, checked) from the latest read of each file and of the registry; counts and field names only, notes never flip ok."""
    with _lock:
        for p in [p for p in _checks if not os.path.exists(p)]:
            del _checks[p]
        checks, reg = list(_checks.values()), dict(_registry)
    warn, notes, missing, odd, old_missing, old_odd = [], [], Counter(), Counter(), Counter(), Counter()
    for c in checks:
        missing.update(c.get("missing", {}))
        odd.update(c.get("odd", {}))
        old_missing.update(c.get("old_missing", {}))
        old_odd.update(c.get("old_odd", {}))
    unreadable = sum(c.get("unreadable", 0) for c in checks)
    nonempty = [c for c in checks if c.get("size") and not c.get("unreadable")]
    empty = sum(1 for c in nonempty if not (c.get("records", {}).get("user") or c.get("records", {}).get("assistant")))
    bad = sum(c.get("bad", 0) for c in checks)
    anomalies, unknown = Counter({k: 0 for k in ANOMALIES}), Counter()
    for c in checks:
        anomalies.update(c.get("anomalies", {}))
        unknown.update(c.get("unknown", {}))
    anomalies["bad JSON line"] = bad

    def add(source, issue, count, field=None, to=warn):
        """Append one warning (or note)."""
        to.append(dict({"source": source, "issue": issue, "count": count}, **({"field": field} if field else {})))

    if unreadable:
        add("transcripts", "unreadable files", unreadable)
    if bad:
        add("transcripts", "unparseable lines", bad)
    if empty and empty * 2 > len(nonempty):  # one metadata-only file is normal; most files without messages is not
        add("transcripts", "files without messages", empty)
    for f, n in sorted(missing.items()):
        add("transcripts", "missing field", n, f)
    for f, n in sorted(odd.items()):
        add("transcripts", "unexpected field type", n, f)
    if reg["bad"]:
        add("registry", "unreadable files", reg["bad"])
    for f, n in sorted(reg["missing"].items()):
        add("registry", "missing field", n, f)
    for f, n in sorted(reg["odd"].items()):
        add("registry", "unexpected field type", n, f)
    for f, n in sorted(old_missing.items()):
        add("transcripts", f"missing field in records older than {RECENT_DAYS} days", n, f, notes)
    for f, n in sorted(old_odd.items()):
        add("transcripts", f"unexpected field type in records older than {RECENT_DAYS} days", n, f, notes)
    for f, n in sorted(unknown.items()):
        add("transcripts", "unknown record type", n, f, notes)
    for k in ANOMALIES[2:]:  # tolerated and repaired by the rules; bad lines and unknown types are reported above
        if anomalies[k]:
            add("transcripts", k, anomalies[k], None, notes)
    from . import summaries  # the list index knows every transcript, read this run or kept from an earlier one
    checked = {"transcriptFiles": len(checks), "filesKnown": max(len(summaries.index()), len(checks)),
               "records": sum(sum(c.get("records", {}).values()) for c in checks), "filesWithoutMessages": empty, "registryFiles": reg["files"],
               "anomalies": dict(anomalies)}
    return warn, notes, checked
