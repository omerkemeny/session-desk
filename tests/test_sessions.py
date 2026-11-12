"""Titles, live status, behind/also, subagents and the whole session list."""
import os
import subprocess
import sys
import time
import unittest

from helpers import NOW, S1, S2, S3, S4, S5, S6, T1, FakeHome, FakeTerm
from desk import sessions, terms

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "fixtures"))
import make_home  # noqa: E402


def proc(pid, status="idle", at=0, name=None, entry="cli"):
    """One holder entry as holders() returns it."""
    return {"pid": pid, "status": status, "at": at, "name": name, "entry": entry}


class TitleTest(unittest.TestCase):
    def test_automatic_names_give_way_to_the_first_request(self):
        d = {"title": None, "first": "Make the export faster for large invoices please"}
        for name in ("side chat", "Untitled", "alpha-3f"):
            self.assertEqual(sessions.mission(d, name), "Make the export faster for large invoices please")
        self.assertEqual(sessions.mission(dict(d, title="Speed up export"), "alpha-3f"), "Speed up export")
        self.assertEqual(sessions.mission({"title": None, "first": None}, None), "Untitled")

    def test_brief_cuts_at_a_word(self):
        self.assertEqual(sessions.brief("# one two three four\nsecond line", 12), "one two…")


class LiveTest(unittest.TestCase):
    def tearDown(self):
        terms._terms.clear()
        terms._replies.clear()

    def test_busy_wins(self):
        out = sessions.live({"s": [proc(1, "idle", 5000, "a"), proc(2, "busy", 1000, "b")]})
        self.assertEqual(out["s"], ("busy", 1000, "b"))
        self.assertEqual(sessions.live({"s": [proc(1, "idle", 10), proc(2, "idle", 20, "n")]})["s"], ("idle", 20, "n"))

    def test_page_terminal_at_first_prompt_does_not_count(self):
        terms._terms["s"] = FakeTerm(77, 100_000)
        self.assertNotIn("s", sessions.live({"s": [proc(77, "idle", 105_000)]}))
        self.assertEqual(sessions.live({"s": [proc(77, "idle", 125_000)]})["s"][0], "idle")
        self.assertEqual(sessions.live({"s": [proc(77, "busy", 101_000)]})["s"][0], "busy")
        self.assertEqual(sessions.live({"s": [proc(77, "idle", 105_000), proc(78, "idle", 90_000)]})["s"][1], 90_000)

    def test_behind(self):
        terms._terms["s"] = FakeTerm(77, 1000)
        hold = {"s": [proc(77, "idle", 2000, entry="cli")]}
        self.assertTrue(sessions.behind("s", {"lastBy": "claude-desktop", "lastAt": 5001}, hold))
        self.assertFalse(sessions.behind("s", {"lastBy": "claude-desktop", "lastAt": 5000}, hold))
        self.assertFalse(sessions.behind("s", {"lastBy": "cli", "lastAt": 99_999}, hold))
        self.assertFalse(sessions.behind("s", {"lastBy": "claude-desktop", "lastAt": 99_999}, {"s": [proc(77, "busy", 2000)]}))
        terms._replies["s"] = {"proc": None, "log": None, "done_at": 2001, "error": ""}
        self.assertTrue(sessions.behind("s", {"lastBy": "cli", "lastAt": 0}, hold))
        self.assertFalse(sessions.behind("other", {"lastBy": "x", "lastAt": 99_999}, hold))

    def test_also(self):
        terms._terms["s"] = FakeTerm(77, 0)
        hold = {"s": [proc(77), proc(78, entry="claude-desktop"), proc(79, entry=""), proc(80, entry="cli")]}
        self.assertEqual(sessions.elsewhere("s", hold), ["another program", "another terminal", "desktop app"])


class ListTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()

    def tearDown(self):
        self.home.close()

    def test_list_status_titles_and_subs(self):
        for sid in (S3, S4, S5, S6):
            self.home.register(sid)
        self.home.register(S1, status="busy")
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        self.home.register(S2, pid=dead.pid, status="busy")  # stale file of a finished process
        out = {o["id"]: o for o in sessions.sessions()}
        self.assertEqual(out[S1]["status"], "running")
        self.assertEqual(out[S2]["status"], "done")
        self.assertEqual({out[s]["status"] for s in (S3, S4, S5, S6)}, {"waiting"})
        self.assertEqual(out[S3]["title"], "Refactor billing · Split invoices module")
        self.assertEqual(out[S4]["title"], "Refactor billing · Rename billing tables")
        self.assertEqual(out[S5]["title"], "Ship release · Tag version one")
        self.assertEqual(out[S6]["title"], "Ship release · Tag version one #2")
        self.assertEqual(out[S2]["title"], "Add dark mode to the settings page")
        self.assertEqual(out[S3]["subs"], ["Explore billing code"])
        self.assertEqual(out[S4]["subs"], [])
        self.assertEqual(out[S3]["also"], ["another terminal"])
        self.assertEqual(out[S1]["tokens"], 149)
        self.assertEqual(out[S1]["project"], "alpha")
        keys = {"id", "title", "topic", "project", "branch", "status", "statusAt", "replyError", "replyExit", "copies", "term", "also", "subs", "behind",
                "model", "updated", "tokens", "ask", "last", "kind", "automated", "consistency", "lastTool", "lastError", "prOpened", "waitingSince",
                "tokensToday", "prsToday"}
        self.assertEqual(set(out[S1]), keys)

    def test_stale_and_parked_registry_files_are_not_live(self):
        start = sessions.process_starts([os.getpid()]).get(os.getpid())
        self.assertTrue(start)
        self.home.register(S1, procStart=start)
        self.home.register(S2, procStart="Mon Jan  1 00:00:00 2001")  # this pid now belongs to another process: a stale file
        self.home.register(S3, parkedJobId="job-1")
        self.home.register(S4)  # no procStart (older CLI): trusted while the pid runs
        hold = sessions.holders()
        self.assertEqual((S1 in hold, S2 in hold, S3 in hold, S4 in hold), (True, False, False, True))
        out = {o["id"]: o for o in sessions.sessions()}
        self.assertEqual((out[S1]["status"], out[S2]["status"]), ("waiting", "done"))

    def test_derived_names_are_not_titles(self):
        self.home.register(S1, name="alpha-run", nameSource="derived")
        self.home.register(S2, name="Picked name", nameSource="user")
        hold = sessions.holders()
        self.assertEqual((hold[S1][0]["name"], hold[S2][0]["name"]), (None, "Picked name"))

    def test_reply_state_shows_in_status(self):
        terms._replies[S1] = {"proc": None, "log": None, "done_at": 1234, "error": "boom"}
        out = {o["id"]: o for o in sessions.sessions()}
        self.assertEqual((out[S1]["status"], out[S1]["statusAt"], out[S1]["replyError"]), ("waiting", 1234, "boom"))


class WindowTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.saved = (sessions.RECENT, sessions.RECENT_AUTO)
        sessions.RECENT, sessions.RECENT_AUTO = 3, 2

    def tearDown(self):
        sessions.RECENT, sessions.RECENT_AUTO = self.saved
        self.home.close()

    def add(self, n, automated, at):
        """One finished session, written by a hook run (automated) or typed by a person, last changed at epoch second at."""
        sid = f"d{n:07x}-0000-4000-8000-{n:012x}"
        extra = {"entrypoint": "sdk-cli"} if automated else {}
        make_home.write("-work-window", sid, [make_home.user("u1", None, "2026-03-01T10:00:00.000Z", f"Request {n}", **extra),
                                             make_home.assistant("a1", "u1", "2026-03-01T10:00:01.000Z", "m1", [make_home.text("Ok")], make_home.usage(1, 1), **extra)],
                        out=self.home.home)
        os.utime(self.home.path(sid), (at, at))
        return sid

    def test_automated_runs_do_not_push_out_typed_sessions(self):
        now = time.time()
        auto = [self.add(i, True, now + 100 - i) for i in range(6)]  # the newest files are all hook runs
        typed = [self.add(10 + i, False, now - 100 - i) for i in range(5)]
        ids = [o["id"] for o in sessions.sessions()]
        self.assertEqual([i for i in ids if i in auto], auto[:2])
        fixture_typed = sum(1 for o in sessions.sessions() if not o["automated"] and o["id"] not in typed)
        self.assertEqual(fixture_typed, 3)  # the fixture's own sessions are newer than the added typed ones
        self.home.register(typed[4])  # live sessions are always listed
        self.assertIn(typed[4], [o["id"] for o in sessions.sessions()])


class TodayTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.saved = sessions.CLOCK

    def tearDown(self):
        sessions.CLOCK = self.saved
        self.home.close()

    def test_tokens_and_prs_today_roll_over_at_midnight(self):
        sessions.CLOCK = lambda: NOW  # 2026-06-15 12:00 in the stats time zone, the day the T1 fixture ran
        o = {x["id"]: x for x in sessions.sessions()}[T1]
        self.assertEqual((o["tokensToday"], o["prsToday"]), (139, 1))
        sessions.CLOCK = lambda: NOW + 13 * 3600  # 01:00 the next day; the file did not change
        o = {x["id"]: x for x in sessions.sessions()}[T1]
        self.assertEqual((o["tokensToday"], o["prsToday"]), (0, 0))
        self.assertEqual(o["tokens"], 139)


if __name__ == "__main__":
    unittest.main()


class ScreenEndTest(unittest.TestCase):
    """Error results cut like the CLI, and the Interrupted line under a call left without a result."""

    def setUp(self):
        self.home = FakeHome()
        self.sid = "c0ffee00-0000-4000-8000-0000000000e1"
        d = os.path.join(self.home.home, "projects", "-work-end")
        os.makedirs(d)
        self.p = os.path.join(d, self.sid + ".jsonl")

    def tearDown(self):
        self.home.close()

    def write(self, n_error, open_end):
        """A prompt, an Edit whose error has n_error lines, then a Read with or without its result."""
        import json
        base = {"sessionId": self.sid, "cwd": "/w", "entrypoint": "cli", "isSidechain": False, "timestamp": "2026-09-22T10:00:00.000Z"}
        rows = [dict(base, type="user", uuid="u1", parentUuid=None, message={"role": "user", "content": "go"}),
                dict(base, type="assistant", uuid="a1", parentUuid="u1", message={"id": "m1", "role": "assistant", "model": "m", "content": [
                    {"type": "tool_use", "id": "t1", "name": "Edit", "input": {"file_path": "/w/a"}}]}),
                dict(base, type="user", uuid="r1", parentUuid="a1", message={"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "is_error": True, "content": "\n".join(f"line {i}" for i in range(1, n_error + 1))}]}),
                dict(base, type="assistant", uuid="a2", parentUuid="r1", message={"id": "m2", "role": "assistant", "model": "m", "content": [
                    {"type": "tool_use", "id": "t2", "name": "Read", "input": {"file_path": "/w/b"}}]})]
        if not open_end:
            rows.append(dict(base, type="user", uuid="r2", parentUuid="a2", message={"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t2", "content": "x"}]}))
        with open(self.p, "w") as fh:
            fh.write("".join(json.dumps(r) + "\n" for r in rows))

    def test_error_results_keep_ten_lines(self):
        for n, tail in ((8, None), (10, None), (11, "… +1 line"), (12, "… +2 lines"), (40, "… +30 lines")):
            self.write(n, False)
            ev = sessions.transcript(self.p)[0]
            text = next(e for e in ev if e[0] == "tool" and e[1] == "Edit")[3].split("\n")
            self.assertEqual(text[:min(n, 10)], ["Error: line 1"] + [f"line {i}" for i in range(2, min(n, 10) + 1)], n)
            self.assertEqual(text[10:], [tail] if tail else [], n)

    def test_a_call_left_without_result_gets_the_interrupted_line_unless_live(self):
        self.write(1, True)
        self.assertEqual(sessions.transcript(self.p)[0][-1], ["interrupt"])
        self.home.register(self.sid, status="busy")
        self.assertEqual(sessions.transcript(self.p)[0][-1][0], "tool")  # still running in a live program
        self.write(1, False)
        sessions._full.clear()
        self.assertNotEqual(sessions.transcript(self.p)[0][-1], ["interrupt"])
