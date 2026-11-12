#!/usr/bin/env python3
"""Build dist/session-desk.zip: what a new person needs to run the app (server.py, desk/, web/ and docs/ without tests, README.md); refuses personal paths."""
import argparse
import getpass
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "dist", "session-desk.zip")
TOP = "session-desk"  # folder name inside the zip
FILES = ("server.py", "README.md")
DIRS = ("desk", "web", "docs")
NEEDED = ("server.py", "desk", "web")  # docs/ and README.md ship when present
SKIP_DIRS = {"tests", "__pycache__", "node_modules", "dist"}
STAMP = (2026, 1, 1, 0, 0, 0)  # fixed entry time so the same tree gives the same zip
HOME_PATH = re.compile(rb"/(?:Users|home)/[A-Za-z0-9._-]+")  # any absolute home folder path
PICTURES = os.path.join("docs", "img")  # left out by --no-pictures
PICTURE = re.compile(rb"!\[([^\]]*)\]\((?:\.\./)?(?:docs/)?img/[^)\s]+\)")  # a Markdown picture line pointing into docs/img


def wanted(name):
    """False for dotfiles (stats caches, run folders, .git included), QA round reports, bytecode and editor leftovers; everything else under the listed folders ships."""
    return not name.startswith((".", "qa-round", "scale-round")) and not name.endswith((".pyc", ".pyo", ".tmp", ".log", "~"))


def collect(root=ROOT, pictures=True):
    """Sorted relative paths of every file that goes into the zip; without pictures, nothing under docs/img."""
    out = [f for f in FILES if os.path.isfile(os.path.join(root, f))]
    for top in DIRS:
        for base, dirs, names in os.walk(os.path.join(root, top)):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
            for n in names:
                full = os.path.join(base, n)
                rel = os.path.relpath(full, root)
                if wanted(n) and os.path.isfile(full) and not os.path.islink(full) and (pictures or not rel.startswith(PICTURES + os.sep)):
                    out.append(rel)
    return sorted(out)


def without_pictures(data):
    """A Markdown file's text with each picture replaced by its alt text, so it reads well with no images beside it."""
    return PICTURE.sub(lambda m: b"*Picture, not in this download: " + m.group(1) + b"*", data)


def personal(data, words):
    """Personal markers found in a file: home folder paths and the builder's own names."""
    low = data.lower()
    return HOME_PATH.findall(data) + [w for w in words if w and w in low]


def build(out=OUT, root=ROOT, pictures=True):
    """Write the zip (without docs/img and with alt texts for pictures when pictures is False); returns (file count, size); exits on personal paths."""
    missing = [f for f in NEEDED if not os.path.exists(os.path.join(root, f))]
    if missing:
        sys.exit(f"missing from the tree: {', '.join(missing)}")
    words = {getpass.getuser().lower().encode(), os.path.expanduser("~").lower().encode()}
    files = collect(root, pictures)
    hits = {}
    for rel in files:
        with open(os.path.join(root, rel), "rb") as fh:
            found = personal(fh.read(), words)
        if found:
            hits[rel] = len(found)
    if hits:
        sys.exit("personal paths or names in: " + ", ".join(f"{k} ({n})" for k, n in sorted(hits.items())))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    tmp = out + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in files:
            info = zipfile.ZipInfo(f"{TOP}/{rel.replace(os.sep, '/')}", STAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if rel == "server.py" else 0o644) << 16
            with open(os.path.join(root, rel), "rb") as fh:
                data = fh.read()
            z.writestr(info, data if pictures or not rel.endswith(".md") else without_pictures(data))
    os.replace(tmp, out)
    return len(files), os.path.getsize(out)


def main():
    """Build to --out (default dist/session-desk.zip), then print its file count and size."""
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--no-pictures", action="store_true", help="leave out docs/img; the docs show each picture's description instead")
    a = ap.parse_args()
    out = a.out
    n, size = build(out, pictures=not a.no_pictures)
    print(f"{out}: {n} files, {size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
