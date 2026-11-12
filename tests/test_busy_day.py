"""A recorded busy day (appends, status flips, sessions coming and going) answers exactly what a cold start answers after every step."""
import json
import os
import random
import time
import unittest

from helpers import S1, S2, S4, FakeHome, reset
from desk import sessions, summaries, transcripts as tx


def row(kind, uid, parent, sid, text, ts, entry="cli"):
    """One invented CLI row."""
    r = {"type": kind, "uuid": uid, "parentUuid": parent, "isSidechain": False, "timestamp": ts, "entrypoint": entry, "cwd": "/work/day",
         "sessionId": sid, "gitBranch": "main"}
    r["message"] = {"role": "user", "content": text} if kind == "user" else {
        "id": "m" + uid, "role": "assistant", "model": "model-x", "content": [{"type": "text", "text": text}],
        "usage": {"input_tokens": 3, "output_tokens": 4, "cache_creation_input_tokens": 5, "cache_read_input_tokens": 6}}
    return json.dumps(r) + "\n"


def iso(t):
    """Epoch seconds as the CLI's timestamp."""
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))


class BusyDayTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()

    def tearDown(self):
        self.home.close()

    def answers(self, paths):
        """The list as JSON bytes and each named session's sidebar events."""
        return json.dumps(sessions.sessions()).encode(), [sessions.transcript(p) for p in paths]

    def cold(self, paths):
        """The same answers with every cache dropped, as after a restart without the summary file."""
        hold = (dict(sessions._cache), dict(sessions._views), dict(sessions._full), dict(tx._states), dict(tx._found))
        sessions._cache.clear(), sessions._views.clear(), sessions._full.clear(), tx._states.clear(), tx._found.clear()
        summaries.reset()
        try:
            return self.answers(paths)
        finally:
            sessions._cache.update(hold[0]), sessions._views.update(hold[1]), sessions._full.update(hold[2])
            tx._states.update(hold[3]), tx._found.update(hold[4])

    def test_replayed_day_matches_fresh_answers_after_every_step(self):
        rnd, now = random.Random(11), time.time()
        proj = os.path.join(self.home.home, "projects", "-work-day")
        os.makedirs(proj)
        sids = [f"dd{i:06d}-0000-4000-8000-{i:012d}" for i in range(6)]
        last, n = {}, [0]
        for i, sid in enumerate(sids):
            with open(os.path.join(proj, sid + ".jsonl"), "w") as fh:
                fh.write(json.dumps({"type": "custom-title", "customTitle": f"Invented day task {i % 3}", "sessionId": sid}) + "\n")
        paths = [os.path.join(proj, s + ".jsonl") for s in sids] + [self.home.path(S1), self.home.path(S2)]

        def append(sid, kind, text, back=0):
            """One row on the session's own branch; back moves its time into the past (clock skew)."""
            n[0] += 1
            u = f"{sid[:8]}-{n[0]}"
            with open(os.path.join(proj, sid + ".jsonl"), "a") as fh:
                fh.write(row(kind, u, last.get(sid), sid, text, iso(now - back + n[0])))
            last[sid] = u

        for sid in sids:
            append(sid, "user", "please do the invented step")
            append(sid, "assistant", "Done. Shall I go on?")
        for step in range(40):
            sid = rnd.choice(sids)
            what = rnd.random()
            if what < 0.5:
                append(sid, rnd.choice(("user", "assistant")), f"invented progress {step}", back=rnd.choice((0, 0, 3600)))
            elif what < 0.7:
                self.home.register(sid, status=rnd.choice(("busy", "idle", "waiting")))
            elif what < 0.8:
                for f in os.listdir(os.path.join(self.home.home, "sessions")):
                    if rnd.random() < 0.5:
                        os.remove(os.path.join(self.home.home, "sessions", f))
            elif what < 0.9:
                with open(self.home.path(rnd.choice((S1, S2, S4))), "a") as fh:
                    fh.write(json.dumps({"type": "last-prompt", "lastPrompt": f"invented prompt {step}", "sessionId": "x"}) + "\n")
            else:
                with open(os.path.join(proj, sid + ".jsonl"), "a") as fh:
                    fh.write('{"type":"assistant","uuid":"half')  # a line still being written
                with open(os.path.join(proj, sid + ".jsonl"), "a") as fh:
                    fh.write('-' + str(step) + '"}\n')
            warm = self.answers(paths)
            self.assertEqual(warm, self.cold(paths), f"step {step}")

    def test_file_names_that_are_not_session_ids_are_not_listed(self):
        proj = os.path.join(self.home.home, "projects", "-work-day")
        os.makedirs(proj)
        with open(self.home.path(S1)) as src, open(os.path.join(proj, "notes-copy.jsonl"), "w") as dst:
            dst.write(src.read())
        self.assertNotIn("notes-copy", [o["id"] for o in sessions.sessions()])
        self.assertIsNone(tx.find("notes-copy"))


if __name__ == "__main__":
    unittest.main()
