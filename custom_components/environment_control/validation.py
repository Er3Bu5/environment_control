"""Checks on a setup before it's stored.

The panel's host already refuses most bad input, but the backend never trusts the browser: anything that reaches storage
passes these checks. They mirror the mock's fake backend, so the two refuse the same things. A setup only ever names
entities; it can never make this integration call a service.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .const import MAX_CONFIG_BYTES, MAX_DEVICES, MAX_ZONES

ZONE_ID = re.compile(r"^[a-z0-9_]{1,40}$")
VIRTUAL_ID = re.compile(r"^v-[a-z0-9_]{1,40}$")
CONTROLLABLE = re.compile(r"^(switch|light|fan|humidifier)\.[a-z0-9_]{1,200}$")
HELPER = re.compile(r"^input_(number|datetime)\.[a-z0-9_]{1,200}$")
ON_OFF = re.compile(r"^(switch|light|input_boolean)\.[a-z0-9_]{1,200}$")
NUMBER_ENTITY = re.compile(r"^number\.[a-z0-9_]{1,200}$")
EMERSON_MODES = ("none", "helper", "fixed", "detected")


class InvalidConfig(ValueError):
    """The setup can't be stored, and the message says why."""


def _fail(message: str) -> None:
    raise InvalidConfig(message)


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _helpers_ok(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, str):
        return bool(HELPER.match(v))
    return isinstance(v, dict) and all(_helpers_ok(x) for x in v.values())


def _flat(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [v]
    return [e for x in v.values() for e in _flat(x)]


def _on_off_ok(v: Any) -> bool:
    return v is None or (
        isinstance(v, list) and len(v) <= 20 and all(isinstance(e, str) and ON_OFF.match(e) for e in v)
    )


def _spot_ok(p: Any, layout: Any) -> bool:
    """A spot on a zone's map: half-steps, from the wall gap on one side to the wall gap on the other."""
    if not isinstance(layout, dict) or not isinstance(p, list) or len(p) != 2:
        return False
    if not all(_is_num(x) and float(x * 2).is_integer() for x in p):
        return False
    rows, cols = layout.get("rows"), layout.get("cols")
    if not (_is_num(rows) and _is_num(cols)):
        return False
    return -1 <= p[0] <= rows and -1 <= p[1] <= cols


def validate_config(c: Any) -> None:
    """Raise InvalidConfig if the setup can't be stored."""
    if not isinstance(c, dict) or not isinstance(c.get("zones"), list) or not isinstance(c.get("devices"), list):
        _fail("Config isn't zones and devices")
    if len(json.dumps(c)) > MAX_CONFIG_BYTES:
        _fail("That setup is too large to save")
    zones, devices = c["zones"], c["devices"]
    if len(zones) > MAX_ZONES or len(devices) > MAX_DEVICES:
        _fail("Config isn't zones and devices")
    if not all(isinstance(z, dict) for z in zones) or not all(isinstance(d, dict) for d in devices):
        _fail("Config isn't zones and devices")
    ids = [z.get("id") for z in zones]
    if len(set(map(str, ids))) != len(ids) or not all(isinstance(i, str) and ZONE_ID.match(i) for i in ids):
        _fail("Zone ids must be unique slugs")
    by_id = {z["id"]: z for z in zones}

    for z in zones:
        zid, h = z["id"], z.get("helpers")
        if h is not None and not _helpers_ok(h):
            _fail(f"{zid} links a setting to something that isn't a helper")
        h = h if isinstance(h, dict) else {}
        if any(e is not None and not e.startswith("input_datetime.") for e in (h.get("day"), h.get("night"))):
            _fail(f"{zid} links lights on or off to something that isn't a time helper")
        numbers = [
            h.get("morning"),
            h.get("daylight"),
            h.get("evening"),
            *_flat(h.get("bands")),
            *_flat(h.get("light")),
        ]
        if any(e is not None and not e.startswith("input_number.") for e in numbers):
            _fail(f"{zid} links a number setting to something that isn't a number helper")
        mode = z.get("emersonMode")
        if mode is not None and mode not in EMERSON_MODES:
            _fail(f"{zid} has a red light source this panel doesn't know")
        if mode == "fixed":
            em = z.get("emerson") if isinstance(z.get("emerson"), dict) else {}
            if not all(_is_int(em.get(k)) and 0 <= em[k] <= 59 for k in ("morning", "daylight", "evening")):
                _fail(f"{zid} has red light extensions outside 0 to 59 minutes")
        if not _on_off_ok(z.get("lights")) or not _on_off_ok(z.get("redLights")):
            _fail(f"{zid} follows something that isn't an on or off entity")
        desc = z.get("description")
        if desc is not None and (not isinstance(desc, str) or not desc.strip() or len(desc) > 200):
            _fail(f"{zid} has a description that isn't short text")
        sensors = z.get("sensors") or []
        if not isinstance(sensors, list):
            _fail(f"{zid} has sensors that aren't a list")
        for x in sensors:
            leaf = x.get("leafEntity") if isinstance(x, dict) else None
            if leaf is not None and not (isinstance(leaf, str) and NUMBER_ENTITY.match(leaf)):
                _fail(f"{x.get('id')} has a leaf temperature offset that isn't a number entity")
        virtual = z.get("virtual")
        if virtual is not None:
            if not isinstance(virtual, list) or len(virtual) > 30:
                _fail(f"{zid} has virtual devices that aren't a short list")
            seen: set[str] = set()
            for v in virtual:
                shape = isinstance(v, dict) and set(v) <= {"id", "name", "pos"}
                vid, name = (v.get("id"), v.get("name")) if shape else (None, None)
                if (
                    not shape
                    or not isinstance(vid, str)
                    or not VIRTUAL_ID.match(vid)
                    or vid in seen
                    or not isinstance(name, str)
                    or not name.strip()
                    or len(name) > 40
                ):
                    _fail(f"{zid} has a virtual device that isn't a name and a spot")
                seen.add(vid)
                if not _spot_ok(v.get("pos"), z.get("layout")):
                    _fail(f"{vid} is placed outside {zid}'s map")

    for d in devices:
        did, dz = d.get("id"), d.get("zones")
        if not isinstance(dz, list) or any(zid not in by_id for zid in dz):
            _fail(f"{did} is in a zone that doesn't exist")
        entity = d.get("entity")
        if entity is not None and not (isinstance(entity, str) and CONTROLLABLE.match(entity)):
            _fail(f"{did} has an entity this panel can't control")
        place = d.get("place")
        if place is None:
            continue
        if not isinstance(place, dict):
            _fail(f"{did} has a placement that isn't per zone")
        for zid, p in place.items():
            z = by_id.get(zid)
            if zid not in dz or z is None or not isinstance(z.get("layout"), dict):
                _fail(f"{did} is placed in a zone it isn't in")
            if not _spot_ok(p, z.get("layout")):
                _fail(f"{did} is placed outside {zid}'s map")
