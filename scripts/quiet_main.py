"""Whether a merge is still the newest on main once merges have stopped arriving.

Run by the Beta workflow before it numbers a beta. Several pull requests merged one after another would otherwise each
make a beta of their own, each waiting for approval, when the last one holds everything. So a merge waits here until
main has been quiet for a while. If a newer merge lands in that time this one makes no beta, because the newer merge's
beta includes it. Prints one GitHub Actions output, newest (true or false). Usage: python3 scripts/quiet_main.py
<commit>
"""

from __future__ import annotations

import re
import subprocess
import sys
import time

COMMIT = re.compile(r"^[0-9a-f]{40}$")
# How long main has to go without a newer merge before this one makes a beta. Long enough to merge the next pull
# request in a batch, short enough that a single merge isn't kept waiting.
QUIET_S = 300
# How often main is looked at while waiting, so a merge that has been overtaken gives way promptly.
POLL_S = 20


def decide(commit: str, head: str, merged_at: float, now: float, quiet: float = QUIET_S) -> str:
    """skip when main has moved past this merge, go once it has been the newest for the quiet time, wait until then.

    The quiet time runs from the merge itself, not from when this run started, so a run that waited in the queue
    behind an earlier one doesn't wait all over again, and one started again by hand later doesn't wait at all.
    """
    if head != commit:
        return "skip"
    return "go" if now - merged_at >= quiet else "wait"


def _git(*args: str) -> str:
    # Fixed subcommands; the only value passed in is a commit matching COMMIT.
    cmd = ["git", *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout  # noqa: S603


def head_of_main() -> str:
    """The commit main is at on GitHub now, not as it was when this run checked it out."""
    out = _git("ls-remote", "origin", "refs/heads/main").split()
    if not out or not COMMIT.match(out[0]):
        # Never guess: with no answer a beta of an overtaken merge could go out, so the run fails instead.
        raise RuntimeError("couldn't read where main is")
    return out[0]


def main(argv: list[str]) -> int:
    commit = argv[1] if len(argv) > 1 else ""
    if not COMMIT.match(commit):
        print(f"{commit!r} isn't a full commit SHA", file=sys.stderr)
        return 2
    merged_at = float(_git("log", "-1", "--format=%ct", commit).strip())
    while True:
        verdict = decide(commit, head_of_main(), merged_at, time.time())
        if verdict != "wait":
            print(f"newest={'true' if verdict == 'go' else 'false'}")
            return 0
        time.sleep(max(1.0, min(POLL_S, merged_at + QUIET_S - time.time())))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
