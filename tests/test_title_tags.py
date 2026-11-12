"""Titles never hold a tag (the app's own step beyond the resume picker): typed words, else the wrapped text, else the picker's fallback."""
import unittest

import helpers  # noqa: F401  (puts the app folder on the path)
from desk import sessions, transcripts as tx

FORMS = [
    ('fix this <pasted_content id="ab12">pasted body</pasted_content id="ab12">', "fix this"),
    ('<pasted_content id="zz" x="1">only pasted words here</pasted_content>', "only pasted words here"),
    ("look at <pasted_content>unclosed wrapper text", "look at unclosed wrapper text"),
    ('please check <pasted_content id="1"', "please check"),
    ("<b>bold</b> and <i>more</i> words", "<b>bold</b> and <i>more</i> words"),
    ("Vec<T> refactor in <Button> props", "Vec<T> refactor in <Button> props"),
    ("<system-reminder>injected</system-reminder> real words", "real words"),
    ("<x-tag/>", ""),
    ("no tags at all", "no tags at all"),
    ("a < b and c > d", "a < b and c > d"),
]


class TitleTagTest(unittest.TestCase):
    def test_each_form(self):
        for raw, want in FORMS:
            self.assertEqual(tx.no_tags(raw), want, raw)

    def test_mission_falls_back_when_only_tags(self):
        d = {"title": None, "promptTitle": "", "fallback": "c0000001"}
        self.assertEqual(sessions.mission(d, None), "c0000001")
        d = {"title": "<x-tag></x-tag>", "titleAuto": False, "promptTitle": "typed words", "fallback": "c0000001"}
        self.assertEqual(sessions.mission(d, None), "typed words")
        d = {"title": 'Own <pasted_content id="1">x</pasted_content> name', "titleAuto": False, "promptTitle": "p", "fallback": "f"}
        self.assertEqual(sessions.mission(d, None), "Own name")


if __name__ == "__main__":
    unittest.main()
