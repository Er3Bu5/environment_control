"""The repository installs from Home Assistant's Marketplace the way it is meant to.

HA 2026.11 replaced HACS with the Marketplace, so the HACS action checked rules that no longer decide anything.
These are the Marketplace's own, read from homeassistant/components/marketplace in HA 2026.11.0 (utils/validate.py,
repositories/base.py and repositories/integration.py) and from the brands proxy that serves its icons. Several of
them fail silently in HA: a hacs.json value of the wrong type is dropped without a word, and zip_release without a
.zip filename quietly installs the default branch, which has no built panel. Usage: python3 scripts/check_marketplace.py
"""

from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

# What the Marketplace reads from hacs.json, and the type it drops anything else to
HACS_JSON_TYPES = {
    "content_in_root": bool,
    "filename": str,
    "hacs": str,
    "hide_default_branch": bool,
    "homeassistant": str,
    "name": str,
    "persistent_directory": str,
    "zip_release": bool,
}
HA_VERSION = re.compile(r"^\d{4}\.\d{1,2}\.\d+$")
# Core's own domain rule, stricter than the Marketplace's, since the loader is what has to accept it
DOMAIN = re.compile(r"^[a-z0-9_]+$")
ICON_SIZES = {"icon.png": 256, "icon@2x.png": 512, "dark_icon.png": 256, "dark_icon@2x.png": 512}


def png_size(path: Path) -> tuple[int, int] | None:
    head = path.read_bytes()[:24]
    if head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", head[16:24])


def check(root: Path) -> list[str]:
    problems: list[str] = []
    hacs_path = root / "hacs.json"
    if not hacs_path.is_file():
        return ["hacs.json is missing from the repository root; the Marketplace can't add or update the repository"]
    hacs = json.loads(hacs_path.read_text())
    for key, kind in HACS_JSON_TYPES.items():
        if key in hacs and type(hacs[key]) is not kind:
            problems.append(f"hacs.json {key} must be a {kind.__name__}; the Marketplace drops it otherwise")
    for key in sorted(set(hacs) - set(HACS_JSON_TYPES)):
        problems.append(f"hacs.json {key} is not read by the Marketplace")
    if isinstance(hacs.get("homeassistant"), str) and not HA_VERSION.match(hacs["homeassistant"]):
        problems.append(f"hacs.json homeassistant {hacs['homeassistant']!r} is not a release version such as 2026.10.0")
    if hacs.get("content_in_root"):
        problems.append("hacs.json content_in_root is set, but the integration lives under custom_components/")

    filename = hacs.get("filename")
    if hacs.get("zip_release") is not True or not (isinstance(filename, str) and filename.endswith(".zip")):
        problems.append(
            "hacs.json needs zip_release true and a filename ending in .zip, or the Marketplace installs the source, "
            "which has no built panel"
        )
    else:
        release = (root / ".github/workflows/release.yml").read_text()
        if not re.search(rf"gh release create .*\b{re.escape(filename)}\b", release):
            problems.append(f"release.yml doesn't attach {filename} to the release; the Marketplace downloads that")

    integrations = root / "custom_components"
    folders = sorted(p for p in integrations.iterdir() if p.is_dir() and not p.name.startswith((".", "__")))
    if len(folders) != 1:
        names = [p.name for p in folders]
        problems.append(f"custom_components/ must hold one integration; the Marketplace takes the first of {names}")
        return problems
    folder = folders[0]
    manifest_path = folder / "manifest.json"
    if not manifest_path.is_file():
        problems.append(f"{manifest_path.relative_to(root)} is missing")
        return problems
    manifest = json.loads(manifest_path.read_text())
    domain = manifest.get("domain")
    if not (isinstance(domain, str) and DOMAIN.match(domain)):
        problems.append(f"manifest.json domain {domain!r} is not a valid domain")
    elif domain != folder.name:
        problems.append(f"manifest.json domain {domain!r} doesn't match its folder {folder.name!r}")
    for key, kind in (("name", str), ("config_flow", bool), ("version", str)):
        if type(manifest.get(key)) is not kind:
            problems.append(f"manifest.json {key} must be a {kind.__name__}")
    owners = manifest.get("codeowners")
    if not (isinstance(owners, list) and owners and all(isinstance(o, str) for o in owners)):
        problems.append("manifest.json codeowners must be a list of names; the Marketplace shows them as the authors")

    brand = folder / "brand"
    if not (brand / "icon.png").is_file():
        problems.append(f"{(brand / 'icon.png').relative_to(root)} is missing; the Marketplace and HA show no icon")
    for name, want in ICON_SIZES.items():
        path = brand / name
        if path.is_file() and png_size(path) != (want, want):
            problems.append(f"{path.relative_to(root)} must be a {want}x{want} PNG, got {png_size(path)}")
    return problems


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    problems = check(root)
    for p in problems:
        print(f"FAIL {p}")
    print(f"marketplace: {'FAIL' if problems else 'PASS'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
