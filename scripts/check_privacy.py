"""No addresses, hardware identifiers or personal details in the repo, which is meant to be public.

Secrets are gitleaks's job; this catches what gitleaks doesn't: LAN addresses, MAC addresses, email addresses, home
paths, and links to any host outside a short allowlist, since a private hostname is how a home gets found.
Zone names and entity ids are fine. Usage: python3 scripts/check_privacy.py [repo_root]
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ALLOWED_HOSTS = {
    "github.com", "raw.githubusercontent.com", "docs.github.com", "www.home-assistant.io", "home-assistant.io",
    "developers.home-assistant.io", "hacs.xyz", "www.gnu.org", "gnu.org", "fsf.org", "www.fsf.org",
    "fonts.googleapis.com", "fonts.gstatic.com", "openfontlicense.org", "scripts.sil.org", "vpdchart.com",
    "athenaag.com", "127.0.0.1", "localhost", "x.test", "example.com", "www.w3.org", "json.schemastore.org",
    "spdx.org", "keepachangelog.com",
}  # fmt: skip
ALLOWED_EMAILS = re.compile(r"^(\d+\+)?[A-Za-z0-9-]+@users\.noreply\.github\.com$|^noreply@github\.com$")
CHECKS = {
    "LAN address": re.compile(
        r"\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b"
    ),
    "MAC address": re.compile(r"\b[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(\1[0-9A-Fa-f]{2}){4}\b"),
    "home path": re.compile(r"/home/[a-z][a-z0-9_-]+/|/Users/[A-Za-z][^/\s]*/|C:\\\\Users\\\\"),
}
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
URL_HOST = re.compile(r"\b(?:https?|wss?)://([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")
SKIP_SUFFIXES = {".woff2", ".png", ".jpg", ".ico"}
SKIP_FILES = {"LICENSE", "frontend/package-lock.json", "frontend/fonts/OFL.txt", "scripts/check_privacy.py"}


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    ls = ["git", "-C", str(root), "ls-files"]
    files = subprocess.run(ls, capture_output=True, text=True, check=True).stdout.split()  # noqa: S603
    problems = []
    for name in files:
        if name in SKIP_FILES or Path(name).suffix in SKIP_SUFFIXES:
            continue
        text = (root / name).read_text(encoding="utf-8", errors="replace")
        for n, line in enumerate(text.splitlines(), 1):
            for label, rx in CHECKS.items():
                if rx.search(line):
                    problems.append(f"{name}:{n}: {label}")
            for m in EMAIL.finditer(line):
                if not ALLOWED_EMAILS.match(m.group(0)):
                    problems.append(f"{name}:{n}: email address")
            for m in URL_HOST.finditer(line):
                host = m.group(1).lower().rstrip(".")
                if host not in ALLOWED_HOSTS:
                    problems.append(f"{name}:{n}: link to {host}, not on the allowlist")
    for p in problems:
        print(f"FAIL {p}")
    print(f"privacy: {'FAIL' if problems else 'PASS'} ({len(files)} files)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
