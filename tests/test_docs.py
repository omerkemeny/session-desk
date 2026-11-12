"""README.md and docs/guide.md against the code: settings, verbs, links, file names, Python version, wording."""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = ("README.md", os.path.join("docs", "guide.md"))
# Files and folders the app writes itself, so they are not in the tree.
CREATED = {".stats-cache.json", ".stats-cache-summaries.json", ".stats-cache-<code>.json", ".desk-run/", ".desk-run-<code>/"}
FILEISH = re.compile(r"^[\w./<>-]+(\.(py|md|js|mjs|json|html|css|png|sh)|/)$")  # a backticked span that names a file or folder
ENV_READ = (r"os\.environ\.get\(\s*[\"']([A-Z_]+)[\"']", r"os\.environ\[[\"']([A-Z_]+)[\"']\]", r"[\"']([A-Z_]+)[\"']\s+in\s+os\.environ", r"os\.getenv\(\s*[\"']([A-Z_]+)[\"']")


def read(rel):
    """Text of a file under the tree."""
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        return fh.read()


def anchors(path):
    """Heading anchors of a Markdown file, as a code host makes them."""
    with open(path, encoding="utf-8") as fh:
        heads = re.findall(r"^#+ (.+)$", fh.read(), re.M)
    return {re.sub(r"[^\w\- ]", "", h.strip().lower()).replace(" ", "-") for h in heads}


def message_source():
    """Every string the app can show: server and page code, with Python's split string literals joined."""
    rels = code_files() + ["web/index.html"] + [os.path.join("web", "src", n) for n in sorted(os.listdir(os.path.join(ROOT, "web", "src"))) if n.endswith(".js")]
    return re.sub(r"[\"']\s*\n\s*f?[\"']", "", "\n".join(read(r) for r in rels))


def fragments(quote):
    """The literal pieces of a quoted message: placeholders (N, M, PORT, <dir>, ..., 'abc', versions) and clause breaks removed."""
    parts = re.split(r"\.\.\.|<dir>|'abc'|\b\d\.\d\b|\bN\b|\bM\b|\bPORT\b(?!=)|: |; ", quote)
    return [p.strip(" .,") for p in parts if len(p.strip(" .,")) >= 6]


def code_files():
    """server.py and every module of desk/."""
    return ["server.py"] + [os.path.join("desk", n) for n in sorted(os.listdir(os.path.join(ROOT, "desk"))) if n.endswith(".py")]


def env_vars():
    """Every environment variable the server code reads."""
    found = set()
    for rel in code_files():
        text = read(rel)
        for pat in ENV_READ:
            found.update(re.findall(pat, text))
    return found


def settings_rows():
    """Variable names in the first column of the README's Settings table."""
    sec = read("README.md").split("\n## Settings", 1)[1].split("\n## ", 1)[0]
    return set(re.findall(r"^\| `([A-Z_]+)` \|", sec, re.M))


def ctl_verbs():
    """Verbs `python3 server.py` accepts, read from desk/ctl.py."""
    text = read(os.path.join("desk", "ctl.py"))
    table = re.search(r"verbs = \{(.*?)\}", text).group(1)
    return set(re.findall(r"\"([-a-z]+)\":", table)) | set(re.findall(r"argv == \[\"([a-z]+)\"\]", text))


class DocsTest(unittest.TestCase):
    """Each check names the doc and what is wrong."""

    def test_settings_table_matches_code(self):
        code, table = env_vars(), settings_rows()
        self.assertTrue(code)
        self.assertEqual(code - table, set(), "read by the code but missing from the README settings table")
        self.assertEqual(table - code, set(), "in the README settings table but never read by the code")

    def test_verbs_match_ctl(self):
        accepted, used = ctl_verbs(), set()
        for doc in DOCS:
            used |= set(re.findall(r"python3 server\.py ((?:--)?[a-z][a-z-]*)", read(doc)))
        self.assertEqual(used - accepted, set(), "verbs in the docs that server.py does not accept")
        self.assertEqual(accepted - used, set(), "verbs server.py accepts that the docs never show")

    def test_relative_links_exist(self):
        for doc in DOCS:
            base = os.path.dirname(os.path.join(ROOT, doc))
            for target in re.findall(r"\]\(([^)\s]+)\)", read(doc)):
                if re.match(r"[a-z]+:", target):
                    continue
                path, _, frag = target.partition("#")
                full = os.path.join(base, path) if path else os.path.join(ROOT, doc)
                self.assertTrue(os.path.exists(full), f"{doc}: link {target} points at nothing")
                if frag:
                    self.assertIn(frag, anchors(full), f"{doc}: link {target} names no heading")

    def test_file_names_exist(self):
        names = {os.path.basename(p.rstrip("/")) for p in self.tree()}
        for doc in DOCS:
            for span in re.findall(r"`([^`\n]+)`", read(doc)):
                if not FILEISH.match(span) or span.startswith(("~", "/")) or span in CREATED:
                    continue
                if "/" in span.rstrip("/"):
                    ok = os.path.exists(os.path.join(ROOT, span))
                else:
                    ok = span.rstrip("/") in names
                self.assertTrue(ok, f"{doc}: `{span}` is neither in the tree nor a file the app creates")

    def tree(self):
        """Every file and folder path under the tree, skipping dot folders."""
        out = []
        for base, dirs, files in os.walk(ROOT):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            out += [os.path.join(base, n) for n in dirs + files]
        return out

    def test_troubleshooting_quotes_are_the_apps_words(self):
        table = read("README.md").split("\n## Troubleshooting", 1)[1].split("\n## ", 1)[0]
        src, seen = message_source(), 0
        for row in re.findall(r"^\| (.+?) \| .+ \| .+ \|$", table, re.M):
            for quote in re.findall(r"``(.+?)``|`([^`]+)`", row):
                text = quote[0] or quote[1]
                if " " not in text or text.startswith(("python3 ", "DESK_", "PORT=")):
                    continue
                for frag in fragments(text):
                    seen += 1
                    self.assertIn(frag, src, f"README troubleshooting quotes words the app never prints: {frag!r}")
        self.assertGreater(seen, 20)

    def test_no_port_in_links_but_the_default(self):
        default = re.search(r"os\.environ\.get\(\"PORT\", \"(\d+)\"\)", read(os.path.join("desk", "config.py"))).group(1)
        for doc in DOCS + ("VERSIONS.md",):
            for n, line in enumerate(read(doc).splitlines(), 1):
                for host, port, path in re.findall(r"(127\.0\.0\.1|localhost):(\d+)(/\S*)?", line):
                    self.assertEqual(port, default, f"{doc}:{n} names port {port}")
                    self.assertFalse((path or "").startswith("/api"), f"{doc}:{n} links an API path on a fixed port")

    def test_readme_names_minimum_python(self):
        major, minor = re.search(r"MIN_PY = \((\d+), (\d+)\)", read("server.py")).groups()
        self.assertIn(f"Python {major}.{minor} or newer", read("README.md"))

    def test_no_round_numbers_or_home_paths(self):
        for doc in DOCS:
            for n, line in enumerate(read(doc).splitlines(), 1):
                self.assertIsNone(re.search(r"\brounds? *\d", line, re.I), f"{doc}:{n} mentions a round number")
                self.assertIsNone(re.search(r"/(Users|home)/[\w.-]+", line), f"{doc}:{n} holds a home folder path")


if __name__ == "__main__":
    unittest.main()
