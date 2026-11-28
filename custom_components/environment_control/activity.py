"""One zone's Activity: what Home Assistant's logbook says happened to its devices and linked automations, a page at a
time, shaped here so the panel never sees the raw log.

Read only. The entities asked for come from the stored setup, never from the caller: the zone's mapped devices and the
automations it links. Numeric sensors are never asked for: the logbook never holds them, and a query that names them is
far slower for nothing. Their entries are worked out from recorded history instead.

Almost all of a zone's log is automation runs, an alert re-firing on every sensor update or a watchdog on a timer, so
repeated runs are collapsed into one row with a count. Nothing that identifies a login, a context or a device leaves
here: a person is sent by name, an automation outside the zone by name only, and a trigger as its kind, named only when
what it watched is the zone's own. Home Assistant's own wording of a trigger can name any entity, topic or place.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import DOMAIN, MAX_LOOKBACK_HOURS

# A page is a local day, and a day across a clock change is 25 hours.
MAX_PAGE_HOURS = 25
# A day of one zone is a few dozen device changes and a few streaks once runs are collapsed; this leaves room for a
# busy one while keeping the answer small enough for a phone. Past it the newest rows are kept and `more` is set.
MAX_ENTRIES = 500
# A page is read this much at a time, newest first, so a busy day is never held whole and reading stops once the cap is
# met.
SLICE_HOURS = 6
# A cold query for one day took several seconds in a real install. Past this the panel is told, rather than left
# waiting; the database read itself runs on in the recorder's thread until it finishes.
QUERY_TIMEOUT_S = 30
# Boards take a while to reconnect after Home Assistant starts. A change with no recorded cause this soon after a start
# is put down to the start.
STARTUP_S = 5 * 60
# What a change with no recorded cause came back from, which makes it a reconnect.
GONE = frozenset({"unavailable", "unknown"})
# The logbook's own bounds are exclusive and its times finer than a datetime holds, so each slice is read this much
# wider and cut to the exact times here.
PAD = timedelta(seconds=1)
# The recorder's database threads are shared with Home Assistant's own history and logbook, and a timed-out read keeps
# its thread, so only one Activity read runs at a time.
_READ = f"{DOMAIN}_activity_read"

ENTITY = r"[a-z0-9_]+\.[a-z0-9_]+"
# Triggers that start with what they watched: a zone's entering or leaving, and a template's entity.
LED_BY_ENTITY = (
    (re.compile(rf"({ENTITY}) (?:entering|leaving) "), "zone"),
    (re.compile(rf"({ENTITY}) via template$"), "template"),
)
# The rest, by their leading words. A True entry is followed by the entity it watched, and nothing else.
LEADS = (
    ("numeric state of", "numeric_state", True),
    ("state of", "state", True),
    ("time set in", "time", True),
    ("time pattern", "time_pattern", False),
    ("time change or manual update via template", "template", False),
    ("time", "time", False),
    ("event", "event", False),
    ("mqtt", "mqtt", False),
    ("webhook", "webhook", False),
    ("sun", "sun", False),
    ("tag", "tag", False),
    ("geo_location", "geo_location", False),
    ("home assistant", "homeassistant", False),
    ("device", "device", False),
)


class ActivityTimeout(Exception):
    """The logbook took too long to answer."""


class ActivityBusy(Exception):
    """Another page of Activity is being read."""


class ActivityTooOld(Exception):
    """The page ends before the oldest moment Activity reaches."""


@dataclass
class _Read:
    key: tuple[str, float, float]
    waiters: int = 1
    task: asyncio.Task[dict[str, Any] | None] | None = None


def zone_entities(config: dict[str, Any], zone_id: str) -> tuple[list[str], set[str], dict[str, str]] | None:
    """The zone's mapped device entities, the automations it links, and the names its setup gives its own entities.

    None for a zone the setup doesn't have.
    """
    zone = next((z for z in config.get("zones") or [] if isinstance(z, dict) and z.get("id") == zone_id), None)
    if zone is None:
        return None
    mapped = [d for d in config.get("devices") or [] if isinstance(d, dict) and zone_id in (d.get("zones") or [])]
    devices = [d["entity"] for d in mapped if isinstance(d.get("entity"), str)]
    automations = {a["entity"] for a in zone.get("automations") or [] if isinstance(a, dict) and "entity" in a}
    names: dict[str, str] = {}
    for x in zone.get("sensors") or []:
        if isinstance(x, dict) and isinstance(x.get("name"), str) and isinstance(x.get("entities"), dict):
            names.update((e, x["name"]) for e in x["entities"].values() if isinstance(e, str))
    names.update(
        (d["entity"], d["name"]) for d in mapped if isinstance(d.get("entity"), str) and isinstance(d.get("name"), str)
    )
    return devices, automations, names


def trigger(source: Any, names: dict[str, str]) -> dict[str, str]:
    """The kind of a trigger Home Assistant described, named only when what it watched is one of the zone's own."""
    kind, entity = "other", None
    text = source if isinstance(source, str) else ""
    words = text.lower() + " "
    for pattern, led in LED_BY_ENTITY:
        if found := pattern.match(text):
            kind, entity = led, found.group(1)
            break
    else:
        for lead, led, watched in LEADS:
            if words.startswith(lead + " "):
                kind, entity = led, text[len(lead) + 1 :] if watched else None
                break
    out = {"kind": kind}
    if entity is not None and (name := names.get(entity)):
        out["name"] = name
    return out


def _startups(hass: HomeAssistant, start: float, end: float) -> list[float]:
    """When Home Assistant started recording, from the recorder's own run table, for starts that touch this slice."""
    from homeassistant.components.recorder.db_schema import RecorderRuns
    from homeassistant.components.recorder.models import process_timestamp
    from homeassistant.components.recorder.util import session_scope
    from sqlalchemy import select

    with session_scope(hass=hass, read_only=True) as session:
        found = session.execute(
            select(RecorderRuns.start).where(
                RecorderRuns.start >= dt_util.utc_from_timestamp(start - STARTUP_S) - PAD,
                RecorderRuns.start <= dt_util.utc_from_timestamp(end) + PAD,
            )
        ).scalars()
        return sorted(process_timestamp(s).timestamp() for s in found)


def _read(hass: HomeAssistant, processor: Any, start: float, end: float) -> tuple[list[dict[str, Any]], list[float]]:
    """In the recorder's executor: one slice of the logbook's rows, from start up to but not including end."""
    rows = processor.get_events(dt_util.utc_from_timestamp(start) - PAD, dt_util.utc_from_timestamp(end) + PAD)
    rows = [r for r in rows if isinstance(r.get("when"), int | float) and start <= r["when"] < end]
    return rows, _startups(hass, start, end)


class Collapse:
    """The panel's rows, built from the logbook's newest first, each automation's repeated runs collapsed.

    A streak is the same automation running on the same trigger with no other entry of that automation in between;
    entries of other entities in between don't break it. Once the cap is met the walk stops before the next row that
    would add an entry, never between two rows of the same time, so `next_end` (the oldest row taken) splits the log
    cleanly: the next page, asked to end there, holds exactly the rows not taken here. A streak still open at that
    point carries on as a row of its own on the next page; its runs are counted once either way.
    """

    def __init__(self, devices: set[str], linked: set[str], names: dict[str, str], cap: int) -> None:
        self.devices, self.linked, self.names, self.cap = devices, linked, names, cap
        self.entries: list[dict[str, Any]] = []
        self.more = False
        self.next_end: float | None = None
        self._streaks: dict[str, tuple[Any, dict[str, Any]]] = {}
        # Changes with no recorded cause, waiting on the change before them to say whether they were a reconnect.
        self._unexplained: dict[str, dict[str, Any]] = {}

    def feed(self, rows: list[dict[str, Any]], users: dict[str, str | None], startups: list[float]) -> bool:
        """Take one slice, oldest first as the logbook gives it. False once the page is full and wants no older row."""
        for row in reversed(rows):
            entity, when = row.get("entity_id"), row.get("when")
            if not isinstance(entity, str) or not isinstance(when, int | float):
                continue
            is_change = "state" in row and (entity in self.devices or entity in self.linked)
            # A run is the automation's own triggered event; a hand-written logbook entry about it has no source key.
            is_run = not is_change and row.get("domain") == "automation" and "source" in row and entity in self.linked
            streak = self._streaks.get(entity) if is_run else None
            extends = streak is not None and streak[0] == row["source"]
            if (
                len(self.entries) >= self.cap
                and (is_change or (is_run and not extends))
                and self.next_end is not None
                and when < self.next_end
            ):
                self.more = True
                return False
            self.next_end = when
            if is_change:
                self._change(row, entity, when, users, startups)
            elif extends:
                assert streak is not None
                streak[1]["count"] += 1
                streak[1]["first"] = when
            elif is_run:
                run = {"kind": "run", "when": when, "entity": entity, "name": row.get("name")}
                run.update(trigger=trigger(row["source"], self.names), count=1, first=when, last=when)
                self._streaks[entity] = (row["source"], run)
                self.entries.append(run)
        return True

    def _change(
        self, row: dict[str, Any], entity: str, when: float, users: dict[str, str | None], startups: list[float]
    ) -> None:
        state = row["state"]
        if (newer := self._unexplained.pop(entity, None)) is not None and state in GONE and newer["state"] not in GONE:
            newer["cause"] = {"type": "reconnect"}
        self._streaks.pop(entity, None)
        cause: dict[str, Any]
        if row.get("context_event_type") == "automation_triggered":
            cause = {"type": "automation", "name": row.get("context_name")}
            cause["trigger"] = trigger(row.get("context_source"), self.names)
            if row.get("context_entity_id") in self.linked:
                cause["entity"] = row["context_entity_id"]
        elif user_id := row.get("context_user_id"):
            cause = {"type": "person", "name": users.get(user_id)}
        elif any(0 <= when - s <= STARTUP_S for s in startups):
            cause = {"type": "startup"}
        else:
            cause = {"type": "none"}
        kind = "automation" if entity in self.linked else "device"
        entry = {"kind": kind, "when": when, "entity": entity, "name": row.get("name"), "state": state, "cause": cause}
        if cause["type"] == "none":
            self._unexplained[entity] = entry
        self.entries.append(entry)


async def _user_names(hass: HomeAssistant, rows: list[dict[str, Any]]) -> dict[str, str | None]:
    names: dict[str, str | None] = {}
    for user_id in {r["context_user_id"] for r in rows if isinstance(r.get("context_user_id"), str)}:
        user = await hass.auth.async_get_user(user_id)
        names[user_id] = user.name if user else None
    return names


async def _page(
    hass: HomeAssistant,
    read: _Read,
    collapse: Collapse,
    entities: list[str],
    event_types: Any,
    page: dict[str, float],
) -> dict[str, Any] | None:
    from homeassistant.components.logbook.processor import EventProcessor
    from homeassistant.components.recorder import get_instance

    start, end = page["start"], page["end"]
    try:
        slice_end = end
        while slice_end > start:
            # Everyone who asked has given up, so the older slices would be read for nobody.
            if not read.waiters:
                return None
            slice_start = max(start, slice_end - SLICE_HOURS * 3600)
            processor = EventProcessor(
                hass, event_types, entities, None, None, timestamp=True, include_entity_name=True
            )
            rows, startups = await get_instance(hass).async_add_executor_job(
                _read, hass, processor, slice_start, slice_end
            )
            if not collapse.feed(rows, await _user_names(hass, rows), startups):
                break
            slice_end = slice_start
        return {
            **page,
            "entries": collapse.entries,
            "more": collapse.more,
            "next_end": collapse.next_end if collapse.more else None,
        }
    finally:
        if hass.data.get(_READ) is read:
            del hass.data[_READ]


async def async_activity(
    hass: HomeAssistant, zone_id: str, zone: tuple[list[str], set[str], dict[str, str]], start: float, end: float
) -> dict[str, Any]:
    """One page of a zone's Activity, from start up to end, with start clamped to the oldest moment Activity reaches."""
    from homeassistant.components.logbook.helpers import async_determine_event_types, async_filter_entities
    from homeassistant.components.recorder import get_instance

    devices, linked, names = zone
    keep = min(MAX_LOOKBACK_HOURS, get_instance(hass).keep_days * 24)
    earliest = dt_util.utcnow().timestamp() - keep * 3600
    if end <= earliest:
        raise ActivityTooOld
    key = (zone_id, start, end)
    start = max(start, earliest)
    page = {"start": start, "end": end, "earliest": earliest}
    entities = async_filter_entities(hass, list(dict.fromkeys([*devices, *sorted(linked)])))
    if not entities:
        return {**page, "entries": [], "more": False, "next_end": None}
    read = hass.data.get(_READ)
    if read is not None and read.key != key:
        raise ActivityBusy
    if read is None:
        read = hass.data[_READ] = _Read(key)
        kept = set(entities)
        collapse = Collapse(set(devices) & kept, linked & kept, names, MAX_ENTRIES)
        event_types = async_determine_event_types(hass, entities, None)
        read.task = hass.async_create_background_task(
            _page(hass, read, collapse, entities, event_types, page), name=f"{DOMAIN} activity read"
        )
        # A read whose callers all timed out has nobody to raise to.
        read.task.add_done_callback(lambda t: t.cancelled() or t.exception())
    else:
        read.waiters += 1
    try:
        async with asyncio.timeout(QUERY_TIMEOUT_S):
            assert read.task is not None
            result = await asyncio.shield(read.task)
    except TimeoutError as err:
        raise ActivityTimeout from err
    finally:
        read.waiters -= 1
    assert result is not None
    return result
