"""tools/parity.py --report prints counts only, and its class counts add up to the sessions read."""
import os
import re
import subprocess
import sys
import unittest

from helpers import ROOT

CASES = os.path.join(ROOT, "tests", "fixtures", "cases")


class ReportTest(unittest.TestCase):
    def test_report_on_the_fixtures(self):
        out = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "parity.py"), "--home", CASES, "--report"], capture_output=True, text=True,
                             timeout=120).stdout
        sections = dict(re.findall(r"^(\S[^:\n]*):\n((?:  .*\n)*)", out, re.M))
        for name in ("sessions by class", "sessions by program (entrypoint)", "records by type", "anomalies", "sessions using a display rule",
                     "rows hidden, by reason"):
            self.assertIn(name, sections)
        total = int(re.search(r"^sessions: (\d+)", out, re.M).group(1))
        self.assertEqual(sum(int(x) for x in re.findall(r"(\d+)$", sections["sessions by class"], re.M)), total)
        self.assertIn("compaction", sections["sessions using a display rule"])
        for line in out.splitlines():
            self.assertRegex(line, r"^(sessions: \d+|\S[^:]*:|  .{1,40}\s+\d+)$")  # labels and numbers only


if __name__ == "__main__":
    unittest.main()
