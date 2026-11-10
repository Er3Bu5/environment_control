"""The next beta after the newest release tag, and whether anything that ships has changed since that release.

Run by the Beta workflow once Validate has passed on a merge to main. Prints GitHub Actions outputs: version, ship
(true or false) and since (the release it was compared with). Usage: python3 scripts/next_beta.py <commit>
"""

from __future__ import annotations

import re
import subprocess
import sys

TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:b(\d+))?$")
COMMIT = re.compile(r"^[0-9a-f]{7,40}$")
# What a release zip is built from. A merge that touches none of it (docs, the design mock, tests, CI) has nothing new
# to offer, so it makes no beta.
SHIPS = (
    "custom_components/environment_control/",
    "frontend/src/",
    "frontend/build.mjs",
    "frontend/package.json",
    "frontend/package-lock.json",
    "hacs.json",
)


def _key(tag: str) -> tuple[int, int, int, float]:
    m = TAG.match(tag)
    assert m
    major, minor, patch, beta = m.groups()
    # A full release sorts after every beta of its own version.
    return int(major), int(minor), int(patch), int(beta) if beta else float("inf")


def newest(tags: list[str]) -> str | None:
    """The newest release tag, beta or full, ignoring anything that isn't one."""
    found = [t for t in tags if TAG.match(t)]
    return max(found, key=_key) if found else None


def next_beta(tags: list[str]) -> str:
    """After a beta comes the next beta of the same version; after a full release, the first beta of the next patch."""
    latest = newest(tags)
    if latest is None:
        return "0.1.0b1"
    m = TAG.match(latest)
    assert m
    major, minor, patch, beta = m.groups()
    return f"{major}.{minor}.{patch}b{int(beta) + 1}" if beta else f"{major}.{minor}.{int(patch) + 1}b1"


def ships(paths: list[str]) -> bool:
    return any(p == s or (s.endswith("/") and p.startswith(s)) for p in paths for s in SHIPS)


def _git(*args: str) -> str:
    # Fixed subcommands; the only values passed in are a release tag matching TAG and a commit matching COMMIT.
    cmd = ["git", *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout  # noqa: S603


def main(argv: list[str]) -> int:
    commit = argv[1] if len(argv) > 1 else ""
    if not COMMIT.match(commit):
        print(f"{commit!r} isn't a commit SHA", file=sys.stderr)
        return 2
    tags = _git("tag", "--list", "v*").split()
    latest = newest(tags)
    changed = _git("diff", "--name-only", latest, commit).split() if latest else []
    ship = latest is None or ships(changed)
    print(f"version={next_beta(tags)}")
    print(f"ship={'true' if ship else 'false'}")
    print(f"since={latest or ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
