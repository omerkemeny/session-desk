"""Reading only appended bytes gives exactly what a full read gives, for every fixture cut at random places; cache limits and rewrites."""
import glob
import os
import random
import shutil
import tempfile
import time
import unittest

from helpers import ROOT, reset
from desk import config, sessions, transcripts as tx

SOURCES = sorted(glob.glob(os.path.join(ROOT, "tests", "fixtures", "*", "projects", "*", "*.jsonl")))


def facts(t):
    """Everything a load() result tells the summary and the sidebar, as plain values."""
    conv = tx.conversation(t)
    return (tx.view(conv), tx.turn_end(conv), [r.raw for r in t.messages], t.custom, t.ai, t.first, t.continued, sorted(t.entries), sorted(t.prs),
            tx.session_kind(t), t.lp, t.first_cmd, t.tick, t.size, tx.prompt_title(t))


class IncrementalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-incr-")
        self.dir = os.path.join(self.tmp, "projects", "-work-incr")
        os.makedirs(self.dir)
        self.saved, config.HOME = config.HOME, self.tmp
        reset()
        tx._states.clear()

    def tearDown(self):
        config.HOME = self.saved
        reset()
        tx._states.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_appends_in_random_chunks_match_a_full_read(self):
        self.assertGreater(len(SOURCES), 20)
        rnd = random.Random(7)
        for src in SOURCES:
            with open(src, "rb") as fh:
                data = fh.read()
            for trial in range(4):
                path = os.path.join(self.dir, os.path.basename(src))
                open(path, "wb").close()
                tx._states.clear()
                at = 0
                while at < len(data):
                    step = rnd.choice((1, 7, 40, 200, len(data)))
                    with open(path, "ab") as fh:
                        fh.write(data[at:at + step])
                    at += step
                    grown = facts(tx.load(path))
                    self.assertIn(path, tx._states)
                    self.assertEqual(grown, facts(tx.load(path, fresh=True)), f"{os.path.basename(src)} trial {trial} at {at}")
                sessions._cache.clear()
                inc = sessions.parse(path)
                sessions._cache.clear()
                tx._states.clear()
                self.assertEqual(inc, sessions.parse(path), os.path.basename(src))
                os.remove(path)

    def test_rewritten_or_shrunk_file_is_read_again(self):
        src = SOURCES[0]
        path = os.path.join(self.dir, os.path.basename(src))
        shutil.copy(src, path)
        before = facts(tx.load(path))
        with open(path, "rb") as fh:
            data = fh.read()
        with open(path, "wb") as fh:  # same size, different head
            fh.write(data.replace(b'"type":"user"', b'"type":"usex"', 1))
        self.assertEqual(facts(tx.load(path)), facts(tx.load(path, fresh=True)))
        with open(path, "wb") as fh:  # shrank
            fh.write(data[:len(data) // 2])
        self.assertEqual(facts(tx.load(path)), facts(tx.load(path, fresh=True)))
        tmp = path + ".new"
        with open(tmp, "wb") as fh:  # replaced by rename
            fh.write(data)
        os.replace(tmp, path)
        self.assertEqual(facts(tx.load(path)), before)

    def test_kept_states_are_bounded(self):
        for i in range(tx.STATE_MAX + 5):
            path = os.path.join(self.dir, f"{i:08x}-0000-4000-8000-000000000000.jsonl")
            shutil.copy(SOURCES[i % len(SOURCES)], path)
            tx.load(path)
        self.assertEqual(len(tx._states), tx.STATE_MAX)
        saved, tx.STATE_BYTES = tx.STATE_BYTES, 1
        try:
            os.utime(path, (time.time() + 5, time.time() + 5))
            tx.load(path)
            self.assertEqual(list(tx._states), [path])  # only the newest file is kept past the byte bound
        finally:
            tx.STATE_BYTES = saved

    def test_newest_file_past_the_byte_bound_stays_incremental(self):
        saved, tx.STATE_BYTES = tx.STATE_BYTES, 1  # every file is past the bound, as a 100 MB live file is past 64 MB
        try:
            other = os.path.join(self.dir, "0000000a-0000-4000-8000-000000000000.jsonl")
            shutil.copy(SOURCES[1], other)
            os.utime(other, (time.time() - 60, time.time() - 60))
            big = os.path.join(self.dir, os.path.basename(SOURCES[0]))
            with open(SOURCES[0], "rb") as fh:
                data = fh.read()
            open(big, "wb").close()
            for at in range(0, len(data), max(1, len(data) // 9)):
                with open(big, "ab") as fh:
                    fh.write(data[at:at + max(1, len(data) // 9)])
                tx.load(other)  # the change feed reads other files between appends
                grown = facts(tx.load(big))
                self.assertIn(big, tx._states)
                self.assertNotIn(other, tx._states)
                self.assertEqual(grown, facts(tx.load(big, fresh=True)))
        finally:
            tx.STATE_BYTES = saved

    def test_old_files_keep_no_state(self):
        path = os.path.join(self.dir, os.path.basename(SOURCES[0]))
        shutil.copy(SOURCES[0], path)
        os.utime(path, (1, 1))
        tx.load(path)
        self.assertNotIn(path, tx._states)

    def test_summary_cache_is_bounded(self):
        saved, sessions.SUMMARY_MAX = sessions.SUMMARY_MAX, 3
        try:
            for src in SOURCES[:6]:
                path = os.path.join(self.dir, os.path.basename(src))
                shutil.copy(src, path)
                sessions.parse(path)
            self.assertEqual(len(sessions._cache), 3)
        finally:
            sessions.SUMMARY_MAX = saved


if __name__ == "__main__":
    unittest.main()


class SharedStateTest(unittest.TestCase):
    """A read with nothing pending shares the kept rows instead of copying them: the rules must never change the kept state."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-share-")
        self.dir = os.path.join(self.tmp, "projects", "-work-share")
        os.makedirs(self.dir)
        self.saved, config.HOME = config.HOME, self.tmp
        reset()
        tx._states.clear()

    def tearDown(self):
        config.HOME = self.saved
        reset()
        tx._states.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_repeated_reads_leave_the_kept_state_whole(self):
        for src in SOURCES:
            path = os.path.join(self.dir, os.path.basename(src))
            shutil.copyfile(src, path)
            tx._states.clear()
            t = tx.load(path)
            rows, parents, checks = len(tx._states[path].t.rows), dict(tx._states[path].t.parent), dict(tx._checks[path].get("anomalies", {}))
            first = facts(t)
            self.assertEqual(facts(tx.load(path)), first, os.path.basename(src))
            st = tx._states[path]
            self.assertEqual((len(st.t.rows), st.t.parent, dict(tx._checks[path].get("anomalies", {}))), (rows, parents, checks), os.path.basename(src))

    def test_a_held_read_does_not_grow_with_a_later_append(self):
        src = max(SOURCES, key=os.path.getsize)
        path = os.path.join(self.dir, os.path.basename(src))
        with open(src, "rb") as fh:
            lines = fh.readlines()
        with open(path, "wb") as fh:
            fh.writelines(lines[:len(lines) // 2])
        held = tx.load(path)
        rows, msgs = list(held.rows), list(held.messages)
        with open(path, "ab") as fh:
            fh.writelines(lines[len(lines) // 2:])
        grown = tx.load(path)
        self.assertEqual((list(held.rows), list(held.messages)), (rows, msgs))  # the reader still sees its own snapshot
        self.assertEqual(facts(grown), facts(tx.load(path, fresh=True)))

