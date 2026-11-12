"""Slim rows (no bodies kept, re-read by offset) answer exactly what whole rows answer: fixtures, random chunking, random trees, stale files, memory."""
import glob
import json
import os
import random
import shutil
import sys
import tempfile
import threading
import tracemalloc
import unittest

from helpers import ROOT, reset
from desk import config, sessions, transcripts as tx

sys.path.insert(0, os.path.join(ROOT, "tools"))
import scale_home  # noqa: E402

SOURCES = sorted(glob.glob(os.path.join(ROOT, "tests", "fixtures", "*", "projects", "*", "*.jsonl")))
RANDOM_CASES = int(os.environ.get("SLIM_CASES", "5000"))


def answers(path, slim):
    """Summary, sidebar events and the load facts of one transcript, read whole with slim rows on or off."""
    saved, tx.SLIM = tx.SLIM, slim
    try:
        tx._states.clear()
        sessions._cache.clear()
        sessions._full.clear()
        sessions._folds.clear()
        d = sessions.parse(path)
        ev = sessions.transcript(path)
        t = tx.load(path, fresh=True)
        conv = tx.conversation(t)
        return d, ev, [r.uuid for r in conv], sorted(tx.prs_on(conv).items()), tx.elsewhere(t, conv), tx.view(conv)
    finally:
        tx.SLIM = saved
        tx._states.clear()  # no state of the other row kind is left for the next read
        sessions._cache.clear()
        sessions._full.clear()
        sessions._folds.clear()


def r_cut(r, n):
    """A cut point: the middle, or near the end so the second part is a few rows."""
    return n // 2 if r.random() < 0.5 else max(1, n - r.randrange(1, 600))


def ts(r, base, k):
    """A timestamp k seconds after base, now and then out of order."""
    import time
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(base + k + (r.choice((0, 0, 0, -30)))))


def random_tree(r):
    """Lines of an invented transcript with branches, compactions, checkpoints, replaced rows, sidechains, progress lines, queued prompts and PR calls."""
    out, ids, base, k = [], [], 1_790_000_000 + r.randrange(10 ** 6), 0
    entry = r.choice(("cli", "claude-desktop", "sdk-cli"))

    def row(kind, parent, **extra):
        """Append one row and return its uuid."""
        nonlocal k
        k += r.choice((1, 1, 2, 9))
        u = r.choice(ids) if ids and r.random() < 0.04 else f"u{len(out)}-{r.getrandbits(20):05x}"  # now and then a row replacing an earlier uuid
        d = {"type": kind, "uuid": u, "parentUuid": parent, "timestamp": ts(r, base, k), "isSidechain": r.random() < 0.05, "sessionId": "s",
             "entrypoint": entry if r.random() < 0.9 else r.choice(("cli", "claude-desktop")), "cwd": "/w", "gitBranch": "main"}
        d.update(extra)
        out.append(d)
        ids.append(u)
        return u

    cur = None
    for _ in range(r.randrange(3, 40)):
        x = r.random()
        parent = cur if r.random() < 0.85 or not ids else r.choice(ids)
        if x < 0.25:
            text = r.choice(("hello there", "  spaced  ", "<command-message>x</command-message><command-name>/x</command-name><command-args>a</command-args>",
                             "<bash-input>ls</bash-input>", "<bash-stdout>a\nb\nc\nd\ne</bash-stdout><bash-stderr></bash-stderr>",
                             "[Request interrupted by user]", "w " * r.randrange(1, 400)))
            cur = row("user", parent, message={"role": "user", "content": text if r.random() < 0.5 else [{"type": "text", "text": text}]},
                      isMeta=r.random() < 0.05, turnOrigin=r.choice(("human", "sdk")))
        elif x < 0.5:
            mid = f"m{r.randrange(8)}"
            tid = f"t{r.randrange(30)}"
            block = r.choice(({"type": "text", "text": "reply " * r.randrange(1, 500)}, {"type": "thinking", "thinking": "hm"},
                              {"type": "tool_use", "id": tid, "name": "Bash", "input": {"command": r.choice(("ls", "gh pr create -t x"))}},
                              {"type": "tool_use", "id": tid, "name": "mcp__gh__create_pull_request", "input": {"q": 1}},
                              {"type": "tool_use", "id": tid, "name": "Edit", "input": {"file_path": "/w/a.py"}}))
            cur = row("assistant", parent, message={"id": mid, "role": "assistant", "model": "m", "content": [block],
                                                    "usage": {"input_tokens": r.randrange(9), "output_tokens": 3}, **({"stop_reason": "end_turn"} if r.random() < 0.5 else {})})
        elif x < 0.65:
            tid = f"t{r.randrange(30)}"
            body = r.choice(("ok", "https://github.com/o/r/pull/7", "already exists https://github.com/o/r/pull/8", "x\n" * r.randrange(1, 50)))
            cur = row("user", parent, message={"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": body, "is_error": r.random() < 0.1}]},
                      toolUseResult={"stdout": body, "stderr": "", "structuredPatch": [{"oldStart": 1, "newStart": 1, "lines": ["-a", "+b"]}], "big": "z" * 50})
        elif x < 0.72:
            cur = row("attachment", parent, attachment=r.choice(({"type": "queued_command", "prompt": "queued words"}, {"type": "hook_success", "content": "ok"},
                                                                  {"type": "fork_briefing"})))
        elif x < 0.78:
            keep = r.sample(ids, min(len(ids), r.randrange(0, 3)))
            meta = r.choice(({"preservedMessages": {"anchorUuid": "", "uuids": keep}}, {"preservedSegment": {"headUuid": keep[0] if keep else "", "tailUuid": keep[-1] if keep else "", "anchorUuid": ""}}, {}))
            b = row("system", None, subtype="compact_boundary", compactMetadata=meta)
            if meta.get("preservedMessages") is not None:
                meta["preservedMessages"]["anchorUuid"] = b
            cur = row("user", b, message={"role": "user", "content": "summary"}, isCompactSummary=True, isVisibleInTranscriptOnly=r.random() < 0.5)
        elif x < 0.86:
            leaf = r.choice(ids + [None]) if ids else None
            out.append({"type": "last-prompt", "leafUuid": leaf, "lastPrompt": "lp words", **({"explicit": True} if r.random() < 0.3 else {})})
        elif x < 0.9:
            u = f"p{len(out)}"
            out.append({"type": "progress", "uuid": u, "parentUuid": parent})
            cur = u
        elif x < 0.93:
            out.append({"type": "custom-title", "customTitle": r.choice(("named", ""))})
        else:
            cur = row("system", parent, subtype=r.choice(("turn_duration", "file_snapshot", "api_error")))
    return "".join(json.dumps(d) + "\n" for d in out)


class SlimTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-slim-")
        self.dir = os.path.join(self.tmp, "projects", "-work-slim")
        os.makedirs(self.dir)
        self.saved, config.HOME = config.HOME, self.tmp
        reset()
        tx._states.clear()

    def tearDown(self):
        config.HOME = self.saved
        tx.SLIM = True
        reset()
        tx._states.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def put(self, data, name="c0ffee00-0000-4000-8000-000000000001.jsonl"):
        """Write a transcript into the scratch home."""
        p = os.path.join(self.dir, name)
        with open(p, "wb") as fh:
            fh.write(data if isinstance(data, bytes) else data.encode())
        return p

    def test_every_fixture_equals_the_whole_row_path(self):
        self.assertGreater(len(SOURCES), 20)
        for src in SOURCES:
            with open(src, "rb") as fh:
                p = self.put(fh.read(), os.path.basename(src))
            self.assertEqual(answers(p, True), answers(p, False), os.path.basename(src))

    def test_random_chunks_equal_the_whole_row_path(self):
        rnd = random.Random(11)
        for src in SOURCES:
            with open(src, "rb") as fh:
                data = fh.read()
            p = self.put(b"", os.path.basename(src))
            tx._states.clear()
            at = 0
            while at < len(data):
                step = rnd.choice((1, 13, 120, 900, len(data)))
                with open(p, "ab") as fh:
                    fh.write(data[at:at + step])
                at += step
                sessions._cache.clear()
                sessions._full.clear()
                grown = (sessions.parse(p), sessions.transcript(p))
                self.assertIn(p, tx._states)
                want = answers(p, False)
                self.assertEqual(grown, want[:2], f"{os.path.basename(src)} at {at}")

    def test_random_trees_equal_the_whole_row_path(self):
        rnd = random.Random(5)
        for n in range(RANDOM_CASES):
            text = random_tree(rnd)
            p = self.put(text)
            self.assertEqual(answers(p, True), answers(p, False), f"case {n}")
            if n % 4 == 0:  # appended in two parts, the second read from the kept state and folded onto the first part's list and sidebar
                cut = text.rfind("\n", 0, r_cut(rnd, len(text))) + 1
                p = self.put(text[:cut])
                tx._states.clear()
                sessions._cache.clear()
                sessions._full.clear()
                sessions.parse(p)
                sessions.transcript(p)
                with open(p, "a") as fh:
                    fh.write(text[cut:])
                sessions._cache.clear()
                sessions._full.clear()
                self.assertEqual((sessions.parse(p), sessions.transcript(p)), answers(p, False)[:2], f"case {n} appended")

    def test_appends_fold_only_their_rows_and_named_cases_rebuild(self):
        rnd, calls = random.Random(4), []
        real = sessions._side_tail

        def spy(*a):
            """Record whether the sidebar folded onto its kept events."""
            out = real(*a)
            calls.append(out[0] is not None)
            return out
        base, last = "", None
        for n in range(6):
            text, last = scale_home.turn(rnd, n, 1_790_000_000 + n * 60, "/w", last, 300, "cli", False)
            base += text
        row = lambda **k: json.dumps(dict({"isSidechain": False, "sessionId": "x", "cwd": "/w", "entrypoint": "cli", "timestamp": "2026-09-22T10:00:00.000Z"}, **k)) + "\n"
        turn = scale_home.turn(rnd, 99, 1_790_001_000, "/w", last, 300, "cli", False)[0]
        first = base.split("\n")[0]
        cases = {  # appended text -> whether the sidebar may fold onto its kept events
            "turn": (turn, True),
            "orphan root": (row(type="system", subtype="turn_duration", uuid="o1", parentUuid=None), True),
            "checkpoint to a branch": (row(type="user", uuid="b1", parentUuid=json.loads(first)["uuid"], message={"role": "user", "content": "other"})
                                       + json.dumps({"type": "last-prompt", "leafUuid": "b1"}) + "\n", False),
            "compaction": (row(type="system", subtype="compact_boundary", uuid="c1", parentUuid=None, compactMetadata={})
                           + row(type="user", uuid="c2", parentUuid="c1", isCompactSummary=True, message={"role": "user", "content": "sum"}), False),
            "replaced uuid": (first + "\n", False),
            "missing parent off the path": (row(type="user", uuid="m1", parentUuid="gone", timestamp="2026-09-22T10:00:01.000Z",
                                                message={"role": "user", "content": "hi"}), True),
            "bridged on the path": (row(type="user", uuid="m2", parentUuid="gone", timestamp="2026-09-22T10:00:01.000Z", message={"role": "user", "content": "hi"})
                                    + json.dumps({"type": "last-prompt", "leafUuid": "m2"}) + "\n", False),
            "rewind": (json.dumps({"type": "last-prompt", "leafUuid": None, "explicit": True}) + "\n", False),
            "continued-in": (json.dumps({"type": "continued-in", "continuedInSessionId": "c0ffee00-0000-4000-8000-0000000000ee"}) + "\n", True),
            "other program": (row(type="user", uuid="d1", parentUuid=last, entrypoint="claude-desktop", message={"role": "user", "content": "from the app"}), True),
        }
        walk = {"turn": "extend", "orphan root": "extend", "checkpoint to a branch": "build", "compaction": "build", "replaced uuid": "build",
                "missing parent off the path": "extend", "bridged on the path": "build", "rewind": "build", "continued-in": "same", "other program": "extend"}
        sessions._side_tail = spy
        try:
            for name, (more, fold) in cases.items():
                p = self.put(base)
                tx._states.clear()
                sessions._cache.clear()
                sessions._full.clear()
                sessions._folds.clear()
                sessions.parse(p)
                sessions.transcript(p)
                with open(p, "a") as fh:
                    fh.write(more)
                sessions._cache.clear()
                sessions._full.clear()
                del calls[:]
                tx._memo_counts.clear()
                d = sessions.parse(p)
                self.assertEqual(list(tx._memo_counts), [walk[name]], name)  # how the conversation walk answered the append
                grown = (d, sessions.transcript(p))
                self.assertEqual(grown, answers(p, False)[:2], name)
                self.assertEqual(calls[0], fold, name)  # whether the sidebar folded onto its kept events
        finally:
            sessions._side_tail = real

    def test_random_trees_grown_line_by_line_equal_a_whole_read(self):
        rnd = random.Random(8)
        tx._memo_counts.clear()
        for n in range(RANDOM_CASES // 5):
            lines = random_tree(rnd).splitlines(True)
            if rnd.random() < 0.5:  # a checkpoint written after each turn, as the CLI does, so most appends can extend
                lines = [x for x in lines if '"last-prompt"' not in x]
                lines = sum(([x, json.dumps({"type": "last-prompt", "leafUuid": json.loads(x)["uuid"]}) + "\n"] if '"uuid"' in x and rnd.random() < 0.5 else [x]
                             for x in lines), [])
            p = self.put("")
            tx._states.clear()
            at = 0
            while at < len(lines):
                step = rnd.choice((1, 1, 2, 3, 8))
                with open(p, "a") as fh:
                    fh.write("".join(lines[at:at + step]))
                at += step
                sessions._cache.clear()
                sessions._full.clear()
                grown = (sessions.parse(p), sessions.transcript(p))
                if at >= len(lines) or rnd.random() < 0.3:
                    t = tx.load(p)
                    conv = tx.conversation(t)
                    got = grown + ([r.uuid for r in conv], tx.elsewhere(t, conv), t.parent if t.box.memo.own else None)
                    want = answers(p, False)
                    t = tx.load(p, fresh=True)
                    tx.conversation(t)
                    self.assertEqual(got, want[:3] + (want[4], t.parent if got[4] is not None else None), f"case {n} at line {at}")
                    tx._states.clear()
                    sessions.parse(p)  # keep a slim state again for the next append
                    sessions.transcript(p)
        self.assertGreater(tx._memo_counts["extend"], 1000, dict(tx._memo_counts))

    def test_a_turn_after_a_compaction_extends_the_kept_walk(self):
        rnd, base, last = random.Random(6), "", None
        for n in range(4):
            text, last = scale_home.turn(rnd, n, 1_790_000_000 + n * 60, "/w", last, 300, "cli", False)
            base += text
        kept = [json.loads(x)["uuid"] for x in base.splitlines() if '"uuid"' in x][-3:]
        base += json.dumps({"type": "system", "subtype": "compact_boundary", "uuid": "cb", "parentUuid": None, "timestamp": "2026-09-22T10:00:00.000Z",
                            "compactMetadata": {"preservedMessages": {"anchorUuid": "cs", "uuids": kept}}}) + "\n"
        base += json.dumps({"type": "user", "uuid": "cs", "parentUuid": "cb", "isCompactSummary": True, "timestamp": "2026-09-22T10:00:01.000Z",
                            "message": {"role": "user", "content": "summary"}}) + "\n"
        last = "cs"
        for n in range(4, 7):
            text, last = scale_home.turn(rnd, n, 1_790_000_000 + n * 60, "/w", last, 300, "cli", False)
            base += text
        p = self.put(base)
        tx._states.clear()
        sessions.parse(p)
        sessions.transcript(p)
        for n in range(7, 10):
            with open(p, "a") as fh:
                fh.write(scale_home.turn(rnd, n, 1_790_000_000 + n * 60, "/w", last, 300, "cli", False)[0])
            with open(p) as fh:
                last = [json.loads(x)["uuid"] for x in fh.read().splitlines() if '"uuid"' in x][-1]
            tx._memo_counts.clear()
            sessions._cache.clear()
            sessions._full.clear()
            grown = (sessions.parse(p), sessions.transcript(p))
            self.assertEqual(tx._memo_counts["extend"], 1, dict(tx._memo_counts))
            self.assertEqual(grown, answers(p, False)[:2], n)
            sessions.parse(p)  # keep a state again for the next append
            sessions.transcript(p)

    def test_a_cut_or_rewritten_file_falls_back_to_a_whole_read(self):
        src = next(s for s in SOURCES if os.path.getsize(s) > 2000)
        with open(src, "rb") as fh:
            data = fh.read()
        for change in ("truncate", "rewrite", "replace"):
            p = self.put(data)
            tx._states.clear()
            t = tx.load(p)
            conv = tx.conversation(t)
            if change == "truncate":
                with open(p, "r+b") as fh:
                    fh.truncate(len(data) // 3)
            elif change == "rewrite":  # same inode, other bytes at the same offsets
                with open(p, "r+b") as fh:
                    fh.write(data.replace(b'"uuid":"', b'"uuid":"Z', 1) if b'"uuid":"' in data else b"x" + data[1:])
            else:
                os.rename(self.put(data[:len(data) // 2], "c0ffee00-0000-4000-8000-0000000000ff.jsonl"), p)
            if change != "rewrite":
                with self.assertRaises(tx.Stale):
                    tx.view(conv)
            sessions._cache.clear()
            sessions._full.clear()
            self.assertEqual((sessions.parse(p), sessions.transcript(p)), answers(p, False)[:2], change)

    def test_a_growing_file_never_yields_a_torn_row(self):
        p = self.put(random_tree(random.Random(2)))
        tx._states.clear()
        t = tx.load(p)
        conv = tx.conversation(t)
        before = tx.view(conv)
        with open(p, "a") as fh:
            fh.write('{"type":"user","uuid":"half","message":{"role":"us')  # a line still being written
        self.assertEqual(tx.view(conv), before)
        rec = next(r for r in t.rows.values() if r.at is not None)
        src, pos = rec.at
        torn = tx.Record(rec.raw, (src, pos - 1), rec.fx)  # an index entry one byte short must never parse a part line
        with self.assertRaises(tx.Stale):
            torn.full()

    def test_two_readers_at_once_on_one_file(self):
        p = self.put(random_tree(random.Random(3)))
        want = answers(p, False)[:2]
        sessions._cache.clear()
        sessions._full.clear()
        out, errors = [], []

        def read():
            """Parse and open the sidebar a few times."""
            try:
                for _ in range(20):
                    out.append((sessions.parse(p), sessions.transcript(p)))
            except Exception as e:  # noqa: BLE001
                errors.append(e)
        threads = [threading.Thread(target=read) for _ in range(4)]
        for th in threads:
            th.start()
        for th in threads:
            th.join()
        self.assertEqual(errors, [])
        self.assertTrue(all(o == want for o in out))

    def test_kept_state_is_a_small_part_of_the_file(self):
        p = os.path.join(self.dir, "c0ffee00-0000-4000-8000-0000000000aa.jsonl")
        size = scale_home.transcript(p, random.Random(1), "/w", 1_790_000_000, 6 << 20, False)
        tx._states.clear()
        tracemalloc.start()
        before = tracemalloc.get_traced_memory()[0]
        t = tx.load(p)
        st = tx._states[p]
        kept = tracemalloc.get_traced_memory()[0] - before
        tracemalloc.stop()
        rows = len(st.t.rows)
        self.assertLess(kept, 0.3 * size, f"{kept} bytes kept for {size} bytes of text")
        self.assertLess(kept / rows, tx.ROW_BYTES, f"{kept / rows:.0f} bytes a row")
        del t


if __name__ == "__main__":
    unittest.main()
