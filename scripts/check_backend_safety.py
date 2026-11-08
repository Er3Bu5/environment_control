"""The backend can't move hardware, reach the network, run a shell or read config-entry secrets.

Walks the syntax tree of every Python file in the integration, so a banned call can't hide behind formatting.
Usage: python3 scripts/check_backend_safety.py [repo_root]
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

BANNED_MODULES = {
    "subprocess", "socket", "aiohttp", "requests", "httpx", "urllib", "http", "ftplib", "smtplib", "telnetlib",
    "pickle", "shelve", "marshal", "ctypes", "multiprocessing", "asyncio.subprocess",
}  # fmt: skip
BANNED_CALLS = {"eval", "exec", "compile", "__import__", "breakpoint"}
# hass.services.async_call / call and hass.states.async_set / set move hardware or fake a state.
BANNED_ATTR_CHAINS = {("services", "async_call"), ("services", "call"), ("states", "async_set"), ("states", "set")}
BANNED_ATTRS = {"system", "popen", "spawn", "execv", "execve", "fork"}  # os.system and friends
ENTRY_NAMES = {"entry", "config_entry"}


def check_file(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    problems = []
    for node in ast.walk(tree):
        where = f"{path}:{getattr(node, 'lineno', 0)}"
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in BANNED_MODULES or alias.name.split(".")[0] in BANNED_MODULES:
                    problems.append(f"{where}: imports {alias.name}")
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module in BANNED_MODULES or node.module.split(".")[0] in BANNED_MODULES:
                problems.append(f"{where}: imports from {node.module}")
            for alias in node.names:
                if alias.name == "async_get_clientsession" or alias.name == "aiohttp_client":
                    problems.append(f"{where}: imports HA's HTTP client")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in BANNED_CALLS:
            problems.append(f"{where}: calls {node.func.id}()")
        elif isinstance(node, ast.Attribute):
            if node.attr in BANNED_ATTRS and isinstance(node.value, ast.Name) and node.value.id == "os":
                problems.append(f"{where}: uses os.{node.attr}")
            if isinstance(node.value, ast.Attribute) and (node.value.attr, node.attr) in BANNED_ATTR_CHAINS:
                problems.append(f"{where}: uses {node.value.attr}.{node.attr}, which moves hardware or sets a state")
            if node.attr in ("data", "options") and isinstance(node.value, ast.Name) and node.value.id in ENTRY_NAMES:
                why = "config-entry data can hold other integrations' secrets"
                problems.append(f"{where}: reads {node.value.id}.{node.attr}; {why}")
    return problems


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    pkg = root / "custom_components" / "environment_control"
    problems = [p for f in sorted(pkg.rglob("*.py")) for p in check_file(f)]
    manifest = json.loads((pkg / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("requirements"):
        problems.append(f"manifest.json: requirements must be empty, found {manifest['requirements']}")
    for p in problems:
        print(f"FAIL {p}")
    print(f"backend safety: {'FAIL' if problems else 'PASS'} ({len(list(pkg.rglob('*.py')))} files)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
