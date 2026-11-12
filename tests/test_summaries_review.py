"""Review of the on-disk summary cache (desk/summaries.py): each open finding is a test that fails today, skipped unless DESK_REVIEW=1."""
import json
import os
import subprocess
import sys
import time
import unittest
from unittest import mock

from helpers import ROOT, S1, FakeHome
from desk import durable, sessions, summaries

REVIEW = os.environ.get("DESK_REVIEW") == "1"


def finding(text):
    """Skip a test that shows an open finding, unless DESK_REVIEW=1 asks to see it fail."""
    return (lambda f: f) if REVIEW else unittest.skip("FINDING: " + text)


class Base(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.file = summaries.cache_file()

    def tearDown(self):
        self.home.close()

    def listed(self):
        """Title of S1 as the list shows it."""
        return next(o for o in sessions.sessions() if o["id"] == S1)["title"]

    def cache_s1(self):
        """Build the list once, write the cache file, and forget everything in memory."""
        self.listed()
        self.assertTrue(summaries.flush())
        sessions._views.clear()
        sessions._cache.clear()
        summaries.reset()

    def write(self, data):
        """Replace the cache file with raw bytes."""
        with open(self.file, "wb") as fh:
            fh.write(data)


class CorrectnessTest(Base):
    def test_deep_nesting_is_rejected_not_raised(self):
        self.write(b"[" * 200000 + b"]" * 200000)
        self.assertEqual(summaries.read(self.file)[0], {})
        summaries.reset()
        self.assertIsInstance(sessions.sessions(), list)

    def test_same_size_same_mtime_rewrite_is_not_served_stale(self):
        p = self.home.path(S1)
        with open(p, "a") as fh:
            fh.write(json.dumps({"type": "custom-title", "customTitle": "Alpha one", "sessionId": S1}) + "\n")
        st = os.stat(p)
        self.cache_s1()
        self.assertEqual(self.listed(), "Alpha one")
        sessions._views.clear()
        sessions._cache.clear()
        summaries.reset()
        with open(p, "rb") as fh:
            data = fh.read()
        with open(p, "r+b") as fh:
            fh.write(data.replace(b"Alpha one", b"Omega two"))  # same length, in place
        os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.assertEqual(self.listed(), "Omega two")

    def test_views_of_older_code_are_not_stamped_as_newer(self):
        with mock.patch.object(summaries, "code_mark", return_value="old-code"):
            self.listed()
        with mock.patch.object(summaries, "code_mark", return_value="new-code"):
            summaries.flush()
            self.assertEqual(summaries.read(self.file)[0], {})

    def test_wrong_shape_and_foreign_files_are_ignored(self):
        self.cache_s1()
        good = json.load(open(self.file))
        for bad in (b"", b"{", b"null", b"[]", b'{"v": 1}', json.dumps(dict(good, home="/elsewhere")).encode(),
                    json.dumps(dict(good, code="other")).encode(), json.dumps(dict(good, v=summaries.VERSION + 1)).encode()):
            self.write(bad)
            self.assertEqual(summaries.read(self.file)[0], {}, bad[:40])
        first = next(iter(good["entries"]))
        for view in ({"title": 5}, dict(good["entries"][first][1], tokens=-1), dict(good["entries"][first][1], updated=True),
                     dict(good["entries"][first][1], ask="x" * 401)):
            self.write(json.dumps(dict(good, entries={first: [good["entries"][first][0], view]})).encode())
            self.assertEqual(summaries.read(self.file)[0], {})

    def test_entries_outside_the_data_folder_are_dropped(self):
        self.cache_s1()
        good = json.load(open(self.file))
        k, e = next(iter(good["entries"].items()))
        root = os.path.join(os.path.realpath(self.home.home), "projects")
        self.write(json.dumps(dict(good, entries={root + "/../../../etc/x.jsonl": e})).encode())
        self.assertEqual(summaries.read(self.file)[0], {})

    def test_huge_numbers_are_rejected(self):
        self.cache_s1()
        good = json.load(open(self.file))
        k, e = next(iter(good["entries"].items()))
        e[1]["tokens"] = 10 ** 30
        self.write(json.dumps(dict(good, entries={k: e})).encode())
        self.assertEqual(summaries.read(self.file)[0], {})

    def test_large_file_is_not_read(self):
        with open(self.file, "wb") as fh:
            fh.truncate(summaries.MAX_BYTES + 1)
        t = time.monotonic()
        self.assertEqual(summaries.read(self.file), ({}, 1))
        self.assertLess(time.monotonic() - t, 1)

    def test_changed_transcript_is_parsed_again(self):
        self.cache_s1()
        with open(self.home.path(S1), "a") as fh:
            fh.write(json.dumps({"type": "custom-title", "customTitle": "Fresh name", "sessionId": S1}) + "\n")
        self.assertEqual(self.listed(), "Fresh name")


class TrustTest(Base):
    def test_writable_by_others_is_not_trusted(self):
        self.cache_s1()
        os.chmod(self.file, 0o666)
        self.assertEqual(summaries.read(self.file)[0], {})

    def test_symlink_is_not_followed(self):
        self.cache_s1()
        real = self.file + ".elsewhere"
        os.rename(self.file, real)
        os.symlink(real, self.file)
        self.assertEqual(summaries.read(self.file)[0], {})

    def test_file_mode_and_privacy(self):
        self.cache_s1()
        self.assertEqual(os.stat(self.file).st_mode & 0o777, 0o600)
        with open(os.path.join(ROOT, ".gitignore")) as fh:
            self.assertIn(".stats-cache*", fh.read().split())
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        import make_zip
        self.assertFalse(make_zip.wanted(".stats-cache-0123456789ab-summaries.json"))
        self.assertFalse(make_zip.wanted(".stats-cache-0123456789ab-summaries.json.123-456.tmp"))
        stored = json.load(open(self.file))["entries"]
        self.assertTrue(all(set(e[1]) == set(summaries.SHAPE) for e in stored.values()))  # capped list fields only, no transcript bodies

    def test_stale_temp_of_a_dead_writer_is_removed(self):
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        tmp = f"{self.file}.{dead.pid}-1.tmp"
        with open(tmp, "w") as fh:
            fh.write("{half")
        self.listed()
        self.assertTrue(summaries.flush())
        self.assertFalse(os.path.exists(tmp), "a crashed writer's temp file (with private text) stays forever")

    def test_two_writers_never_leave_a_torn_file(self):
        self.listed()
        code = ("import sys; sys.path.insert(0, %r); from desk import durable\n"
                "for i in range(200): durable.write(%r, (b'{\"v\": %%d}' %% i) * 2000)") % (ROOT, self.file)
        procs = [subprocess.Popen([sys.executable, "-c", code]) for _ in range(2)]
        for _ in range(50):
            summaries._state["dirty"] = True
            summaries.flush()
            with open(self.file, "rb") as fh:
                data = fh.read()
            self.assertTrue(data.startswith(b'{"v"'), data[:20])
        for p in procs:
            self.assertEqual(p.wait(30), 0)


class RaceTest(Base):
    def test_append_during_parse_never_pins_old_text_to_new_key(self):
        p = self.home.path(S1)
        st = os.stat(p)
        real = sessions._parse

        def slow(path, stat):
            """Parse, while the CLI appends after the stat."""
            if path == p:
                with open(p, "a") as fh:
                    fh.write(json.dumps({"type": "custom-title", "customTitle": "Late name", "sessionId": S1}) + "\n")
            return real(path, stat)
        with mock.patch.object(sessions, "_parse", slow):
            sessions.list_view(p, st)
        self.assertEqual(self.listed(), "Late name")  # the stored key is the older stat: a later look re-parses


if __name__ == "__main__":
    unittest.main()
