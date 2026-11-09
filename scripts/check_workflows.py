"""A job that calls another workflow must grant every permission that workflow's jobs ask for.

GitHub caps a called workflow's jobs at what the calling job grants, and a workflow asking for more doesn't fail
until it is started: on 2026-11-10 the first real release died at startup because validate.yml's secrets job
asked for pull-requests: read and release.yml's validate job granted contents: read only. Ordinary CI never
calls validate.yml that way, so nothing caught it. Usage: python3 scripts/check_workflows.py [repo_root]
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

LEVEL = {"none": 0, "read": 1, "write": 2}


def permissions(block: object) -> dict[str, int]:
    """A permissions block as scope -> level. A missing block is treated as none, which is how this repo writes them."""
    if block in (None, {}):
        return {}
    if block == "read-all":
        return {"*": LEVEL["read"]}
    if block == "write-all":
        return {"*": LEVEL["write"]}
    if not isinstance(block, dict):
        raise ValueError(f"unexpected permissions block: {block!r}")
    return {scope: LEVEL[level] for scope, level in block.items()}


def granted(grant: dict[str, int], scope: str) -> int:
    return max(grant.get(scope, 0), grant.get("*", 0))


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    workflows = root / ".github" / "workflows"
    problems, calls = [], 0
    for caller in sorted(workflows.glob("*.yml")):
        spec = yaml.safe_load(caller.read_text())
        for job_id, job in (spec.get("jobs") or {}).items():
            uses = job.get("uses", "")
            if not uses.startswith("./.github/workflows/"):
                continue
            calls += 1
            grant = permissions(job.get("permissions", spec.get("permissions")))
            called = yaml.safe_load((root / uses).read_text())
            for called_id, called_job in (called.get("jobs") or {}).items():
                wanted = permissions(called_job.get("permissions", called.get("permissions")))
                for scope, level in wanted.items():
                    if granted(grant, scope) < level:
                        need = next(name for name, n in LEVEL.items() if n == level)
                        problems.append(
                            f"{caller.name} job '{job_id}' calls {Path(uses).name}, whose job '{called_id}' needs "
                            f"{scope}: {need}, which the caller doesn't grant"
                        )
    for p in problems:
        print(f"FAIL {p}")
    print(f"workflows: {'FAIL' if problems else 'PASS'} ({calls} calls checked)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
