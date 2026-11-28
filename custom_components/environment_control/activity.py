"""One zone's Activity: what Home Assistant's logbook says happened to its devices and linked automations, a page at a
time, shaped here so the panel never sees the raw log.

Read only. The entities asked for come from the stored setup, never from the caller: the zone's mapped devices and the
automations it links. Numeric sensors are never asked for: the logbook never holds them, and a query that names them is
far slower for nothing. Their entries are worked out from recorded history instead.

Almost all of a zone's log is automation runs, an alert re-firing on every sensor update or a watchdog on a timer, so
repeated runs are collapsed into one row with a count. A mapped sensor reading that stopped reporting, and its return,
is worked out from its recorded history by the panel's own stale rule, for a reading shown to report while its
value holds, and merged in by time. Nothing that identifies a
login, a context or a device leaves here: a person is sent by name, an automation outside the zone by name only, a
trigger as its kind, named only when what it watched is the zone's own, and a sensor by its id and name in the setup,
never its entities or its readings' values. Home Assistant's own wording of a trigger can name any entity, topic or
place.
"""

from __future__ import annotations

import asyncio
import heapq
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, NamedTuple

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import DOMAIN, MAX_LOOKBACK_HOURS
from .history import STALE_S, number, reported, sensor_readings

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
# A reading's history is read from this far before each slice, so a stop or return just before the slice's start is
# seen, and a group across that edge is seen whole from both sides.
LOOK_BACK_S = 2 * STALE_S
# Runs of a streak further apart than this are two rows, so a row's times mean the automation kept running across them.
STREAK_GAP_S = 60 * 60
# Readings of one sensor that stop or come back within this long of each other are one board's event, one row.
TOGETHER_S = 1.0
# The recorder's database threads are shared with Home Assistant's own history and logbook, and a timed-out read keeps
# its thread, so only one Activity read runs at a time.
_READ = f"{DOMAIN}_activity_read"

_LOGGER = logging.getLogger(__name__)

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


class Reading(NamedTuple):
    """One reading a zone's sensor maps: the sensor's id and name in the setup, which reading, and its entity."""

    sensor: str
    name: str
    reading: str
    entity: str


Zone = tuple[list[str], set[str], dict[str, str], list[Reading]]


def zone_entities(config: dict[str, Any], zone_id: str) -> Zone | None:
    """The zone's mapped device entities, the automations it links, the names its setup gives its own entities, and
    its sensors' readings.

    None for a zone the setup doesn't have.
    """
    zone = next((z for z in config.get("zones") or [] if isinstance(z, dict) and z.get("id") == zone_id), None)
    if zone is None:
        return None
    mapped = [d for d in config.get("devices") or [] if isinstance(d, dict) and zone_id in (d.get("zones") or [])]
    devices = [d["entity"] for d in mapped if isinstance(d.get("entity"), str)]
    automations = {a["entity"] for a in zone.get("automations") or [] if isinstance(a, dict) and "entity" in a}
    readings = [
        Reading(s["id"], s["name"], reading, e)
        for s, reading, e in sensor_readings(zone)
        if isinstance(s.get("id"), str) and isinstance(s.get("name"), str)
    ]
    names = {r.entity: r.name for r in readings}
    names.update(
        (d["entity"], d["name"]) for d in mapped if isinstance(d.get("entity"), str) and isinstance(d.get("name"), str)
    )
    return devices, automations, names, readings


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


class Turn(NamedTuple):
    """A reading stopping or coming back. since is its last real reading before the stop, None where that's unknown."""

    when: float
    state: str
    since: float | None


def proves_timed(rows: list[tuple[float, Any, float]], startups: Sequence[float]) -> bool:
    """Whether a reading's rows, as `reported` gives them, show it reports while its value holds.

    Only then does silence mean it stopped. Some integrations (MQTT, Zigbee) write nothing at all for a value that
    holds, so a steady reading from one looks exactly like a dead one. Proof is a report later than the row's last
    change, or the same number written twice in a row, which is what force_update looks like; a restart writes every
    state anew, so a repeat across one proves nothing.
    """
    for i, (t, state, heard) in enumerate(rows):
        if heard > t:
            return True
        repeat = i and state == rows[i - 1][1] and number(state) is not None
        if repeat and not any(rows[i - 1][0] < s <= t for s in startups):
            return True
    return False


def turns(
    rows: list[tuple[float, Any, float]], end: float, startups: Sequence[float] = (), timed: bool = True
) -> list[Turn]:
    """Where one reading stopped and came back, from its rows as `reported` gives them, read up to end.

    A reading stops on a state that isn't a number, or, when timed, once it has gone unreported for longer than the
    panel's stale rule, at its last report plus that rule; it is back at its first number after. Its state before its
    first row is unknown, so neither the first row nor anything before it is a turn.
    """
    out: list[Turn] = []
    up: bool | None = None
    heard = 0.0
    since: float | None = None
    for i, (t, state, last_report) in enumerate(rows):
        if up and timed and t > heard + STALE_S:
            out.append(Turn(heard + STALE_S, "stopped", since))
            up = False
        if number(state) is not None:
            if up is False:
                out.append(Turn(t, "back", since))
            up, heard, since = True, last_report, last_report
            # The recorder never stores when a row current at a restart last reported, so the reading is taken as
            # reporting up to the restart, and when it last read is unknown.
            to = rows[i + 1][0] if i + 1 < len(rows) else end
            if restarts := [s for s in startups if t < s <= to]:
                heard, since = max(heard, *restarts), None
        elif up:
            out.append(Turn(t, "stopped", since))
            up = False
        elif up is None:
            up, since = False, None
    if up and timed and heard + STALE_S < end:
        out.append(Turn(heard + STALE_S, "stopped", since))
    return out


@dataclass
class SensorRow:
    """A sensor row on its way to the panel, with each reading's own last reading before the stop kept beside it."""

    row: dict[str, Any]
    since: dict[str, float | None]


def sensor_rows(
    readings: list[Reading],
    found: dict[str, list[Turn]],
    start: float,
    end: float,
    startups: Sequence[float] = (),
) -> list[SensorRow]:
    """The sensor rows from start up to end, oldest first, each sensor's readings that turned together grouped.

    A sensor's readings that all stop, or all come back, within TOGETHER_S of each other are one row with reading
    "all": a board dropping off the network is one event. Anything less than all of them is a row per reading. A row
    this soon after Home Assistant started is put down to the start, as a device's change is.
    """
    by_sensor: dict[str, list[Reading]] = {}
    for r in readings:
        by_sensor.setdefault(r.sensor, []).append(r)
    out: list[SensorRow] = []
    for mine in by_sensor.values():
        items = sorted(((turn, r) for r in mine for turn in found.get(r.entity, [])), key=lambda x: x[0].when)
        everyone = {r.reading for r in mine}
        taken: set[int] = set()
        for i, (turn, r) in enumerate(items):
            if i in taken:
                continue
            group = [i]
            if len(everyone) > 1:
                seen = {r.reading}
                for j in range(i + 1, len(items)):
                    other, o = items[j]
                    if other.when - turn.when >= TOGETHER_S:
                        break
                    if j not in taken and other.state == turn.state and o.reading not in seen:
                        group.append(j)
                        seen.add(o.reading)
                if seen != everyone:
                    group = [i]
            taken.update(group)
            if not start <= turn.when < end:
                continue
            reading = "all" if len(group) > 1 else r.reading
            row = {"kind": "sensor", "when": turn.when, "sensor": r.sensor, "name": r.name, "reading": reading}
            row["state"] = turn.state
            if any(0 <= turn.when - s <= STARTUP_S for s in startups):
                row["cause"] = {"type": "startup"}
            out.append(SensorRow(row, {items[k][1].reading: items[k][0].since for k in group}))
    out.sort(key=lambda x: x.row["when"])
    return out


def _sensor_read(
    hass: HomeAssistant,
    readings: list[Reading],
    start: float,
    end: float,
    live: dict[str, tuple[float, float]],
    timed: set[str],
) -> list[SensorRow]:
    """In the recorder's executor: one slice of the sensor rows, from start up to but not including end.

    Each reading is read from LOOK_BACK_S before the slice, to know its state at the slice's start, to TOGETHER_S past
    it, so a group across the slice's end is seen whole from both sides. live is each reading's (last updated, last
    reported) now; timed, the readings already shown to report while their value holds, grows as the page is read.
    """
    lo, hi = dt_util.utc_from_timestamp(start - LOOK_BACK_S), dt_util.utc_from_timestamp(end + TOGETHER_S)
    # A silence that hasn't yet run past the stale rule isn't a stop yet.
    known_to = min(hi.timestamp(), dt_util.utcnow().timestamp())
    startups = _startups(hass, lo.timestamp(), hi.timestamp())
    found = {}
    for entity in dict.fromkeys(r.entity for r in readings):
        rows = reported(hass, entity, lo, hi, live.get(entity))
        if entity not in timed and proves_timed(rows, startups):
            timed.add(entity)
        found[entity] = turns(rows, known_to, startups, entity in timed)
    return sensor_rows(readings, found, start, end, startups)


def _when(x: dict[str, Any] | SensorRow) -> Any:
    return x.row["when"] if isinstance(x, SensorRow) else x["when"]


class Collapse:
    """The panel's rows, built from the logbook's newest first, each automation's repeated runs collapsed.

    A streak is the same automation running on the same trigger with no other entry of that automation in between and no
    gap of more than STREAK_GAP_S between runs; entries of other entities in between don't break it. Once the cap is met
    the walk stops before the next row that would add an entry, never between two rows of the same time, so `next_end`
    (the oldest row taken) splits the log cleanly: the next page, asked to end there, holds exactly the rows not taken
    here. A streak still open at that point carries on as a row of its own on the next page; its runs are counted once
    either way. A sensor row is taken like a device change.
    """

    def __init__(self, devices: set[str], linked: set[str], names: dict[str, str], cap: int) -> None:
        self.devices, self.linked, self.names, self.cap = devices, linked, names, cap
        self.entries: list[dict[str, Any]] = []
        self.more = False
        self.next_end: float | None = None
        self._streaks: dict[str, tuple[Any, dict[str, Any]]] = {}
        # Changes with no recorded cause, waiting on the change before them to say whether they were a reconnect.
        self._unexplained: dict[str, dict[str, Any]] = {}
        # A sensor row back from a stop older than its slice reaches, waiting on that stop for its readings' times.
        self._back: dict[tuple[str, str], SensorRow] = {}

    def feed(
        self,
        rows: list[dict[str, Any]],
        users: dict[str, str | None],
        startups: list[float],
        sensors: list[SensorRow] | None = None,
    ) -> bool:
        """Take one slice, oldest first as the logbook gives it. False once the page is full and wants no older row."""
        merged = heapq.merge(
            rows, sensors or [], key=lambda x: x.row["when"] if isinstance(x, SensorRow) else x["when"]
        )
        for row in reversed(list(merged)):
            if isinstance(row, SensorRow):
                if len(self.entries) >= self.cap and self.next_end is not None and row.row["when"] < self.next_end:
                    self.more = True
                    return False
                self.next_end = row.row["when"]
                self._sensor(row)
                continue
            entity, when = row.get("entity_id"), row.get("when")
            if not isinstance(entity, str) or not isinstance(when, int | float):
                continue
            is_change = "state" in row and (entity in self.devices or entity in self.linked)
            # A run is the automation's own triggered event; a hand-written logbook entry about it has no source key.
            is_run = not is_change and row.get("domain") == "automation" and "source" in row and entity in self.linked
            streak = self._streaks.get(entity) if is_run else None
            extends = streak is not None and streak[0] == row["source"] and streak[1]["first"] - when <= STREAK_GAP_S
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

    def _sensor(self, item: SensorRow) -> None:
        sensor = item.row["sensor"]
        if item.row["state"] == "stopped":
            for reading, since in item.since.items():
                if (newer := self._back.pop((sensor, reading), None)) is not None:
                    newer.since[reading] = since
                    self._settle(newer)
        else:
            for reading, since in item.since.items():
                if since is None:
                    self._back[(sensor, reading)] = item
            self._settle(item)
        self.entries.append(item.row)

    @staticmethod
    def _settle(item: SensorRow) -> None:
        if item.since and all(s is not None for s in item.since.values()):
            item.row["since"] = min(s for s in item.since.values() if s is not None)

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
    readings: list[Reading],
    event_types: Any,
    page: dict[str, float],
) -> dict[str, Any] | None:
    from homeassistant.components.logbook.processor import EventProcessor
    from homeassistant.components.recorder import get_instance

    start, end = page["start"], page["end"]
    # Decided once a page and never undone, so a quiet slice doesn't turn a reading's silences off.
    timed: set[str] = set()
    try:
        slice_end = end
        while slice_end > start:
            # Everyone who asked has given up, so the older slices would be read for nobody.
            if not read.waiters:
                return None
            slice_start = max(start, slice_end - SLICE_HOURS * 3600)
            rows: list[dict[str, Any]] = []
            startups: list[float] = []
            if entities:
                processor = EventProcessor(
                    hass, event_types, entities, None, None, timestamp=True, include_entity_name=True
                )
                rows, startups = await get_instance(hass).async_add_executor_job(
                    _read, hass, processor, slice_start, slice_end
                )
            sensors = []
            if readings:
                live = {
                    r.entity: (s.last_updated_timestamp, s.last_reported_timestamp)
                    for r in readings
                    if (s := hass.states.get(r.entity)) is not None
                }
                timed.update(e for e, (updated, reported_at) in live.items() if reported_at > updated)
                sensors = await get_instance(hass).async_add_executor_job(
                    _sensor_read, hass, readings, slice_start, slice_end, live, timed
                )
            if not collapse.feed(rows, await _user_names(hass, rows), startups, sensors):
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


def _done(read: _Read, task: asyncio.Task[Any]) -> None:
    # Runs before any caller still waiting is woken, so a caller left means the failure reaches it.
    if task.cancelled() or (err := task.exception()) is None or read.waiters:
        return
    # A read whose callers all timed out has nobody to raise to.
    _LOGGER.error("An Activity read failed after every caller had stopped waiting", exc_info=err)


async def async_activity(hass: HomeAssistant, zone_id: str, zone: Zone, start: float, end: float) -> dict[str, Any]:
    """One page of a zone's Activity, from start up to end, with start clamped to the oldest moment Activity reaches."""
    from homeassistant.components.logbook.helpers import async_determine_event_types, async_filter_entities
    from homeassistant.components.recorder import get_instance

    devices, linked, names, readings = zone
    keep = min(MAX_LOOKBACK_HOURS, get_instance(hass).keep_days * 24)
    earliest = dt_util.utcnow().timestamp() - keep * 3600
    if end <= earliest:
        raise ActivityTooOld
    key = (zone_id, start, end)
    start = max(start, earliest)
    page = {"start": start, "end": end, "earliest": earliest}
    entities = async_filter_entities(hass, list(dict.fromkeys([*devices, *sorted(linked)])))
    if not entities and not readings:
        return {**page, "entries": [], "more": False, "next_end": None}
    read = hass.data.get(_READ)
    if read is not None and read.key != key:
        raise ActivityBusy
    if read is None:
        read = _Read(key)
        kept = set(entities)
        collapse = Collapse(set(devices) & kept, linked & kept, names, MAX_ENTRIES)
        event_types = async_determine_event_types(hass, entities, None)
        read.task = hass.async_create_background_task(
            _page(hass, read, collapse, entities, readings, event_types, page), name=f"{DOMAIN} activity read"
        )
        read.task.add_done_callback(lambda t: _done(read, t))
        # Only once the task exists, whose end clears it: set any earlier, a line above that raised would leave
        # Activity busy until Home Assistant restarts.
        hass.data[_READ] = read
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
