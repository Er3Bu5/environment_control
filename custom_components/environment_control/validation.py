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
SENSOR_ENTITY = re.compile(r"^sensor\.[a-z0-9_]{1,200}$")
# A sensor is an HA device id, a device entry an id the panel makes; both stay short and safe in an id or a URL.
ITEM_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# Environment readings, then a soil probe's; which a sensor may use follows its class.
READING_SLOTS = frozenset({"temperature", "humidity", "vpd", "light", "moisture", "ec"})
SENSOR_CLASSES = ("env", "soil")
MAX_SENSORS_PER_ZONE = 50
MAX_NAME = 100
# Leaf temperature offsets kept here, as wide as any board allows and then some.
LEAF_RANGE = (-10, 10)
LEVELS = ("above", "in", "under")
MAX_UNITS = 200
MAX_GRID = 20
MAX_SIZE_M = 100
EMERSON_MODES = ("none", "helper", "fixed", "detected")
PERIOD_MODES = ("helper", "fixed", "detected")
DAY_RULES = ("any", "all")
MINUTES_IN_DAY = 1440


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


def _check_layout(zid: str, layout: Any) -> None:
    """A zone's size and grid: every unit has a place, and nothing is bigger than a room could be."""
    if not isinstance(layout, dict):
        _fail(f"{zid} has a layout that isn't a size and a grid")
    w, d, units, rows, cols = (layout.get(k) for k in ("w", "d", "units", "rows", "cols"))
    if not all(_is_num(v) and 0.1 <= v <= MAX_SIZE_M for v in (w, d)):
        _fail(f"{zid} has a size outside 0.1 to {MAX_SIZE_M} m")
    if not (_is_int(units) and 1 <= units <= MAX_UNITS):
        _fail(f"{zid} has a unit count outside 1 to {MAX_UNITS}")
    if not all(_is_int(v) and 1 <= v <= MAX_GRID for v in (rows, cols)) or rows * cols < units:
        _fail(f"{zid} has a grid that doesn't hold its units")


def _planted(layout: dict[str, Any], r: Any, c: Any) -> bool:
    return (
        _is_int(r)
        and _is_int(c)
        and 0 <= r < layout["rows"]
        and 0 <= c < layout["cols"]
        and r * layout["cols"] + c < layout["units"]
    )


def _sensor_spot_ok(kind: Any, p: Any, layout: Any) -> bool:
    """An environment sensor sits inside the wall on the half-steps; a soil probe sits in a unit."""
    if not isinstance(layout, dict) or not isinstance(p, list) or len(p) != 2 or not all(_is_num(x) for x in p):
        return False
    if kind == "soil":
        return all(float(x).is_integer() for x in p) and _planted(layout, int(p[0]), int(p[1]))
    if not all(float(x * 2).is_integer() for x in p):
        return False
    return -0.5 <= p[0] <= layout["rows"] - 0.5 and -0.5 <= p[1] <= layout["cols"] - 0.5


def _check_sensor(zid: str, x: Any) -> None:
    """A mapped sensor names only sensor entities for its readings and a number entity for its offset."""
    if not isinstance(x, dict) or not isinstance(x.get("id"), str) or not ITEM_ID.match(x["id"]):
        _fail(f"{zid} has a sensor with an id this panel can't use")
    sid = x["id"]
    if "kind" in x and x["kind"] not in SENSOR_CLASSES:
        _fail(f"{sid} is a kind of sensor this panel doesn't know")
    name = x.get("name")
    if name is not None and (not isinstance(name, str) or len(name) > MAX_NAME):
        _fail(f"{sid} has a name that isn't short text")
    entities = x.get("entities")
    if entities is not None and (
        not isinstance(entities, dict)
        or not set(entities) <= READING_SLOTS
        or not all(isinstance(e, str) and SENSOR_ENTITY.match(e) for e in entities.values())
    ):
        _fail(f"{sid} reads from something that isn't a sensor entity")
    leaf = x.get("leafEntity")
    if leaf is not None and not (isinstance(leaf, str) and NUMBER_ENTITY.match(leaf)):
        _fail(f"{sid} has a leaf temperature offset that isn't a number entity")
    kept = x.get("leaf")
    if kept is not None and not (_is_num(kept) and LEAF_RANGE[0] <= kept <= LEAF_RANGE[1]):
        _fail(f"{sid} has a leaf temperature offset outside {LEAF_RANGE[0]} to {LEAF_RANGE[1]} °C")
    for flag in ("avg", "leafUnused"):
        if flag in x and not isinstance(x[flag], bool):
            _fail(f"{sid} has {flag} that isn't true or false")
    if "level" in x and x["level"] not in LEVELS:
        _fail(f"{sid} has a height this panel doesn't know")


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
        period = z.get("periodMode")
        if period is not None and period not in PERIOD_MODES:
            _fail(f"{zid} has a day and night source this panel doesn't know")
        if period == "helper" and not (h.get("day") and h.get("night")):
            _fail(f"{zid} takes its times from helpers but doesn't link both")
        if z.get("rule") is not None and z.get("rule") not in DAY_RULES:
            _fail(f"{zid} has a day rule this panel doesn't know")
        for k in ("dayAt", "nightAt"):
            if k in z and not (_is_int(z[k]) and 0 <= z[k] < MINUTES_IN_DAY):
                _fail(f"{zid} has a time that isn't minutes into the day")
        mode = z.get("emersonMode")
        if mode is not None and mode not in EMERSON_MODES:
            _fail(f"{zid} has a red light source this panel doesn't know")
        if mode == "helper" and not all(h.get(k) for k in ("morning", "daylight", "evening")):
            _fail(f"{zid} takes its red light extensions from helpers but doesn't link all three")
        if mode == "fixed":
            em = z.get("emerson") if isinstance(z.get("emerson"), dict) else {}
            if not all(_is_int(em.get(k)) and 0 <= em[k] <= 59 for k in ("morning", "daylight", "evening")):
                _fail(f"{zid} has red light extensions outside 0 to 59 minutes")
        if not _on_off_ok(z.get("lights")) or not _on_off_ok(z.get("redLights")):
            _fail(f"{zid} follows something that isn't an on or off entity")
        desc = z.get("description")
        if desc is not None and (not isinstance(desc, str) or not desc.strip() or len(desc) > 200):
            _fail(f"{zid} has a description that isn't short text")
        basis = z.get("leafBasis")
        if basis is not None and not (isinstance(basis, str) and ITEM_ID.match(basis)):
            _fail(f"{zid} draws its VPD chart at an offset this panel doesn't know")
        layout = z.get("layout")
        if layout is not None:
            _check_layout(zid, layout)
        sensors = z.get("sensors") or []
        if not isinstance(sensors, list) or len(sensors) > MAX_SENSORS_PER_ZONE:
            _fail(f"{zid} has sensors that aren't a short list")
        for x in sensors:
            _check_sensor(zid, x)
            if x.get("pos") is not None and not _sensor_spot_ok(x.get("kind", "env"), x.get("pos"), layout):
                what = "soil probe" if x.get("kind") == "soil" else "sensor"
                _fail(f"{x['id']} is placed where a {what} can't go in {zid}")
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
        if not isinstance(did, str) or not ITEM_ID.match(did):
            _fail("A device has an id this panel can't use")
        name = d.get("name")
        if name is not None and (not isinstance(name, str) or len(name) > MAX_NAME):
            _fail(f"{did} has a name that isn't short text")
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
