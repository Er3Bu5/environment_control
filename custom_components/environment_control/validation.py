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

# Every pattern is used with fullmatch: `$` with match also passes a trailing newline, which would make
# "automation.x\n" a valid automation distinct from "automation.x".
ZONE_ID = re.compile(r"[a-z0-9_]{1,40}")
VIRTUAL_ID = re.compile(r"v-[a-z0-9_]{1,40}")
CONTROLLABLE = re.compile(r"(switch|light|fan|humidifier)\.[a-z0-9_]{1,200}")
HELPER = re.compile(r"input_(number|datetime)\.[a-z0-9_]{1,200}")
ON_OFF = re.compile(r"(switch|light|input_boolean)\.[a-z0-9_]{1,200}")
NUMBER_ENTITY = re.compile(r"number\.[a-z0-9_]{1,200}")
SENSOR_ENTITY = re.compile(r"sensor\.[a-z0-9_]{1,200}")
NUMBER_HELPER = re.compile(r"input_number\.[a-z0-9_]{1,200}")
# Automations a zone links can be switched on and off by the panel's host, and nothing else: Home Assistant keeps
# running them. A link is only which automation, under what id, in which group, and optionally a name the panel shows
# instead of Home Assistant's.
AUTOMATION = re.compile(r"automation\.[a-z0-9_]{1,200}")
LINK_KEYS = frozenset({"id", "entity", "group"})
# A link's name mirrors the mock's fake backend (design/fake-ha.js), so the two refuse the same names: 1 to MAX_NAME
# characters counted as JavaScript counts them (UTF-16 units), no control character, and nothing that JavaScript's
# trim() would take off either end. The trim set is JavaScript's, not str.strip()'s: the two disagree on a few
# characters such as U+FEFF and U+0085.
LINK_NAME = re.compile(r"[^\x00-\x1f\x7f]+")
JS_TRIMMED = " \u00a0\u1680" + "".join(map(chr, range(0x2000, 0x200B))) + "\u2028\u2029\u202f\u205f\u3000\ufeff"
AUTOMATION_GROUPS = ("alert_day", "alert_night", "alert_device", "failsafe", "control")
LINK_ID = re.compile(r"[a-z0-9_-]{1,64}")
MAX_AUTOMATIONS_PER_ZONE = 200
# What a setup holds. Room settings are for the whole room rather than one zone: so far only the number helper every
# alert's repeat rate comes from.
# A setup read back from storage carries its revision; the store sets that itself on every save, whatever is sent.
CONFIG_KEYS = frozenset({"zones", "devices", "room", "revision"})
ROOM_KEYS = frozenset({"alertRepeat"})
# A sensor is an HA device id, a device entry an id the panel makes; both stay short and safe in an id or a URL.
ITEM_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
# Environment readings, then a soil probe's; which a sensor may use follows its class.
READING_SLOTS = frozenset({"temperature", "humidity", "vpd", "light", "moisture", "ec"})
SENSOR_CLASSES = ("env", "soil")
MAX_SENSORS_PER_ZONE = 50
MAX_NAME = 100
MAX_MODE_NAME = 40
MAX_HIDDEN_MODES = 20
# Leaf temperature offsets kept here, as wide as any board allows and then some.
LEAF_RANGE = (-10, 10)
LEVELS = ("above", "in", "under")
MAX_UNITS = 200
MAX_UNIT_LABEL = 12
MAX_GRID = 20
MAX_SIZE_M = 100
EMERSON_MODES = ("none", "helper", "fixed", "detected")
# What a virtual device is: the roles real devices have, a tank, or something else. It only decides how it's drawn.
VIRTUAL_TYPES = ("Dehumidifier", "Humidifier", "Air conditioner", "Heater", "Fan", "Light", "Tank", "Other")
PERIOD_MODES = ("helper", "fixed", "detected")
# What a zone's History card can open on: one of its graphs, over one of the ranges it offers.
HISTORY_METRICS = ("temperature", "humidity", "vpd", "light")
HISTORY_HOURS = (6, 24, 72, 168)
# Limits as stored: wider than the panel lets you type, since a value read off a helper is kept here as last known.
BAND_RANGE = {"temperature": (-50, 100), "humidity": (0, 100), "vpd": (0, 10)}
MAX_LUX = 1_000_000
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
        return bool(HELPER.fullmatch(v))
    return isinstance(v, dict) and all(_helpers_ok(x) for x in v.values())


def _flat(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [v]
    return [e for x in v.values() for e in _flat(x)]


def _on_off_ok(v: Any) -> bool:
    return v is None or (
        isinstance(v, list) and len(v) <= 20 and all(isinstance(e, str) and ON_OFF.fullmatch(e) for e in v)
    )


def _check_limits(zid: str, z: dict[str, Any]) -> None:
    """A zone's limits: day and night, each Min, Low, Target, High, Max per reading, and a light limit a period.

    Only the Target may be missing, for a zone that aims for none. Their order isn't checked here: Min, Target and Max
    can sit on helpers, whose values Home Assistant holds, and the panel won't apply an order that doesn't run upward.
    """
    bands = z.get("bands")
    if bands is not None:
        if not isinstance(bands, dict) or set(bands) != {"day", "night"}:
            _fail(f"{zid} has limits that aren't day and night")
        for period in bands.values():
            if not isinstance(period, dict) or set(period) != set(BAND_RANGE):
                _fail(f"{zid} has limits that aren't temperature, humidity and VPD")
            for k, values in period.items():
                lo, hi = BAND_RANGE[k]
                if not isinstance(values, list) or len(values) != 5:
                    _fail(f"{zid} has {k} limits that aren't Min, Low, Target, High and Max")
                for i, v in enumerate(values):
                    if v is None and i == 2:
                        continue
                    if not (_is_num(v) and lo <= v <= hi):
                        _fail(f"{zid} has a {k} limit outside {lo} to {hi}")
    light = z.get("lightLimits")
    if light is not None and not (
        isinstance(light, dict)
        and set(light) <= {"dayMin", "nightMax"}
        and all(_is_num(v) and 0 <= v <= MAX_LUX for v in light.values())
    ):
        _fail(f"{zid} has light limits that aren't a day minimum and a night maximum in lux")


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
    labels = layout.get("labels")
    if labels is not None and not (
        isinstance(labels, dict)
        and all(isinstance(k, str) and k.isdecimal() and str(int(k)) == k and 1 <= int(k) <= units for k in labels)
        and all(isinstance(v, str) and v.strip() and len(v) <= MAX_UNIT_LABEL for v in labels.values())
    ):
        _fail(f"{zid} has a unit label that isn't short text on one of its units")


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
    if not isinstance(x, dict) or not isinstance(x.get("id"), str) or not ITEM_ID.fullmatch(x["id"]):
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
        or not all(isinstance(e, str) and SENSOR_ENTITY.fullmatch(e) for e in entities.values())
    ):
        _fail(f"{sid} reads from something that isn't a sensor entity")
    leaf = x.get("leafEntity")
    if leaf is not None and not (isinstance(leaf, str) and NUMBER_ENTITY.fullmatch(leaf)):
        _fail(f"{sid} has a leaf temperature offset that isn't a number entity")
    kept = x.get("leaf")
    if kept is not None and not (_is_num(kept) and LEAF_RANGE[0] <= kept <= LEAF_RANGE[1]):
        _fail(f"{sid} has a leaf temperature offset outside {LEAF_RANGE[0]} to {LEAF_RANGE[1]} °C")
    for flag in ("avg", "leafUnused"):
        if flag in x and not isinstance(x[flag], bool):
            _fail(f"{sid} has {flag} that isn't true or false")
    if "level" in x and x["level"] not in LEVELS:
        _fail(f"{sid} has a height this panel doesn't know")


def _is_link_name(name: Any) -> bool:
    return (
        isinstance(name, str)
        and len(name.encode("utf-16-le", "surrogatepass")) // 2 <= MAX_NAME
        and name.strip(JS_TRIMMED) == name
        and bool(LINK_NAME.fullmatch(name))
    )


def _check_automations(zid: str, links: Any, elsewhere: set[str]) -> None:
    """A zone's automation links: each an id, an automation entity, a group and maybe a name, no id or automation twice.

    Nothing else may ride along, so a link can never name a service or anything but an automation. An automation belongs
    to one zone: switched off for one zone it would stop in another without that zone saying so. `elsewhere` is what the
    zones before this one link, and gains this zone's.
    """
    if not isinstance(links, list) or len(links) > MAX_AUTOMATIONS_PER_ZONE:
        _fail(f"{zid} links automations that aren't a short list")
    ids: set[str] = set()
    entities: set[str] = set()
    for a in links:
        if not isinstance(a, dict) or set(a) not in (LINK_KEYS, LINK_KEYS | {"name"}):
            _fail(f"{zid} links an automation with something other than an id, an entity, a group and a name")
        if "name" in a and not _is_link_name(a["name"]):
            _fail(f"{zid} gives an automation a name that isn't short text")
        aid, entity = a["id"], a["entity"]
        if not isinstance(aid, str) or not LINK_ID.fullmatch(aid) or aid in ids:
            _fail(f"{zid} has automation links without unique ids")
        if not isinstance(entity, str) or not AUTOMATION.fullmatch(entity) or entity in entities:
            _fail(f"{zid} links something that isn't an automation, or one twice")
        if a["group"] not in AUTOMATION_GROUPS:
            _fail(f"{zid} puts an automation in a group this panel doesn't know")
        if entity in elsewhere:
            _fail("An automation can only be linked to one zone.")
        ids.add(aid)
        entities.add(entity)
    elsewhere |= entities


def _check_room(room: Any) -> None:
    """Settings for the whole room: only the number helper every alert's repeat rate comes from."""
    if not isinstance(room, dict) or not set(room) <= ROOM_KEYS:
        _fail("Room settings hold only the alert repeat rate")
    repeat = room.get("alertRepeat")
    if "alertRepeat" in room and not (isinstance(repeat, str) and NUMBER_HELPER.fullmatch(repeat)):
        _fail("The alert repeat rate links to something that isn't a number helper")


# Linked zones. A zone may name one parent; a parent and the zones linked to it are a family. These rules and their
# messages mirror the mock's fake backend (design/fake-ha.js, checkConfig and save) word for word, so the two refuse
# the same things.
_NO_PARENT = object()


def _zone_name(z: dict[str, Any]) -> str:
    return z.get("name") or z["id"]


def _check_parents(zones: list[dict[str, Any]], before: list[dict[str, Any]]) -> None:
    """A linked zone shows what its parent runs, so a parent has to be a plain zone: one level, never itself."""
    was = {z.get("id"): z.get("parent", _NO_PARENT) for z in before if isinstance(z, dict)}
    by_id = {z["id"]: z for z in zones}

    def moved(z: dict[str, Any]) -> bool:
        return was.get(z["id"], _NO_PARENT) != z.get("parent", _NO_PARENT)

    # The reason is told from the side of the zone whose link just changed: a new zone linked to a linked zone hears
    # that its parent is linked, not that the parent has zones linked to it.
    for z in sorted(zones, key=lambda z: not moved(z)):
        if "parent" not in z:
            continue
        zid, pid = z["id"], z["parent"]
        parent = by_id.get(pid) if isinstance(pid, str) else None
        if parent is None:
            _fail(f"{zid} is linked to a zone that doesn't exist")
        if parent is z:
            _fail(f"{zid} can't be linked to itself")
        if any(o.get("parent") == zid for o in zones):
            _fail(f"{zid} has zones linked to it, so it can't be linked to another")
        if "parent" in parent:
            _fail(f"{zid} is linked to a zone that is itself linked to another")


def _check_shared_sensors(zones: list[dict[str, Any]], before: list[dict[str, Any]]) -> None:
    """A sensor in two zones shows one zone's readings in another, which only a parent link may do."""
    was = {z.get("id"): z.get("parent") for z in before if isinstance(z, dict)}
    holders: dict[str, list[tuple[dict[str, Any], str]]] = {}
    for z in zones:
        for x in z.get("sensors") or []:
            holders.setdefault(x["id"], []).append((z, x.get("name") or x["id"]))
    for found in holders.values():
        if len({z.get("parent") or z["id"] for z, _ in found}) == 1:
            continue
        # The zone stops sharing only by taking the shared sensor out first, so breaking the link is refused by name.
        for i, (a, sensor) in enumerate(found):
            for j, (b, _) in enumerate(found):
                if i != j and (was.get(a["id"]) == b["id"] or was.get(b["id"]) == a["id"]):
                    child = a if was.get(a["id"]) == b["id"] else b
                    _fail(
                        f"{sensor} is in both {_zone_name(a)} and {_zone_name(b)}. "
                        f"Take it out of {_zone_name(child)} before unlinking it."
                    )
        _fail("A sensor can only be shared between a zone and the zones linked to it.")


def unlink_removed_parents(before: dict[str, Any], c: Any) -> Any:
    """Removing a parent zone unlinks the zones linked to it, which stay, unless one still has a sensor of the parent's.

    The panel saves the whole setup at once, so a zone removed in this save can still be named as a parent by the zones
    linked to it. Only a parent the stored setup has and this save drops is unlinked: a parent no setup ever had is
    left for validate_config to refuse, so nothing stored can name a zone that isn't there.
    """
    if not isinstance(c, dict) or not isinstance(c.get("zones"), list):
        return c
    old = [z for z in before.get("zones") or [] if isinstance(z, dict)]
    kept = {z.get("id") for z in c["zones"] if isinstance(z, dict) and isinstance(z.get("id"), str)}
    removed = [z for z in old if z.get("id") not in kept]
    if not removed:
        return c
    was = {z.get("id"): z.get("parent") for z in old}
    zones = []
    for z in c["zones"]:
        zid = z.get("id") if isinstance(z, dict) else None
        if not isinstance(zid, str):
            zones.append(z)
            continue
        names = {p for p in (z.get("parent"), was.get(zid)) if isinstance(p, str)}
        sensors = z.get("sensors") if isinstance(z.get("sensors"), list) else []
        mine = [s.get("id") for s in sensors if isinstance(s, dict)]
        for gone in (p for p in removed if p.get("id") in names):
            shared = next((s for s in gone.get("sensors") or [] if s.get("id") in mine), None)
            if shared is not None:
                sensor, here, there = shared.get("name") or shared["id"], _zone_name(z), _zone_name(gone)
                _fail(f"{sensor} is in both {there} and {here}. Take it out of {here} before removing {there}.")
        if any(p.get("id") == z.get("parent") for p in removed):
            z = {k: v for k, v in z.items() if k != "parent"}
        zones.append(z)
    return {**c, "zones": zones}


def validate_config(c: Any, before: dict[str, Any] | None = None) -> None:
    """Raise InvalidConfig if the setup can't be stored. `before` is the stored setup it replaces."""
    if not isinstance(c, dict) or not isinstance(c.get("zones"), list) or not isinstance(c.get("devices"), list):
        _fail("Config isn't zones and devices")
    if not set(c) <= CONFIG_KEYS:
        _fail("Config holds something other than zones, devices and room settings")
    if "room" in c:
        _check_room(c["room"])
    if len(json.dumps(c)) > MAX_CONFIG_BYTES:
        _fail("That setup is too large to save")
    zones, devices = c["zones"], c["devices"]
    if len(zones) > MAX_ZONES or len(devices) > MAX_DEVICES:
        _fail("Config isn't zones and devices")
    if not all(isinstance(z, dict) for z in zones) or not all(isinstance(d, dict) for d in devices):
        _fail("Config isn't zones and devices")
    ids = [z.get("id") for z in zones]
    if len(set(map(str, ids))) != len(ids) or not all(isinstance(i, str) and ZONE_ID.fullmatch(i) for i in ids):
        _fail("Zone ids must be unique slugs")
    by_id = {z["id"]: z for z in zones}
    stored = [z for z in (before or {}).get("zones") or [] if isinstance(z, dict)]
    _check_parents(zones, stored)
    linked: set[str] = set()

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
        _check_limits(zid, z)
        if "automations" in z:
            _check_automations(zid, z["automations"], linked)
        opens = z.get("history")
        if opens is not None and not (
            isinstance(opens, dict)
            and set(opens) == {"metric", "hours"}
            and opens["metric"] in HISTORY_METRICS
            and _is_int(opens["hours"])
            and opens["hours"] in HISTORY_HOURS
        ):
            _fail(f"{zid} opens its History on a graph or range this panel doesn't have")
        basis = z.get("leafBasis")
        if basis is not None and not (isinstance(basis, str) and ITEM_ID.fullmatch(basis)):
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
                shape = isinstance(v, dict) and set(v) <= {"id", "name", "pos", "type"}
                vid, name = (v.get("id"), v.get("name")) if shape else (None, None)
                if (
                    not shape
                    or not isinstance(vid, str)
                    or not VIRTUAL_ID.fullmatch(vid)
                    or vid in seen
                    or not isinstance(name, str)
                    or not name.strip()
                    or len(name) > 40
                ):
                    _fail(f"{zid} has a virtual device that isn't a name and a spot")
                if v.get("type") is not None and v.get("type") not in VIRTUAL_TYPES:
                    _fail(f"{vid} is a kind of virtual device this panel doesn't know")
                seen.add(vid)
                # One added in Device identification has no spot until Device placement gives it one.
                if v.get("pos") is not None and not _spot_ok(v.get("pos"), z.get("layout")):
                    _fail(f"{vid} is placed outside {zid}'s map")
    _check_shared_sensors(zones, stored)

    for d in devices:
        did, dz = d.get("id"), d.get("zones")
        if not isinstance(did, str) or not ITEM_ID.fullmatch(did):
            _fail("A device has an id this panel can't use")
        name = d.get("name")
        if name is not None and (not isinstance(name, str) or len(name) > MAX_NAME):
            _fail(f"{did} has a name that isn't short text")
        if not isinstance(dz, list) or any(zid not in by_id for zid in dz):
            _fail(f"{did} is in a zone that doesn't exist")
        entity = d.get("entity")
        if entity is not None and not (isinstance(entity, str) and CONTROLLABLE.fullmatch(entity)):
            _fail(f"{did} has an entity this panel can't control")
        # A mode the device has that Home Assistant doesn't list. Only its name: the panel reaches it by moving the
        # device's own target humidity, which it may already set.
        extra = d.get("nudgeMode")
        if extra is not None and not (
            isinstance(extra, str)
            and extra.strip()
            and len(extra) <= MAX_MODE_NAME
            and extra.isprintable()
            and isinstance(entity, str)
            and entity.startswith("humidifier.")
        ):
            _fail(f"{did} has an extra mode that isn't a short name on a humidifier or dehumidifier")
        # Modes its row in Controls leaves out. Only their names: the device keeps every mode it has.
        hidden = d.get("hiddenModes")
        if hidden is not None and not (
            isinstance(hidden, list)
            and 0 < len(hidden) <= MAX_HIDDEN_MODES
            and all(isinstance(m, str) and m.strip() and len(m) <= MAX_MODE_NAME and m.isprintable() for m in hidden)
            and len(set(hidden)) == len(hidden)
            and isinstance(entity, str)
            and entity.startswith("humidifier.")
        ):
            _fail(f"{did} has hidden modes that aren't a short list of names on a humidifier or dehumidifier")
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
