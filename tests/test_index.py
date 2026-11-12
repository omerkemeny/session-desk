"""The per-file list index: the list it drives equals a cold read and the plain rule (every file in time order) while files change, appear and vanish."""
import json
import os
import random
import time
import unittest

from helpers import FakeHome
from desk import sessions, summaries, transcripts as tx


def rows(sid, n, auto, ts):
    """An invented session: n prompt/reply pairs, typed or automated (sdk turn origin), optionally continued elsewhere."""
    out = []
    for i in range(n):
        u = {"type": "user", "uuid": f"{sid[:8]}u{i}", "parentUuid": f"{sid[:8]}a{i - 1}" if i else None, "isSidechain": False, "timestamp": ts,
             "entrypoint": "cli", "cwd": "/work/idx", "sessionId": sid, "turnOrigin": "sdk" if auto else "human",
             "message": {"role": "user", "content": f"invented task {sid[:4]} {i}"}}
        a = {"type": "assistant", "uuid": f"{sid[:8]}a{i}", "parentUuid": u["uuid"], "isSidechain": False, "timestamp": ts, "entrypoint": "cli",
             "cwd": "/work/idx", "sessionId": sid, "message": {"id": f"m{sid[:8]}{i}", "role": "assistant", "model": "m",
                                                                "content": [{"type": "text", "text": "invented reply"}], "usage": {"input_tokens": 1, "output_tokens": 1}}}
        out += [json.dumps(u), json.dumps(a)]
    return "\n".join(out) + "\n"


def reference(paths):
    """The plain rule over every file: active first, then newest finished ones per class that show something and were not continued."""
    keep = set(sessions.live(sessions.holders()))
    found = sorted(((sessions.stat_key(os.stat(p)), p) for p in paths), key=lambda x: (-x[0][0], x[1]))
    room, out = {False: sessions.RECENT, True: sessions.RECENT_AUTO}, []
    for st, p in [x for x in found if tx.session_id(x[1]) in keep] + [x for x in found if tx.session_id(x[1]) not in keep]:
        mine = tx.session_id(p) in keep
        d = sessions.view(sessions.parse(p))
        if not d["shown"] or (d["continuedIn"] and not mine and tx.find(d["continuedIn"])):
            continue
        if not mine:
            if not room[d["automated"]]:
                continue
            room[d["automated"]] -= 1
        out.append(tx.session_id(p))
    return out


def cold():
    """Forget every cache, the index and the kept order, so the next list reads like a fresh start."""
    sessions._cache.clear(), sessions._views.clear(), sessions._full.clear(), tx._states.clear(), tx._found.clear()
    summaries.reset()


class IndexTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.proj = os.path.join(self.home.home, "projects", "-work-idx")
        os.makedirs(self.proj)
        self.saved = sessions.RECENT, sessions.RECENT_AUTO
        sessions.RECENT, sessions.RECENT_AUTO = 6, 6
        self.parses = 0
        self.real = sessions._read

        def counted(path, **kw):
            """Count transcript reads."""
            self.parses += 1
            return self.real(path, **kw)
        sessions._read = counted

    def tearDown(self):
        sessions._read = self.real
        sessions.RECENT, sessions.RECENT_AUTO = self.saved
        cold()
        self.home.close()

    def make(self, i, auto, t, extra=""):
        """Write session i with a given mtime."""
        sid = f"{i:08x}-0000-4000-8000-{i:012x}"
        p = os.path.join(self.proj, sid + ".jsonl")
        with open(p, "w") as fh:
            fh.write(rows(sid, 1 + i % 3, auto, time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(t))) + extra)
        os.utime(p, (t, t))
        return p

    def check(self, label):
        """Warm list equals a cold list and the plain rule; the partial answer for one id equals the full list's row."""
        paths = [p for p in tx.session_paths()]
        warm = sessions.sessions()
        want = reference(paths)
        self.assertEqual([o["id"] for o in warm], want, label)
        if warm:
            sid = warm[len(warm) // 2]["id"]
            part = sessions.sessions_for({sid}, settled=True)
            self.assertEqual(part["order"], want, label)
            self.assertEqual(json.dumps([o for o in warm if o["id"] == sid]), json.dumps([o for o in part["rows"] if o["id"] == sid]), label)
        keys = {p: sessions.stat_key(os.stat(p)) for p in paths}  # the change feed's map, other file names included
        keys[os.path.join(self.proj, "notes-copy.jsonl")] = (1, 1, 1, 1)
        self.assertEqual(json.dumps(sessions.sessions(keys=keys, hold=sessions.holders())), json.dumps(warm), label)
        self.assertEqual(sessions.sessions_for({warm[0]["id"]} if warm else set(), keys=keys, hold=sessions.holders())["order"], [o["id"] for o in warm], label)
        summaries.flush()
        saved = dict(summaries.index())
        cold()
        self.assertEqual(json.dumps(sessions.sessions()), json.dumps(warm), label)
        self.assertEqual(summaries.index(), saved, label)  # the index read back from the file equals the one in memory
        return warm

    def test_one_class_never_fills(self):
        rnd, now, n = random.Random(7), time.time() - 5000, 120
        paths = {i: self.make(i, i % 40 == 0, now + i) for i in range(n)}  # 3 automated: that class never fills
        self.check("start")
        self.parses = 0
        sessions.sessions()
        self.assertEqual(self.parses, 0)  # warm: nothing read again
        for step in range(40):
            what, t = rnd.random(), now + n + step
            if what < 0.4:
                i = rnd.randrange(n)
                paths[i] = self.make(i, i % 40 == 0, t)
            elif what < 0.6:
                n += 1
                paths[n] = self.make(n, rnd.random() < 0.1, t)
            elif what < 0.75 and len(paths) > 20:
                i = rnd.choice(sorted(paths))
                os.remove(paths.pop(i))
            elif what < 0.85:
                i = rnd.choice(sorted(paths))
                tgt = rnd.choice(sorted(paths))
                with open(paths[i], "a") as fh:
                    fh.write(json.dumps({"type": "continued-in", "continuedInSessionId": tx.session_id(paths[tgt])}) + "\n")
                os.utime(paths[i], (t, t))
            else:
                i = rnd.randrange(n + 1)
                p = self.make(1000 + i, False, t, extra="")
                with open(p, "w") as fh:
                    fh.write(json.dumps({"type": "custom-title", "customTitle": "nothing to show"}) + "\n")  # never shown
                os.utime(p, (t, t))
            self.parses = 0
            self.check(f"step {step}")

    def test_partial_touches_only_the_named_files(self):
        now = time.time() - 5000
        sessions.RECENT = 60
        paths = [self.make(i, False, now + i) for i in range(200)]
        full = sessions.sessions()
        self.parses, stats = 0, []
        real_stat = os.stat
        t = now + 300
        with open(paths[3], "a") as fh:
            fh.write(rows(tx.session_id(paths[3]), 1, False, "2026-06-15T09:00:00.000Z").replace('"parentUuid": null', '"parentUuid": "x"'))
        os.utime(paths[3], (t, t))
        try:
            os.stat = lambda p, *a, **k: (stats.append(p), real_stat(p, *a, **k))[1]
            part = sessions.sessions_for({tx.session_id(paths[3])}, settled=True)
        finally:
            os.stat = real_stat
        self.assertEqual({str(p) for p in stats if str(p).endswith('.jsonl')}, {paths[3]})  # only the named file is looked at
        self.assertEqual(self.parses, 1)
        self.assertEqual(part["order"], [o["id"] for o in sessions.sessions()])
        self.assertNotEqual(part["order"], [o["id"] for o in full])


if __name__ == "__main__":
    unittest.main()
