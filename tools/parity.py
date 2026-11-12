#!/usr/bin/env python3
"""Read-only parity check: the server's session data against a direct re-derivation from the raw files (docs/data-model.md); prints counts only.

Usage: python3 tools/parity.py [--id SESSION_ID_OR_PREFIX] [--home DIR]
Never prints message text, titles or paths inside messages: only session id prefixes, field names, counts and lengths.
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIELDS = ("title", "you", "claude", "tools", "results", "quiet", "order", "last", "topic", "tokens", "status", "kind", "automated", "consistency", "lastTool", "lastError", "prOpened",
          "waitingSince", "tokensToday", "prsToday")
DAY_ZONE = ZoneInfo("Asia/Jerusalem")  # the stats panel's day boundaries
WINDOW = 65536  # bytes the resume picker reads from each end of a transcript
SKIP = re.compile(r"^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])")  # prompts the picker passes over
TEXT = 2000  # characters of the latest request and reply the server keeps in a summary
PR_COMMAND = re.compile(r"(?:^|[;&|\s(])gh pr create\b")
PR_LINK = re.compile(r"https://github\.com/([\w.-]+/[\w.-]+)/pull/(\d+)")
ROWS = ("user", "assistant", "system", "attachment")
AUTO_TITLE = re.compile(r"^(side chat|untitled|.+-[0-9a-f]{2})$", re.I)  # the app shows the first request instead of these placeholders
CHAT_NAME_SOURCES = (None, "user", "peer")


def lines(path):
    """Every JSON object line of a file; broken lines are skipped."""
    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if isinstance(r, dict):
                yield r


def ms(ts):
    """ISO timestamp to milliseconds, or None."""
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def content(r):
    """The message content of a row: a string, a list of blocks, or None."""
    m = r.get("message")
    return m.get("content") if isinstance(m, dict) else None


def blocks(r, kind):
    """Blocks of one type in a row's content."""
    c = content(r)
    return [b for b in c if isinstance(b, dict) and b.get("type") == kind] if isinstance(c, list) else []


def is_boundary(r):
    """A compaction boundary row."""
    return r.get("type") == "system" and r.get("subtype") == "compact_boundary"


def counts_as_row(r):
    """Rows that move the 'last row' and 'newest row' marks: main-session rows except file snapshots and fork briefings."""
    if r.get("isSidechain"):
        return False
    if r.get("type") == "system" and r.get("subtype") == "file_snapshot":
        return False
    a = r.get("attachment")
    return not (r.get("type") == "attachment" and isinstance(a, dict) and a.get("type") == "fork_briefing")


def read_file(path):
    """Rows by uuid in first-seen order, their parents, and the checkpoint state at the end of the file."""
    rows, parent, progress = {}, {}, {}
    st = {"last": None, "newest": None, "newest_ts": "", "checkpoint": None, "explicit": False, "cleared": False, "keyed": False,
          "custom": None, "ai": None}
    for r in lines(path):
        t, u = r.get("type"), r.get("uuid")
        if t == "progress" and isinstance(u, str):
            p = r.get("parentUuid")
            progress[u] = progress.get(p, p) if isinstance(p, str) else None
        elif t in ROWS and isinstance(u, str) and u:
            p = r.get("parentUuid") if isinstance(r.get("parentUuid"), str) and r.get("parentUuid") else None
            if p in progress:
                p = progress[p]
            rows[u] = r
            parent[u] = p
            if counts_as_row(r):
                st["last"], st["explicit"], st["cleared"] = u, False, False
                ts = r.get("timestamp") if isinstance(r.get("timestamp"), str) else ""
                if ts > st["newest_ts"]:
                    st["newest"], st["newest_ts"] = u, ts
            if is_boundary(r):
                st["checkpoint"], st["explicit"] = None, False
        elif t == "last-prompt":
            if "leafUuid" in r:
                st["keyed"] = True
            leaf = r.get("leafUuid")
            if isinstance(leaf, str) and leaf:
                st["explicit"] = r.get("explicit") is True or (st["explicit"] and leaf == st["checkpoint"])
                st["checkpoint"], st["cleared"] = leaf, False
            elif "leafUuid" in r and leaf is None and r.get("explicit") is True:
                st["cleared"], st["checkpoint"], st["explicit"] = True, None, False
        elif t == "custom-title" and isinstance(r.get("customTitle"), str):
            st["custom"] = r["customTitle"]
        elif t == "ai-title" and isinstance(r.get("aiTitle"), str):
            st["ai"] = r["aiTitle"]
    return rows, parent, st


def compact(rows, parent):
    """Apply the newest compaction: relink its preserved messages and drop rows written before it; True when relinked."""
    keys = list(rows)
    last_b = max((i for i, u in enumerate(keys) if is_boundary(rows[u])), default=-1)
    meta_b = max((i for i, u in enumerate(keys) if is_boundary(rows[u]) and isinstance(rows[u].get("compactMetadata"), dict)
                  and (rows[u]["compactMetadata"].get("preservedMessages") or rows[u]["compactMetadata"].get("preservedSegment"))), default=-1)
    if meta_b < 0:
        return False
    keep = []
    if meta_b == last_b:
        meta = rows[keys[meta_b]]["compactMetadata"]
        pm = meta.get("preservedMessages")
        if isinstance(pm, dict) and isinstance(pm.get("uuids"), list):
            anchor, keep = pm.get("anchorUuid"), [u for u in pm["uuids"] if isinstance(u, str)]
        else:
            seg = meta.get("preservedSegment") or {}
            walk, cur, seen = [], seg.get("tailUuid"), set()
            while cur in rows and cur not in seen:
                seen.add(cur)
                walk.append(cur)
                if cur == seg.get("headUuid"):
                    break
                cur = parent.get(cur)
            else:
                return False
            anchor, keep = seg.get("anchorUuid"), walk[::-1]
        if any(u not in rows for u in keep):
            return False
        if keep:
            prev = anchor
            for u in keep:
                parent[u], prev = prev, u
            for u in keys:
                if parent.get(u) == anchor and u != keep[0]:
                    parent[u] = keep[-1]
    kept = set(keep)
    gone = {u for i, u in enumerate(keys) if i < last_b and u not in kept}
    for u in gone:
        del rows[u]
        del parent[u]
    if keep and gone:
        for u, r in rows.items():
            if r.get("type") in ("user", "assistant") and parent.get(u) in gone:
                parent[u] = keep[-1]
    return bool(keep)


def descends(parent, a, b):
    """True when row b is an ancestor of row a."""
    seen = set()
    while a and a not in seen:
        if a == b:
            return True
        seen.add(a)
        a = parent.get(a)
    return False


def up_to_message(rows, parent, u):
    """The nearest user or assistant row at or above u."""
    seen = set()
    while u in rows and u not in seen:
        if rows[u].get("type") in ("user", "assistant"):
            return u
        seen.add(u)
        u = parent.get(u)
    return None


def pick_leaf(rows, parent, st, compacted):
    """The user or assistant row the resumed conversation ends at, by the CLI's checkpoint rules."""
    if st["cleared"]:
        return None
    cp, last, explicit = st["checkpoint"], st["last"], st["explicit"]
    rr = last
    if not st["keyed"] and rr and st["newest"] and st["newest"] != rr:
        best, best_ts = rr, ""
        for u, r in rows.items():
            ts = r.get("timestamp") if isinstance(r.get("timestamp"), str) else None
            if not r.get("isSidechain") and u != rr and ts is not None and ts >= best_ts and descends(parent, u, rr):
                best, best_ts = u, ts
        rr = best
    if not compacted or (explicit and cp in rows and not rows[cp].get("isSidechain")):
        start = cp if cp in rows else None
        if start and not explicit and last in rows and last != start and descends(parent, last, start):
            start = last
        if not compacted and start is None:
            start = rr
        leaf = up_to_message(rows, parent, start)
        if leaf:
            return leaf
    named = {p for p in parent.values() if p}
    ua_named = {parent[u] for u, r in rows.items() if r.get("type") in ("user", "assistant") and parent.get(u)}
    leaves = []
    for u in rows:
        if u in named:
            continue
        m = up_to_message(rows, parent, u)
        if m and m not in ua_named and m not in leaves:
            leaves.append(m)
    if len(leaves) > 1:
        pick = cp if cp in leaves else last
        m = up_to_message(rows, parent, pick) if pick in rows else None
        if m:
            return m
    pos = {u: i for i, u in enumerate(rows)}
    newest = lambda us: max(us, key=lambda u: (ms(rows[u].get("timestamp")) or float("-inf"), -pos[u])) if us else None  # noqa: E731
    if leaves:
        return newest(leaves)
    return newest([u for u, r in rows.items() if not r.get("isSidechain") and not (r.get("type") == "system" and r.get("subtype") == "file_snapshot")])


def walk(rows, parent, leaf):
    """Rows from the root (or the compaction boundary) down to the leaf, bridging a missing parent by time (5 s at most)."""
    chain, seen, cur = [], set(), leaf
    order = list(rows)
    while cur:
        if cur in seen:
            break
        seen.add(cur)
        chain.append(cur)
        p = parent.get(cur)
        if not p:
            break
        if p in rows and p not in seen:
            cur = p
            continue
        t, side, cur = ms(rows[cur].get("timestamp")), bool(rows[cur].get("isSidechain")), None
        if t is None:
            break
        best = None
        for u in order:
            r = rows[u]
            tu = ms(r.get("timestamp"))
            if u in seen or bool(r.get("isSidechain")) != side or tu is None or tu > t or (r.get("type") == "system" and r.get("subtype") == "file_snapshot"):
                continue
            if best is None or tu > best[0]:
                best = (tu, u)
        if best and t - best[0] <= 5000:
            cur = best[1]
    return chain[::-1], seen


def holds_part_of(r, mid):
    """Rows that belong to one assistant message's block: its other pieces, tool results, meta rows, attachments, system rows."""
    t = r.get("type")
    if t == "assistant":
        return (r.get("message") or {}).get("id") == mid
    if t == "user":
        return r.get("isMeta") is True or bool(blocks(r, "tool_result"))
    return t == "attachment" or (t == "system" and not is_boundary(r))


def recover(rows, parent, chain, seen):
    """Add the pieces of each assistant message that sit on side branches (parallel tool calls) and their tool results, in file order."""
    pos = {u: i for i, u in enumerate(rows)}
    by_id, results, by_call = {}, {}, {}
    for u, r in rows.items():
        mid = (r.get("message") or {}).get("id") if r.get("type") == "assistant" else None
        if mid:
            by_id.setdefault(mid, []).append(u)
        elif r.get("type") == "user" and blocks(r, "tool_result"):
            if parent.get(u):
                results.setdefault(parent[u], []).append(u)
            for b in blocks(r, "tool_result"):
                if isinstance(b.get("tool_use_id"), str) and b["tool_use_id"]:
                    by_call.setdefault(b["tool_use_id"], []).append(u)
    where = {u: i for i, u in enumerate(chain)}
    spans, done = [], set()
    for u in chain:
        r = rows[u]
        mid = (r.get("message") or {}).get("id") if r.get("type") == "assistant" else None
        if not mid or mid in done:
            continue
        done.add(mid)
        group = by_id.get(mid, [u])
        extra = [g for g in group if g not in seen]
        for g in group:
            extra += [x for x in results.get(g, []) if x not in seen and x not in extra]
            for b in blocks(rows[g], "tool_use"):
                extra += [x for x in by_call.get(b.get("id"), []) if x not in seen and x not in extra]  # a result matched by call id only
        for x in extra:
            seen.add(x)
        start = where[u]
        end = max([start] + [where[g] for g in group if g in where]) + 1
        while end < len(chain) and holds_part_of(rows[chain[end]], mid):
            end += 1
        if extra:
            spans.append([start, end, sorted(extra, key=pos.get)])
    if not spans:
        return chain
    merged = []
    for s in sorted(spans):
        if merged and s[0] < merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], s[1])
            merged[-1][2] = sorted(merged[-1][2] + s[2], key=pos.get)
        else:
            merged.append(s)
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


def tail(rows, parent, leaf, seen):
    """Non-message rows hanging below the leaf (queued prompts written after the last reply), oldest first."""
    kids = {}
    for u, r in rows.items():
        if parent.get(u) and r.get("type") not in ("user", "assistant"):
            kids.setdefault(parent[u], []).append(u)
    out, todo = [], [leaf]
    while todo:
        for k in kids.get(todo.pop(0), []):
            if k not in seen:
                seen.add(k)
                out.append(k)
                todo.append(k)
    return sorted(out, key=lambda u: rows[u].get("timestamp") or "")


def conversation(path):
    """The rows `claude --resume` loads for a session, in display order, plus the title facts."""
    rows, parent, st = read_file(path)
    compacted = compact(rows, parent)
    leaf = pick_leaf(rows, parent, st, compacted)
    if not leaf:
        return [], st
    chain, seen = walk(rows, parent, leaf)
    chain = recover(rows, parent, chain, seen)
    chain += tail(rows, parent, leaf, seen)
    return [rows[u] for u in chain], st


def show(text):
    """User text as the conversation shows it as a prompt; empty when the CLI shows it as output, a note or a marker."""
    text = text.strip()
    if text.startswith("<command-") and "<command-message>" not in text:
        return text  # seen raw on the resumed screen without <command-message> (CLI 2.1.322, case 28)
    if text.startswith("<command-"):
        name = re.search(r"<command-name>(.*?)</command-name>", text, re.S)
        args = re.search(r"<command-args>(.*?)</command-args>", text, re.S)
        if not name:
            return ""
        return (name.group(1).strip() + " " + (args.group(1).strip() if args else "")).strip()
    if text.startswith("<bash-input>"):
        m = re.search(r"<bash-input>(.*?)</bash-input>", text, re.S)
        return "! " + (m.group(1).strip() if m else "")
    for tag in ("task-notification", "bash-stdout", "bash-stderr", "local-command-stdout", "local-command-stderr"):
        if text.startswith("<" + tag):
            return ""
    return "" if text.startswith("[Request interrupted") else text


def origin_kind(o):
    """Kind of an origin object, None when absent."""
    return o.get("kind") if isinstance(o, dict) else None


def texts(c):
    """Text pieces of a string or a block list."""
    if isinstance(c, str):
        return [c]
    return [b.get("text") for b in c if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)] if isinstance(c, list) else []


SILENT = {"Read", "Grep", "Glob", "Agent", "Task", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "NotebookEdit"}  # no result line on success


def screen_line(name, body, error, data):
    """(the CLI prints a non-empty result line, the call is quiet) for one tool result, seen on CLI 2.1.322 in the default view."""
    if error:
        return True, 0
    if name in SILENT or name.startswith("mcp__") or not isinstance(data, dict):
        return bool(body), 1
    if name == "Bash":
        return True, 1  # folded into "Ran N shell commands" (CLI 2.1.322, cases 27 and 46)
    if name in ("Edit", "MultiEdit", "Write") and not (name == "Write" and data.get("type") != "update"):
        hunks = data.get("structuredPatch") if isinstance(data.get("structuredPatch"), list) else []
        return any(isinstance(h, dict) and h.get("lines") for h in hunks), 0
    if name in ("Bash", "Write") or (name == "WebFetch" and isinstance(data.get("bytes"), int)) or (name == "WebSearch" and isinstance(data.get("results"), list)):
        return True, 0  # output, "Done" or "(No output)"; Write, Fetch and Web Search print a summary line
    return bool(body), 0


def events(conv):
    """Display events: you, claude, tool (id, has_result, name), error (per tool result), out (text, is_error), compact, interrupt, image."""
    out, tools = [], {}
    for r in conv:
        t = r.get("type")
        if t == "assistant":
            for b in content(r) if isinstance(content(r), list) else []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and isinstance(b.get("text"), str) and b["text"].strip():
                    out.append(["claude", b["text"].strip()])
                elif b.get("type") == "tool_use":
                    tools[b.get("id")] = len(out)
                    out.append(["tool", b.get("id"), False, b.get("name") if isinstance(b.get("name"), str) and b.get("name") else "Tool", 0, False])
        elif t == "user":
            if r.get("isMeta") or r.get("isCompactSummary"):
                continue
            res = blocks(r, "tool_result")
            out += [["error", bool(b.get("is_error"))] for b in res]
            for b in res:
                i = tools.get(b.get("tool_use_id"))
                if i is not None:
                    body = b.get("content")
                    body = (body if isinstance(body, str) else "\n".join(texts(body))).strip()
                    out[i][2], out[i][4] = screen_line(out[i][3], body, bool(b.get("is_error")), r.get("toolUseResult") if len(res) == 1 else None)
                    out[i][5] = True
            if res:
                continue
            said = 0
            for x in texts(content(r)):
                x = x.strip()
                m = re.match(r"<(bash|local-command)-std(?:out|err)", x)
                if m:
                    std = re.findall(f"<{m.group(1)}-stdout>(.*?)</{m.group(1)}-stdout>", x, re.S)
                    err = re.findall(f"<{m.group(1)}-stderr>(.*?)</{m.group(1)}-stderr>", x, re.S)
                    std, err = (std[0].strip() if std else ""), (err[0].strip() if err else "")
                    if std or err:
                        out.append(["out", "\n".join(y for y in (std, err) if y), bool(err)])
                elif x.startswith("[Request interrupted"):
                    out.append(["interrupt"])
                elif show(x):
                    out.append(["you", show(x)])
                    said += 1
            pics = len(blocks(r, "image"))
            out += [["image"]] * pics if said else [["you", "[Image]"]] if pics else []
        elif is_boundary(r):
            out.append(["compact"])
        elif t == "attachment":
            a = r.get("attachment")
            if not isinstance(a, dict) or a.get("type") != "queued_command" or a.get("isMeta") or a.get("commandMode", "prompt") != "prompt":
                continue
            if origin_kind(a.get("origin")) not in (None, "human"):
                continue
            out += [["you", s] for s in (show(x) for x in texts(a.get("prompt"))) if s]
    return out


def tag_text(text, name):
    """Inside of the first non-empty <name>...</name> (attributes allowed on the opening tag), or None."""
    for m in re.finditer("<" + name + r"(?=[\s>])[^>]*>(.*?)</" + name + ">", text, re.S | re.I):
        if m.group(1):
            return m.group(1)
    return None


def unpaste(text):
    """Replace each well-formed pasted block (4 hex digit id, body on its own lines) by its body, dropping up to two newlines around it."""
    out, pos = "", 0
    while True:
        i = text.find('<pasted_content id="', pos)
        if i < 0:
            return out + text[pos:]
        pid = text[i + 20:i + 24]
        body = i + 27
        if not re.fullmatch(r"[0-9a-f]{4}", pid) or text[i + 24:body] != '">\n':
            out, pos = out + text[pos:i + 1], i + 1
            continue
        close = text.find('\n</pasted_content id="' + pid + '">', body - 1)
        if close < 0:
            return out + text[pos:]
        start = i
        while start > pos and i - start < 2 and text[start - 1] == "\n":
            start -= 1
        end = close + 1 + len('</pasted_content id="' + pid + '">')
        for _ in range(2):
            end += text.startswith("\n", end)
        out, pos = out + text[pos:start] + text[body:max(body, close)], end


def drop_elements(text):
    """Remove <tag ...>...</tag> elements whose closing tag follows the opening (and one newline after), the picker's title cleaning."""
    res, pos, i = "", 0, text.find("<")
    while i >= 0:
        m = re.match(r"<([a-z][A-Za-z0-9_-]*)(>|\s[^>]*>)", text[i:])
        j = text.find("</" + m.group(1) + ">", i + m.end()) if m else -1
        if j < 0:
            i = text.find("<", i + 1)
            continue
        res += text[pos:i]
        pos = j + len(m.group(1)) + 3
        if text[pos:pos + 1] == "\n":
            pos += 1
        i = text.find("<", pos)
    return res + text[pos:]


def pasted_words(text):
    """Typed words around pasted wrappers the picker leaves raw; the pasted text itself when nothing else was typed."""
    if "<pasted_content" not in text:
        return text
    wrap = r"<pasted_content(?:\s[^>]*)?>(.*?)</pasted_content(?:\s[^>]*)?>"
    rest = " ".join(re.sub(wrap, " ", text, flags=re.S).split())
    return rest or re.sub(wrap, lambda m: m.group(1), text, flags=re.S).strip()


def first_prompt(path):
    """The picker's first prompt: (text, first slash command without arguments, saw a <tick> prompt), over user rows in file order."""
    cmd, tick = None, False
    for r in lines(path):
        if r.get("type") != "user" or r.get("isMeta") is True or r.get("isCompactSummary") is True or blocks(r, "tool_result"):
            continue
        for x in texts(content(r)):
            if not x:
                continue
            x = unpaste(x).replace("\n", " ").strip()
            name = tag_text(x, "command-name")
            if name:
                args = (tag_text(x, "command-args") or "").strip()
                if args:
                    return name + " " + args, cmd, tick
                cmd = cmd or name
                continue
            sh = tag_text(x, "bash-input")
            if sh:
                return "! " + sh, cmd, tick
            if SKIP.match(x):
                tick = tick or x.startswith("<tick>")
                continue
            return (x[:200].strip() + "\u2026" if len(x) > 200 else x), cmd, tick
    return None, cmd, tick


def last_prompt(path):
    """The last lastPrompt string value in the file's last WINDOW bytes, or None."""
    with open(path, "rb") as fh:
        fh.seek(max(0, os.path.getsize(path) - WINDOW))
        tail = fh.read().decode("utf-8", "replace")
    found = re.findall(r'"lastPrompt": ?"((?:[^"\\]|\\.)*)"', tail)
    return json.loads('"' + found[-1] + '"') if found else None


def prompt_title(path):
    """(prompt words the app names an untitled session by, what the picker shows when there are none)."""
    first, cmd, tick = first_prompt(path)
    raw = last_prompt(path) or first or cmd or ("Proactive session" if tick else "")
    if not raw:
        return "", "(session)"
    if raw.startswith("<tick>"):
        return "", "Autonomous session"
    return without_tags(pasted_words(drop_elements(unpaste(raw)).strip())), os.path.basename(path)[:8]


def without_tags(text):
    """The app's own step beyond the picker: no tag in a title; words outside elements, else the text inside them."""
    name = r"[A-Za-z]\w*[-_][\w-]*"  # wrapper names hold a hyphen or underscore; typed text such as <b> or Vec<T> stays
    whole = r"<(" + name + r")(?:\s[^<>]*)?>.*?</\1(?:\s[^<>]*)?>"
    tag = r"</?" + name + r"(?:\s[^<>]*)?/?>|<" + name + r"(?:\s[^<>]*)?$"
    rest = " ".join(re.sub(tag, " ", re.sub(whole, " ", text, flags=re.S)).split())
    return rest or " ".join(re.sub(tag, " ", text).split())


def one_line(text, n):
    """Text on one line, whitespace runs as one space, cut at a word boundary with an ellipsis."""
    line = " ".join((text or "").split())
    return line if len(line) <= n else line[:n].rsplit(" ", 1)[0] + "\u2026"


def today_numbers(path, conv, now):
    """(tokens, pull requests) of the shown conversation whose row time is on now's day in the stats time zone."""
    sid, day = os.path.basename(path)[:-6], datetime.fromtimestamp(now, DAY_ZONE).date()
    on = lambda t: t is not None and datetime.fromtimestamp(t / 1000, DAY_ZONE).date() == day  # noqa: E731
    last = {}
    for r in conv:
        m = r.get("message") if isinstance(r.get("message"), dict) else {}
        if (r.get("type") == "assistant" and r.get("sessionId", sid) == sid and isinstance(m.get("id"), str) and m["id"]
                and isinstance(m.get("usage"), dict) and ms(r.get("timestamp")) is not None):
            last[m["id"]] = r
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0  # noqa: E731
    tok = sum(num(u.get("input_tokens")) + num(u.get("output_tokens")) + num(u.get("cache_creation_input_tokens"))
              for u in (r["message"]["usage"] for r in last.values() if on(ms(r.get("timestamp")))))
    return tok, sum(1 for t in pr_times(conv).values() if on(t))


def tokens(path):
    """Tokens spent by this session's own main-session assistant messages, once per message id (its last line)."""
    sid, seen = os.path.basename(path)[:-6], {}
    for r in lines(path):
        if r.get("type") != "assistant" or r.get("isSidechain") or r.get("sessionId", sid) != sid:
            continue
        m = r.get("message") if isinstance(r.get("message"), dict) else {}
        u = m.get("usage")
        if isinstance(m.get("id"), str) and m["id"] and isinstance(u, dict):
            seen[m["id"]] = u
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0  # noqa: E731
    return sum(num(u.get("input_tokens")) + num(u.get("output_tokens")) + num(u.get("cache_creation_input_tokens")) for u in seen.values())


def entry_kind(path):
    """headless when every row with an entrypoint came from the headless CLI (sdk-cli), else interactive."""
    seen = {r.get("entrypoint") for r in lines(path) if r.get("type") in ROWS and isinstance(r.get("entrypoint"), str) and r.get("entrypoint")}
    return "headless" if "sdk-cli" in seen and not seen & {"cli", "c" + "laude-desktop"} else "interactive"


def automated(path):
    """Nobody typed: headless only, or every main prompt row (not meta, summary or tool result) has turnOrigin sdk."""
    seen = {str(r.get("turnOrigin") or "none") for r in lines(path) if r.get("type") == "user" and not r.get("isSidechain") and not r.get("isMeta")
            and not r.get("isCompactSummary") and not blocks(r, "tool_result")}
    return entry_kind(path) == "headless" or seen == {"sdk"}


def consistency(path, conv):
    """diverged when another program wrote a branch off the shown rows that holds a prompt or reply the conversation leaves out."""
    rows, parent, _ = read_file(path)
    compact(rows, parent)
    names = {"c" + "laude-desktop": "desktop app", "cli": "terminal", "sdk-cli": "terminal"}
    shown = {r.get("uuid") for r in conv}
    mine = next((names.get(r.get("entrypoint"), "") for r in reversed(conv) if r.get("type") in ("user", "assistant") and r.get("entrypoint")), "")
    for u, r in rows.items():
        if u in shown or r.get("isSidechain") or r.get("type") not in ("user", "assistant") or not mine or names.get(r.get("entrypoint"), mine) == mine:
            continue
        cur, seen = parent.get(u), set()
        while cur and cur not in shown and cur not in seen:
            seen.add(cur)
            cur = parent.get(cur)
        if cur in shown and any(e[0] in ("you", "claude") for e in events([r])):
            return "diverged"
    return "ok"


def pr_times(rows):
    """Pull requests opened on these rows: {link: time (ms) of the earliest call that opened it}, by the stats rule."""
    asked, seen, links = {}, set(), {}
    for r in rows:
        if r.get("type") not in ("user", "assistant") or ms(r.get("timestamp")) is None:
            continue
        if r.get("type") == "assistant":
            for b in blocks(r, "tool_use"):
                tid, name = b.get("id"), b.get("name") if isinstance(b.get("name"), str) else ""
                if not isinstance(tid, str) or not tid or tid in seen:
                    continue
                seen.add(tid)
                inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                cmd = str(inp.get("command") or "") if name == "Bash" else ""
                if PR_COMMAND.search(cmd):
                    asked[tid] = ("cmd", ms(r.get("timestamp")))
                elif "pull_request_create" in name or "create_pull_request" in name:
                    asked[tid] = ("tool", ms(r.get("timestamp")))
            continue
        for b in blocks(r, "tool_result"):
            tid = b.get("tool_use_id")
            if tid not in asked:
                continue
            how, when = asked.pop(tid)
            body = b.get("content")
            body = body if isinstance(body, str) else "\n".join(texts(body))
            if b.get("is_error") or "already exists" in body:
                continue
            found = PR_LINK.findall(body) if how == "cmd" else [(tid, "")]
            if found:
                links[found[-1]] = min(links.get(found[-1], when), when)
    return links


def prs_opened(path):
    """Pull requests opened in the whole main file, by the stats rule (a failed or already-existing one does not count)."""
    return len(pr_times(lines(path)))


def process_starts(pids):
    """Start time of each running pid as `ps` prints it in UTC; empty when ps is unavailable."""
    if not pids:
        return {}
    try:
        out = subprocess.run(["ps", "-o", "pid=,lstart=", "-p", ",".join(str(p) for p in pids)], capture_output=True, text=True, timeout=5,
                             env={"TZ": "UTC", "LC_ALL": "C", "PATH": "/bin:/usr/bin"}).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    starts = {}
    for line in out.splitlines():
        bits = line.split(None, 1)
        if len(bits) == 2 and bits[0].isdigit():
            starts[int(bits[0])] = " ".join(bits[1].split())
    return starts


def registry(home):
    """Live holders per session: running pid, same process as the file says, not a parked job."""
    entries = []
    for p in glob.glob(os.path.join(glob.escape(home), "sessions", "*.json")):
        try:
            with open(p) as fh:
                o = json.load(fh)
        except (OSError, ValueError):
            continue
        if isinstance(o, dict) and isinstance(o.get("pid"), int) and not isinstance(o.get("pid"), bool) and o.get("parkedJobId") is None:
            entries.append(o)
    alive = []
    for o in entries:
        try:
            os.kill(o["pid"], 0)
        except (OSError, OverflowError):
            continue
        alive.append(o)
    starts = process_starts([o["pid"] for o in alive])
    out = {}
    for o in alive:
        want = o.get("procStart")
        if isinstance(want, str) and starts and starts.get(o["pid"]) is not None and starts[o["pid"]] != " ".join(want.split()):
            continue
        out.setdefault(o.get("sessionId"), []).append(o)
    return out


def expected(path, hold, brief, now=None):
    """Every checked field, derived straight from the files; brief is the page's one-line cut, the only server code used here."""
    conv, st = conversation(path)
    ev = events(conv)
    sid = os.path.basename(path)[:-6]
    procs = hold.get(sid, [])
    status = "running" if any(p.get("status") == "busy" for p in procs) else "waiting" if procs else "done"
    names = [p for p in sorted(procs, key=lambda p: p.get("statusUpdatedAt") or 0) if p.get("nameSource") in CHAT_NAME_SOURCES and isinstance(p.get("name"), str)]
    title = without_tags(st["custom"] or st["ai"] or (names[-1]["name"] if names else None) or "") or None
    words, fallback = prompt_title(path)
    if not title or AUTO_TITLE.match(title):
        title = one_line(words, 60) or title or fallback
    else:
        title = title[:80]
    today = today_numbers(path, conv, time.time() if now is None else now)
    errs = [e[1] for e in ev if e[0] == "error"]
    ev = [e for e in ev if e[0] != "error"]
    if ev and ev[-1][0] == "tool" and not ev[-1][5] and not procs:
        ev.append(["interrupt"])  # a call left without a result at the end: the CLI prints "Interrupted" under it when nothing runs it (case 55)
    you = [e[1] for e in ev if e[0] == "you"]
    claude = [e[1] for e in ev if e[0] == "claude"]
    called = [e[3] for e in ev if e[0] == "tool"]
    replies = [r for r in conv if r.get("type") == "assistant"]
    end = int(ms(replies[-1].get("timestamp")) or 0) if replies else 0
    at = max((p.get("statusUpdatedAt") for p in procs if isinstance(p.get("statusUpdatedAt"), (int, float))), default=0)
    return {"title": title, "you": len(you), "claude": len(claude), "tools": sum(1 for e in ev if e[0] == "tool"),
            "results": sum(1 for e in ev if e[0] == "tool" and e[2]), "quiet": sum(1 for e in ev if e[0] == "tool" and e[4]), "order": [e[0] for e in ev],
            "last": claude[-1][:TEXT] if claude else "", "topic": you[-1][:TEXT] if you else "", "tokens": tokens(path), "status": status, "tokensToday": today[0], "prsToday": today[1],
            "kind": entry_kind(path), "automated": automated(path), "consistency": consistency(path, conv), "lastTool": called[-1] if called else "", "lastError": errs[-1] if errs else False, "prOpened": prs_opened(path),
            "waitingSince": max(end, int(at) if status == "waiting" else 0)}


def actual(path, sessions, lv, now=None):
    """The same fields as the server computes them."""
    d = sessions.parse(path)
    day = d["days"].get(sessions.day_of(time.time() if now is None else now), [0, 0])
    evs, _ = sessions.transcript(path)
    sid = os.path.basename(path)[:-6]
    status, at, name = lv.get(sid, ("done", 0, None))
    return {"title": sessions.mission(d, name), "you": sum(1 for e in evs if e[0] == "you"), "claude": sum(1 for e in evs if e[0] == "claude"),
            "tools": sum(1 for e in evs if e[0] == "tool"), "results": sum(1 for e in evs if e[0] == "tool" and e[3]), "quiet": sum(1 for e in evs if e[0] == "tool" and e[6]),
            "order": [e[0] for e in evs if e[0] != "elsewhere"], "last": d.get("last") or "", "topic": d.get("you") or "", "tokens": d.get("tokens", 0),
            "status": "running" if status == "busy" else "waiting" if status != "done" else "done", "kind": d["kind"], "automated": d["automated"], "consistency": d["consistency"], "lastTool": d["lastTool"],
            "lastError": d["lastError"], "prOpened": d["prOpened"], "waitingSince": sessions.waiting_since(d, (status, at)),
            "tokensToday": day[0], "prsToday": day[1]}


def describe(field, want, got):
    """Counts-only description of one difference."""
    if field == "order":
        i = next((k for k, (a, b) in enumerate(zip(want, got)) if a != b), min(len(want), len(got)))
        return f"events {len(want)} vs {len(got)}, first difference at {i}"
    if field in ("title", "last", "topic"):
        return f"length {len(want)} vs {len(got)}"
    return f"{want} vs {got}"


def hidden_reason(r):
    """Why a row of the shown conversation prints nothing, or None when it prints something."""
    t = r.get("type")
    if r.get("isMeta"):
        return "meta (injected text)"
    if r.get("isCompactSummary"):
        return "compaction summary"
    if t == "system":
        return None if is_boundary(r) else "system note"
    if t == "attachment":
        a = r.get("attachment")
        return None if isinstance(a, dict) and a.get("type") == "queued_command" else "attachment"
    c = content(r)
    texts = [c] if isinstance(c, str) else [b.get("text") for b in blocks(r, "text") if isinstance(b.get("text"), str)]
    if t == "assistant":
        return None if any(x.strip() for x in texts) or blocks(r, "tool_use") else "thinking only"
    if blocks(r, "tool_result") or blocks(r, "image"):
        return None
    if all(not x.strip() or x.lstrip().startswith("<task-notification") for x in texts):
        return "task notification or empty"
    return None


def report(paths, home):
    """Counts-only data-quality page: classes, programs, CLI versions, record types, anomalies, display rules and hidden rows."""
    sys.path.insert(0, ROOT)
    from desk import sessions, transcripts  # noqa: E402
    live = set(registry(home))
    classes, entry, versions, newest, types, rules, hidden = Counter(), Counter(), Counter(), Counter(), Counter(), Counter(), Counter()
    for p in paths:
        sid = os.path.basename(p)[:-6]
        classes["live" if sid in live else "automated" if automated(p) else "typed"] += 1
        seen_e, seen_v, kids, flags = set(), "", Counter(), set()
        for r in lines(p):
            t = r.get("type")
            types[str(t)[:40]] += 1
            if isinstance(r.get("entrypoint"), str):
                seen_e.add(r["entrypoint"])
            if isinstance(r.get("version"), str):
                versions[r["version"][:20]] += 1
                seen_v = r["version"][:20]
            if is_boundary(r):
                flags.add("compaction")
            a = r.get("attachment")
            if t == "attachment" and isinstance(a, dict) and a.get("type") == "queued_command":
                flags.add("queued prompts")
            if t == "user" and not r.get("isSidechain"):
                if blocks(r, "image"):
                    flags.add("images")
                c = content(r)
                text = c if isinstance(c, str) else " ".join(b.get("text", "") for b in blocks(r, "text") if isinstance(b.get("text"), str))
                if "<bash-input>" in text:
                    flags.add("! commands")
                if "<command-name>" in text:
                    flags.add("slash commands")
                if not blocks(r, "tool_result") and not r.get("isMeta") and isinstance(r.get("parentUuid"), str):
                    kids[r["parentUuid"]] += 1
        if any(n > 1 for n in kids.values()):
            flags.add("branching (two prompts on one row)")
        for e in seen_e or {"(none)"}:
            entry[e] += 1
        newest[seen_v or "(none)"] += 1
        rules.update(flags)
        t = transcripts.load(p, fresh=True)
        conv = transcripts.conversation(t)
        rows = {u: r.body() for u, r in t.rows.items()}  # whole rows: the app keeps them slim
        shown = {r.uuid for r in conv}
        for u, r in rows.items():
            if u in shown:
                why = hidden_reason(r)
                if why:
                    hidden[why] += 1
            elif r.get("isSidechain"):
                hidden["subagent row"] += 1
            else:
                hidden["other branch or before a compaction"] += 1
        hidden["dropped by compaction"] += len({r["uuid"] for r in lines(p) if r.get("type") in ROWS and isinstance(r.get("uuid"), str) and r["uuid"] not in t.rows})
    _, _, checked = transcripts.format_report()

    def block(title, c):
        """Print one counted section, largest first."""
        print(f"{title}:")
        for k, n in sorted(c.items(), key=lambda x: (-x[1], str(x[0]))):
            print(f"  {k:<40} {n}")

    print(f"sessions: {len(paths)}")
    block("sessions by class", classes)
    block("sessions by program (entrypoint)", entry)
    block("sessions by newest CLI version", newest)
    block("records by CLI version", versions)
    block("records by type", types)
    block("anomalies", Counter(checked["anomalies"]))
    block("sessions using a display rule", rules)
    block("rows hidden, by reason", hidden)
    return 0


def main():
    """Check every session (or one) and print the totals."""
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--id", help="session id or prefix")
    ap.add_argument("--home", help="data folder (default: DESK_CLAUDE_DIR or ~/.claude)")
    ap.add_argument("--limit", type=int, default=40, help="mismatch lines to print")
    ap.add_argument("--report", action="store_true", help="print the data-quality report (counts only) instead of checking")
    args = ap.parse_args()
    if args.home:
        os.environ["DESK_CLAUDE_DIR"] = args.home
    sys.path.insert(0, ROOT)
    from desk import config, sessions, transcripts  # noqa: E402
    home = config.HOME
    paths = sorted(transcripts.session_paths())
    if args.id:
        paths = [p for p in paths if os.path.basename(p).startswith(args.id)]
    if args.report:
        return report(paths, home)
    hold = registry(home)
    lv = sessions.live(sessions.holders())
    bad, lines_out, ok = Counter(), [], 0
    for p in paths:
        sid = os.path.basename(p)[:-6]
        now = time.time()
        want, got = expected(p, hold, sessions.brief, now), actual(p, sessions, lv, now)
        diffs = [f for f in FIELDS if want[f] != got[f]]
        if not diffs:
            ok += 1
        for f in diffs:
            bad[f] += 1
            lines_out.append(f"  {sid[:8]}  {f:<7} expected {describe(f, want[f], got[f])}")
    print(f"sessions checked: {len(paths)}")
    print(f"matching:         {ok}")
    print(f"mismatching:      {len(paths) - ok}")
    for f in FIELDS:
        print(f"  {f:<8} {bad[f]}")
    if lines_out:
        print(f"first {min(args.limit, len(lines_out))} of {len(lines_out)} differences (expected vs server):")
        print("\n".join(lines_out[:args.limit]))
    return 0 if ok == len(paths) else 1


if __name__ == "__main__":
    sys.exit(main())
