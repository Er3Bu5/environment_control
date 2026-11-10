"""The browser side keeps its sandbox: what the frame can do, and what only the host may do.

- The host's frame is sandboxed with allow-scripts and nothing else, and allow-same-origin appears nowhere shipped.
- callService appears only in the host, and only as often as the write table below allows (none in this release).
- The host accepts exactly the frame messages listed below, so each new path into the host is added on purpose.
- The frame's source has no network, no eval and no service calls; the built frame carries the no-network CSP.
Usage: python3 scripts/check_frontend_safety.py [repo_root]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# The write paths the host may call, as a count of callService sites. Each milestone that adds a write adds it here,
# in the same change as its tests. Milestone 2 ships none.
HOST_CALL_SERVICE_SITES = 0
# The messages the host acts on from the frame. Each is a way into the code that holds the login, so adding one is a
# deliberate change here, made with its tests.
HOST_ACCEPTS = {"ready", "draft", "appearance", "catalog", "sidebar"}
FRAME_BANNED = {
    "callService": r"\bcallService\b",
    "fetch": r"\bfetch\s*\(",
    "XMLHttpRequest": r"\bXMLHttpRequest\b",
    "WebSocket": r"\bWebSocket\s*\(",
    "EventSource": r"\bEventSource\s*\(",
    "sendBeacon": r"\bsendBeacon\b",
    "eval": r"\beval\s*\(",
    "new Function": r"\bnew\s+Function\s*\(",
    "importScripts": r"\bimportScripts\b",
    "localStorage": r"\blocalStorage\b",
    "document.cookie": r"\bdocument\.cookie\b",
    "window.open": r"\bwindow\.open\s*\(",
}
CSP = "default-src 'none'; script-src 'sha256-"


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    src = root / "frontend" / "src"
    host = (src / "host.js").read_text(encoding="utf-8")
    problems = []

    sandboxes = re.findall(r'setAttribute\(\s*"sandbox"\s*,\s*"([^"]*)"\s*\)', host)
    if sandboxes != ["allow-scripts"]:
        problems.append(f"host.js: the frame's sandbox must be exactly allow-scripts, found {sandboxes}")
    if re.search(r"\.sandbox\b", host):
        problems.append("host.js: set the sandbox only through setAttribute, so this check sees it")
    if not re.search(r"srcdoc\s*=\s*FRAME_HTML", host) or re.search(r"\.src\s*=", host):
        problems.append("host.js: the frame must load only the built page, through srcdoc")
    accepts = set(re.findall(r'm\.type === "([a-z_]+)"', host))
    if accepts != HOST_ACCEPTS:
        problems.append(f"host.js: accepts frame messages {sorted(accepts)}, the allowlist is {sorted(HOST_ACCEPTS)}")
    sites = len(re.findall(r"\bcallService\b", host))
    if sites != HOST_CALL_SERVICE_SITES:
        problems.append(f"host.js: {sites} callService sites, the write table allows {HOST_CALL_SERVICE_SITES}")

    for f in sorted(src.rglob("*")):
        if f.suffix not in (".js", ".ts", ".mjs") or f.name == "host.js" or f.name.endswith(".d.ts"):
            continue
        text = f.read_text(encoding="utf-8")
        for name, rx in FRAME_BANNED.items():
            if re.search(rx, text):
                problems.append(f"{f.relative_to(root)}: the frame must not use {name}")

    shipped = list(src.rglob("*.js")) + list(src.rglob("*.ts"))
    built = root / "custom_components" / "environment_control" / "frontend"
    shipped += list(built.glob("*.js")) if built.exists() else []
    for f in shipped:
        if "allow-same-origin" in f.read_text(encoding="utf-8").replace("adding allow-same-origin would", ""):
            problems.append(f"{f.relative_to(root)}: mentions allow-same-origin, which would undo the sandbox")

    frame_js = built / "frame.js"
    if frame_js.exists():
        text = frame_js.read_text(encoding="utf-8")
        if CSP not in text or "style-src 'unsafe-inline'; font-src data:" not in text:
            problems.append("frame.js: the built frame must carry the no-network CSP")
        if built.joinpath("host.js").read_text(encoding="utf-8") != host:
            problems.append("host.js: the built host must be the source exactly")

    for p in problems:
        print(f"FAIL {p}")
    print(f"frontend safety: {'FAIL' if problems else 'PASS'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
