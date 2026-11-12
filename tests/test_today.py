"""tokensToday and prsToday follow the Stats zone's calendar day: midnight, daylight-saving days, clock jumps and rows without a time."""
import json
import os
import unittest
from datetime import datetime, timezone

from helpers import FakeHome
from desk import sessions, stats

SID = "0dd00000-0000-4000-8000-000000000001"


def at(text):
    """Epoch seconds of a wall-clock time in the Stats zone, such as '2026-03-27 01:30'."""
    return datetime.strptime(text, "%Y-%m-%d %H:%M").replace(tzinfo=stats.IL).timestamp()


def iso(epoch):
    """Epoch seconds as the CLI's UTC timestamp."""
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z") if epoch is not None else "not a time"


class TodayTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.saved = sessions.CLOCK
        proj = os.path.join(self.home.home, "projects", "-w")
        os.makedirs(proj)
        self.path = os.path.join(proj, SID + ".jsonl")

    def tearDown(self):
        sessions.CLOCK = self.saved
        self.home.close()

    def write(self, turns):
        """A session of (prompt time, reply time, tokens, opens a PR) turns."""
        prev, out = None, []
        for n, (t_in, t_out, tokens, pr) in enumerate(turns):
            base = {"isSidechain": False, "entrypoint": "cli", "cwd": "/w", "sessionId": SID}
            out.append(dict(base, type="user", uuid=f"u{n}", parentUuid=prev, timestamp=iso(t_in), message={"role": "user", "content": f"invented {n}"}))
            content = [{"type": "tool_use", "id": f"t{n}", "name": "Bash", "input": {"command": "gh pr create --fill"}}] if pr else [{"type": "text", "text": "ok"}]
            out.append(dict(base, type="assistant", uuid=f"a{n}", parentUuid=f"u{n}", timestamp=iso(t_out),
                            message={"id": f"m{n}", "role": "assistant", "model": "m", "content": content, "usage": {"input_tokens": tokens, "output_tokens": 0}}))
            prev = f"a{n}"
            if pr:
                out.append(dict(base, type="user", uuid=f"r{n}", parentUuid=prev, timestamp=iso(t_out),
                                message={"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"t{n}", "content": f"https://github.com/o/r/pull/{n}"}]}))
                prev = f"r{n}"
        with open(self.path, "w") as fh:
            fh.writelines(json.dumps(r) + "\n" for r in out)

    def today(self, now):
        """(tokensToday, prsToday) of the session with the clock at now."""
        sessions.CLOCK = lambda: now
        row = next(o for o in sessions.sessions() if o["id"] == SID)
        return row["tokensToday"], row["prsToday"]

    def test_session_across_midnight(self):
        self.write([(at("2026-06-14 23:50"), at("2026-06-14 23:55"), 5, True), (at("2026-06-15 00:05"), at("2026-06-15 00:06"), 7, False)])
        self.assertEqual(self.today(at("2026-06-14 23:59")), (5, 1))
        self.assertEqual(self.today(at("2026-06-15 00:10")), (7, 0))

    def test_turn_that_ends_after_midnight_counts_on_its_reply_day(self):
        self.write([(at("2026-06-14 23:58"), at("2026-06-15 00:02"), 9, True)])
        self.assertEqual(self.today(at("2026-06-15 08:00")), (9, 1))
        self.assertEqual(self.today(at("2026-06-14 23:59")), (0, 0))

    def test_first_request_after_midnight_with_nothing_changed_is_zero(self):
        self.write([(at("2026-06-14 22:00"), at("2026-06-14 22:01"), 4, True)])
        self.assertEqual(self.today(at("2026-06-14 23:59")), (4, 1))
        self.assertEqual(self.today(at("2026-06-15 00:00")), (0, 0))  # cached view, no file change

    def test_spring_forward_day_has_23_hours(self):
        day = "2026-03-27"  # Israel moves to summer time at 02:00 on the Friday before the last Sunday of March
        self.assertEqual(at("2026-03-28 00:00") - at(f"{day} 00:00"), 23 * 3600)
        self.write([(at("2026-03-26 23:30"), at("2026-03-26 23:59"), 1, False), (at(f"{day} 00:01"), at(f"{day} 00:02"), 2, False),
                    (at(f"{day} 23:59"), at(f"{day} 23:59"), 3, False), (at("2026-03-28 00:00"), at("2026-03-28 00:01"), 4, False)])
        self.assertEqual(self.today(at(f"{day} 12:00")), (5, 0))

    def test_fall_back_day_has_25_hours(self):
        day = "2026-10-25"  # back to winter time at 02:00 on the last Sunday of October
        self.assertEqual(at("2026-10-26 00:00") - at(f"{day} 00:00"), 25 * 3600)
        self.write([(at(f"{day} 00:00"), at(f"{day} 00:30"), 2, False), (at("2026-10-26 00:00") - 60, at("2026-10-26 00:00") - 30, 3, False),
                    (at("2026-10-26 00:00"), at("2026-10-26 00:00") + 1, 4, False)])
        self.assertEqual(self.today(at(f"{day} 12:00")), (5, 0))

    def test_clock_that_jumps_back(self):
        self.write([(at("2026-06-15 10:00"), at("2026-06-15 10:01"), 6, True)])
        self.assertEqual(self.today(at("2026-06-15 11:00")), (6, 1))
        self.assertEqual(self.today(at("2026-06-14 23:00")), (0, 0))  # the rows are from 'tomorrow' now
        self.assertEqual(self.today(at("2026-06-15 00:30")), (6, 1))

    def test_rows_without_a_usable_time_count_in_total_only(self):
        self.write([(None, None, 8, True), (at("2026-06-15 09:00"), at("2026-06-15 09:01"), 1, False)])
        sessions.CLOCK = lambda: at("2026-06-15 10:00")
        row = next(o for o in sessions.sessions() if o["id"] == SID)
        self.assertEqual((row["tokensToday"], row["prsToday"], row["tokens"]), (1, 0, 9))


if __name__ == "__main__":
    unittest.main()
