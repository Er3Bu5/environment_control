"""npm audit for the frontend, failing on any advisory of moderate severity or above unless it is listed in IGNORED.

npm has no way to set one advisory aside, so `npm audit --audit-level=moderate` fails every pull request for as long
as an advisory has no fixed version, even when it can't reach anything that ships. Each entry in IGNORED is one
advisory, by its GHSA id, with why it is safe here and a date to look at it again. The check fails once that date has
passed, and fails when an ignored advisory no longer appears, so the entry is removed once a fix lands rather than left
to hide a later one. Usage, from frontend/: python3 ../scripts/check_npm_audit.py
"""

from __future__ import annotations

import datetime
import json
import subprocess
import sys

SEVERITY = {"info": 0, "low": 1, "moderate": 2, "high": 3, "critical": 4}
FAIL_FROM = SEVERITY["moderate"]


# Each entry is "GHSA-xxxx-xxxx-xxxx": {"package": name, "review_by": "YYYY-MM-DD"}, under a comment saying when it was
# added and why it can't reach anything that ships. Empty since 2026-11-27: the one entry so far, a picomatch ReDoS
# (GHSA-fc5q-39xc-vjpf), was withdrawn by its publisher on the day it was added.
IGNORED: dict[str, dict[str, str]] = {}


def advisories(report: dict) -> dict[str, dict]:
    """Every advisory in an npm audit --json report, by GHSA id. A package that is vulnerable only because it depends
    on another lists that package's name instead of an advisory, so the advisories themselves are complete."""
    found = {}
    for package in (report.get("vulnerabilities") or {}).values():
        for via in package.get("via") or []:
            if isinstance(via, dict):
                ghsa = str(via.get("url", "")).rstrip("/").rsplit("/", 1)[-1] or str(via.get("source"))
                found[ghsa] = via
    return found


def problems(report: dict, ignored: dict[str, dict], today: datetime.date) -> list[str]:
    if "error" in report:
        return [f"npm audit failed: {report['error']}"]
    found = advisories(report)
    out = []
    for ghsa, via in sorted(found.items()):
        if SEVERITY.get(str(via.get("severity")), FAIL_FROM) < FAIL_FROM:
            continue
        entry = ignored.get(ghsa)
        if entry is None:
            what = f"{via.get('severity')} {via.get('name')} {via.get('range')}"
            out.append(f"{what}: {via.get('title')} {via.get('url')}")
        elif today > datetime.date.fromisoformat(entry["review_by"]):
            out.append(f"{ghsa} ({entry['package']}) is ignored until {entry['review_by']}: look at it again")
    for ghsa, entry in sorted(ignored.items()):
        if ghsa not in found:
            out.append(f"{ghsa} ({entry['package']}) is ignored but no longer reported: remove it from IGNORED")
    return out


def main() -> int:
    cmd = ["npm", "audit", "--json"]
    run = subprocess.run(cmd, capture_output=True, text=True, check=False)  # noqa: S603
    try:
        report = json.loads(run.stdout)
    except json.JSONDecodeError:
        print(run.stdout + run.stderr)
        print("npm audit: FAIL (no JSON report)")
        return 1
    found = problems(report, IGNORED, datetime.date.today())
    for p in found:
        print(f"FAIL {p}")
    print(f"npm audit: {'FAIL' if found else 'PASS'} ({len(advisories(report))} advisories, {len(IGNORED)} ignored)")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
