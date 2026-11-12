"""The partial list answer patched onto the previous full list equals the next full list after every step of a busy day."""
import json
import os
import random
import time
import unittest

from helpers import FakeHome
from desk import sessions


def row(kind, uid, parent, sid, text, ts):
    """One invented CLI row."""
    r = {"type": kind, "uuid": uid, "parentUuid": parent, "isSidechain": False, "timestamp": ts, "entrypoint": "cli", "cwd": "/work/day", "sessionId": sid}
    r["message"] = {"role": "user", "content": text} if kind == "user" else {
        "id": "m" + uid, "role": "assistant", "model": "m", "content": [{"type": "text", "text": text}], "usage": {"input_tokens": 3, "output_tokens": 4}}
    return json.dumps(r) + "\n"


class PartialTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()

    def tearDown(self):
        self.home.close()

    def test_patched_list_equals_the_full_list_after_every_step(self):
        rnd, now = random.Random(5), time.time()
        proj = os.path.join(self.home.home, "projects", "-work-day")
        os.makedirs(proj)
        sids = [f"ee{i:06d}-0000-4000-8000-{i:012d}" for i in range(8)]
        last, n, regs = {}, [0], {}
        saved = sessions.RECENT, sessions.RECENT_AUTO
        sessions.RECENT = sessions.RECENT_AUTO = 4  # small, so sessions enter and leave the list

        def append(sid, kind, text):
            """One row on the session's branch; a title shared by two sessions on purpose."""
            n[0] += 1
            p = os.path.join(proj, sid + ".jsonl")
            new = not os.path.exists(p)
            with open(p, "a") as fh:
                if new:
                    fh.write(json.dumps({"type": "custom-title", "customTitle": f"Invented task {sids.index(sid) % 3}"}) + "\n")
                fh.write(row(kind, f"{sid[:8]}-{n[0]}", last.get(sid), sid, text, time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now + n[0]))))
            last[sid] = f"{sid[:8]}-{n[0]}"
            os.utime(p, (now + n[0], now + n[0]))

        try:
            for sid in sids[:6]:
                append(sid, "user", "invented start")
            prev, fallbacks, patched = sessions.sessions(), 0, 0
            for step in range(60):
                sid, what, changed = rnd.choice(sids), rnd.random(), set()
                if what < 0.5:
                    append(sid, rnd.choice(("user", "assistant")), f"invented step {step}")
                    changed.add(sid)
                elif what < 0.75:
                    self.home.register(sid, status=rnd.choice(("busy", "idle", "waiting")))
                    regs.setdefault(sid, []).append(self.home.n)
                    changed.add(sid)
                elif what < 0.9 and regs:
                    gone = rnd.choice(sorted(regs))
                    for k in regs.pop(gone):
                        os.remove(os.path.join(self.home.home, "sessions", f"{k}.json"))
                    changed.add(gone)
                elif os.path.exists(os.path.join(proj, sid + ".jsonl")):
                    os.remove(os.path.join(proj, sid + ".jsonl"))
                    last.pop(sid, None)
                    changed.add(sid)
                quick = sessions.sessions_for(changed, settled=True)  # only the named and the active sessions looked at
                part = sessions.sessions_for(changed)
                self.assertEqual(json.dumps(quick), json.dumps(part), f"step {step}: settled answer differs")
                full = sessions.sessions()
                got = sessions.apply_partial(prev, part, sessions.day_of(sessions.CLOCK()))
                if got is None:
                    fallbacks += 1
                    self.assertTrue(set(part["order"]) - {o["id"] for o in prev} - {o["id"] for o in part["rows"]}, f"step {step}: needless fallback")
                else:
                    patched += 1
                    self.assertEqual(json.dumps(got), json.dumps(full), f"step {step}")
                self.assertEqual(part["order"], [o["id"] for o in full])
                prev = full
            self.assertGreater(patched, 40)
        finally:
            sessions.RECENT, sessions.RECENT_AUTO = saved

    def test_a_new_day_asks_for_the_full_list(self):
        part = sessions.sessions_for([])
        self.assertIsNone(sessions.apply_partial(sessions.sessions(), part, "1999-01-01"))


if __name__ == "__main__":
    unittest.main()
