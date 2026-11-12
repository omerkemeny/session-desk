"""GET /api/sessions?ids=: guards, limits, and rows equal to the full list's."""
import json
import unittest
from unittest import mock

from helpers import S1, S2, S3, FakeHome, Served
from desk import events, sessions


class PartialListTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.srv = Served()

    def tearDown(self):
        self.srv.close()
        self.home.close()

    def test_rows_equal_the_full_list(self):
        self.home.register(S1, status="busy")
        status, full = self.srv.json("/api/sessions")
        self.assertEqual(status, 200)
        by_id = {r["id"]: r for r in full}
        missing = "abcdef12-0000-4000-8000-00000000dead"
        status, part = self.srv.json(f"/api/sessions?ids={S2},{S1},{missing},{S1}")
        self.assertEqual(status, 200)
        self.assertEqual(sorted(part), ["gone", "n", "order", "rows", "today"])
        self.assertEqual([r["id"] for r in part["rows"]], [r["id"] for r in full if r["id"] in (S1, S2) or r["status"] != "done"])
        self.assertEqual(part["order"], [r["id"] for r in full])
        self.assertRegex(part["today"], r"^\d{4}-\d{2}-\d{2}$")
        for r in part["rows"]:
            self.assertEqual(json.dumps(r), json.dumps(by_id[r["id"]]))
        self.assertEqual(part["gone"], [missing])
        self.assertEqual(part["n"], events._feed["count"])
        from test_contract import tables
        self.assertEqual(set(part), set(tables()["sessions.partial"]), "docs/api.md sessions.partial differs from what is sent")

    def test_bad_ids_and_limits(self):
        for q in ("ids=", "ids=,", "ids=../etc", f"ids={S1},x", f"ids={S1}&ids={S2}", "ids=" + ",".join([S1] * 50 + [S3[:-3] + f"{i:03x}" for i in range(51)]),
                  "ids=" + "a" * 7000, f"ids={S1}%00"):
            status, body = self.srv.json("/api/sessions?" + q)
            self.assertEqual(status, 400, q[:60])
            self.assertIn("error", body)
        ids = ",".join(S3[:-3] + f"{i:03x}" for i in range(100))
        status, body = self.srv.json("/api/sessions?ids=" + ids)
        self.assertEqual((status, len(body["gone"])), (200, 100))

    def test_uses_the_data_module_function_when_present(self):
        canned = {"rows": [], "gone": [S1], "order": [], "today": "2026-01-01"}
        with mock.patch.object(sessions, "sessions_for", create=True, return_value=canned) as fn:
            status, body = self.srv.json(f"/api/sessions?ids={S1}")
        fn.assert_called_once_with([S1])
        self.assertEqual((status, body), (200, dict(canned, n=events._feed["count"])))
        with mock.patch.object(sessions, "PARTIAL_MAX", 2, create=True):
            self.assertEqual(self.srv.json(f"/api/sessions?ids={S1},{S2},{S3}")[0], 400)

    def test_same_guards_as_the_full_list(self):
        for path in (f"/api/sessions?ids={S1}", "/api/sessions"):
            self.assertEqual(self.srv.request("GET", path, headers={"Host": "evil.example:80"})[0], 403)
            self.assertEqual(self.srv.request("GET", path, headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
            status, headers, _ = self.srv.request("GET", path)
            self.assertEqual((status, headers.get("X-Frame-Options")), (200, "DENY"))
        self.assertEqual(self.srv.request("POST", f"/api/sessions?ids={S1}")[0], 403)


if __name__ == "__main__":
    unittest.main()
