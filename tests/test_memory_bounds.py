"""Every cache of the data side holds at most its stated entries and bytes, and forgets transcripts that are gone."""
import json
import os
import time
import unittest

from helpers import S1, FakeHome
from desk import sessions, summaries, transcripts as tx


def line(kind, uid, parent, ts="2026-06-15T09:00:00.000Z", **extra):
    """One invented row as a JSON line."""
    r = dict({"type": kind, "uuid": uid, "parentUuid": parent, "isSidechain": False, "timestamp": ts, "entrypoint": "cli", "cwd": "/w",
              "sessionId": "s"}, **extra)
    return json.dumps(r) + "\n"


class BoundsTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.proj = os.path.join(self.home.home, "projects", "-w")
        os.makedirs(self.proj)

    def tearDown(self):
        self.home.close()

    def make(self, i, rows=None):
        """An invented session file with one prompt and one reply; returns its path."""
        p = os.path.join(self.proj, f"{i:08x}-0000-4000-8000-000000000000.jsonl")
        with open(p, "w") as fh:
            fh.write(rows or (line("user", f"u{i}", None, message={"role": "user", "content": f"invented task {i}"})
                              + line("assistant", f"a{i}", f"u{i}", message={"id": f"m{i}", "role": "assistant", "model": "m", "content": [{"type": "text", "text": "ok"}],
                                                                             "usage": {"input_tokens": 1, "output_tokens": 1}})))
        return p

    def test_deleted_transcripts_leave_every_cache(self):
        paths = [self.make(i) for i in range(5)]
        sessions.sessions()
        for p in paths:
            sessions.transcript(p)
            sessions.parse(p)
            tx.find(tx.session_id(p))
        for p in paths[:3]:
            os.remove(p)
        sessions.sessions()
        for store in (sessions._cache, sessions._views, sessions._full, tx._states):
            self.assertFalse(set(paths[:3]) & set(store), store)
        self.assertFalse(set(paths[:3]) & set(tx._found.values()))
        self.assertFalse(set(paths[:3]) & {k[0] for k in sessions._folds})
        summaries.flush()
        self.assertFalse({os.path.realpath(p) for p in paths[:3]} & set(summaries._state["entries"]))

    def test_summary_cache_past_its_bound(self):
        saved, sessions.SUMMARY_MAX = sessions.SUMMARY_MAX, 4
        try:
            for i in range(9):
                sessions.parse(self.make(i))
            self.assertEqual(len(sessions._cache), 4)
        finally:
            sessions.SUMMARY_MAX = saved

    def test_views_past_their_bound(self):
        saved, sessions.CACHE_MAX = sessions.CACHE_MAX, 3
        try:
            for i in range(7):
                p = self.make(i)
                sessions.list_view(p, os.stat(p))
            self.assertEqual(len(sessions._views), 3)
        finally:
            sessions.CACHE_MAX = saved

    def test_folds_past_their_bound(self):
        sessions._folds.clear()
        for i in range(sessions.FOLD_MAX + 3):
            p = self.make(i)
            sessions.transcript(p)
            sessions.parse(p)
        self.assertEqual(len(sessions._folds), sessions.FOLD_MAX)

    def test_sidebar_transcripts_past_count_and_size(self):
        paths = [self.make(i) for i in range(sessions.FULL_MAX + 3)]
        for p in paths:
            sessions.transcript(p)
        self.assertEqual(len(sessions._full), sessions.FULL_MAX)
        saved, sessions.FULL_CHARS = sessions.FULL_CHARS, 1
        try:
            sessions.transcript(paths[0])
            self.assertEqual(list(sessions._full), [paths[0]])  # the newest is kept even past the size bound
        finally:
            sessions.FULL_CHARS = saved

    def test_summary_file_entries_past_their_bound(self):
        summaries.attach()
        saved, summaries.MAX_ENTRIES = summaries.MAX_ENTRIES, 3
        try:
            for i in range(6):
                summaries.put(self.make(i), (1, 2, 3, 4), {})
            self.assertEqual(len(summaries._state["entries"]), 3)
        finally:
            summaries.MAX_ENTRIES = saved
            summaries.reset()

    def test_parse_states_past_their_bytes_keep_only_the_newest_file_whole(self):
        saved, tx.STATE_BYTES = tx.STATE_BYTES, 600  # about two small files; the newest file is kept whatever its size
        try:
            paths = [self.make(i) for i in range(6)]
            for n, p in enumerate(paths):
                os.utime(p, (time.time() - 100 + n, time.time() - 100 + n))  # recent, newest last
                tx.load(p)
            newest = max(tx._states, key=lambda p: tx._states[p].chk["mtime"])
            self.assertEqual(newest, paths[-1])
            self.assertLessEqual(sum(s.offset for p, s in tx._states.items() if p != newest), tx.STATE_BYTES)
            tx.STATE_BYTES = 1
            tx.load(paths[0])
            self.assertEqual(list(tx._states), [paths[-1]])
        finally:
            tx.STATE_BYTES = saved

    def test_found_past_its_bound(self):
        saved, tx.FOUND_MAX = tx.FOUND_MAX, 3
        try:
            for i in range(6):
                tx.find(tx.session_id(self.make(i)))
            self.assertEqual(len(tx._found), 3)
        finally:
            tx.FOUND_MAX = saved

    def test_per_day_figures_keep_the_newest_days(self):
        rows, prev = "", None
        for d in range(1, 13):
            ts = f"2026-06-{d:02d}T09:00:00.000Z"
            rows += line("user", f"u{d}", prev, ts, message={"role": "user", "content": "invented"})
            rows += line("assistant", f"a{d}", f"u{d}", ts, sessionId="", message={"id": f"m{d}", "role": "assistant", "model": "m", "content": [{"type": "text", "text": "ok"}],
                                                                                  "usage": {"input_tokens": d, "output_tokens": 0}})
            prev = f"a{d}"
        d = sessions.parse(self.make(1, rows))
        self.assertEqual(sorted(d["days"]), [f"2026-06-{x:02d}" for x in range(6, 13)])
        self.assertEqual(d["days"]["2026-06-12"], [12, 0])

    def test_unknown_type_names_are_capped(self):
        p = self.make(1, "".join(json.dumps({"type": f"invented-kind-{i}"}) + "\n" for i in range(tx.UNKNOWN_NAMES * 3)))
        tx.load(p)
        chk = tx._checks[p]
        self.assertEqual(len(chk["unknown"]), tx.UNKNOWN_NAMES + 1)
        self.assertEqual(sum(chk["unknown"].values()), tx.UNKNOWN_NAMES * 3)

    def test_kept_rows_drop_unread_result_fields_without_changing_the_screen(self):
        call = {"id": "m1", "role": "assistant", "model": "m", "content": [{"type": "tool_use", "id": "t1", "name": "Edit", "input": {"file_path": "/w/a.txt"}}]}
        tur = {"filePath": "/w/a.txt", "originalFile": "x\n" * 5000, "structuredPatch": [{"oldStart": 1, "newStart": 1, "lines": ["-x", "+y"]}], "userModified": False}
        res = {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}
        p = self.make(1, line("user", "u1", None, message={"role": "user", "content": "invented"}) + line("assistant", "a1", "u1", message=call)
                      + line("user", "r1", "a1", message=res, toolUseResult=tur))
        t = tx.load(p)
        self.assertNotIn("toolUseResult", t.rows["r1"].raw)  # a kept row holds no body
        self.assertEqual(set(t.rows["r1"].body()["toolUseResult"]), {"filePath", "structuredPatch"})
        ev = sessions.transcript(p)[0]
        self.assertEqual(ev[-1][3], "Added 1 line, removed 1 line\n1 -x\n1 +y")

    def test_find_forgets_a_deleted_session(self):
        p = self.make(1)
        self.assertEqual(tx.find(tx.session_id(p)), p)
        os.remove(p)
        self.assertIsNone(tx.find(tx.session_id(p)))
        self.assertNotIn((self.home.home, tx.session_id(p)), tx._found)
        self.assertTrue(os.path.exists(self.home.path(S1)))


if __name__ == "__main__":
    unittest.main()
