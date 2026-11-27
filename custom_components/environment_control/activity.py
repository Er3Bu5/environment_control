"""One zone's Activity: what Home Assistant's logbook says happened to its devices and linked automations, a page at a
time, shaped here so the panel never sees the raw log.

Read only. The entities asked for come from the stored setup, never from the caller: the zone's mapped devices and the
automations it links. Numeric sensors are never asked for: the logbook never holds them, and a query that names them is
far slower for nothing. Their entries are worked out from recorded history instead.

Almost all of a zone's log is automation runs, an alert re-firing on every sensor update or a watchdog on a timer, so
repeated runs are collapsed into one row with a count. Nothing that identifies a login, a context or a device leaves
here: a person is sent by name, and an automation outside the zone by name and trigger only.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import MAX_LOOKBACK_HOURS

# A page is a local day, and a day across a clock change is 25 hours.
MAX_PAGE_HOURS = 25
# A day of one zone is a few dozen device changes and a few streaks once runs are collapsed; this leaves room for a
# busy one while keeping the answer small enough for a phone. Past it the newest rows are kept and `more` is set.
MAX_ENTRIES = 500
# A cold query for one day took several seconds in a real install. Past this the panel is told, rather than left
# waiting; the database read itself runs on in the recorder's thread until it finishes.
QUERY_TIMEOUT_S = 30
# Boards take a while to reconnect after Home Assistant starts. A change with no recorded cause this soon after a start
# is put down to the start.
STARTUP_S = 5 * 60
# What a change with no recorded cause came back from, which makes it a reconnect.
GONE = frozenset({"unavailable", "unknown"})


class ActivityTimeout(Exception):
    """The logbook took too long to answer."""


def zone_entities(config: dict[str, Any], zone_id: str) -> tuple[list[str], set[str]] | None:
    """The zone's mapped device entities and the automations it links, or None for a zone the setup doesn't have."""
    zone = next((z for z in config.get("zones") or [] if isinstance(z, dict) and z.get("id") == zone_id), None)
    if zone is None:
        return None
    devices = [
        d["entity"]
        for d in config.get("devices") or []
        if isinstance(d, dict) and zone_id in (d.get("zones") or []) and isinstance(d.get("entity"), str)
    ]
    automations = {a["entity"] for a in zone.get("automations") or [] if isinstance(a, dict) and "entity" in a}
    return devices, automations


def _startups(hass: HomeAssistant, start: datetime, end: datetime) -> list[float]:
    """When Home Assistant started recording, from the recorder's own run table, for starts that touch this page."""
    from homeassistant.components.recorder.db_schema import RecorderRuns
    from homeassistant.components.recorder.models import process_timestamp
    from homeassistant.components.recorder.util import session_scope
    from sqlalchemy import select

    with session_scope(hass=hass, read_only=True) as session:
        found = session.execute(
            select(RecorderRuns.start).where(
                RecorderRuns.start >= start - timedelta(seconds=STARTUP_S), RecorderRuns.start <= end
            )
        ).scalars()
        return sorted(process_timestamp(s).timestamp() for s in found)


def _read(
    hass: HomeAssistant, event_types: Any, entities: list[str], start: datetime, end: datetime
) -> tuple[list[dict[str, Any]], list[float]]:
    """In the recorder's executor: the logbook's rows, the way its own get_events command reads them."""
    from homeassistant.components.logbook.processor import EventProcessor

    processor = EventProcessor(hass, event_types, entities, None, None, timestamp=True, include_entity_name=True)
    return processor.get_events(start, end), _startups(hass, start, end)


def _cause(
    row: dict[str, Any], linked: set[str], users: dict[str, str | None], startups: list[float], previous: str | None
) -> dict[str, Any]:
    if row.get("context_event_type") == "automation_triggered":
        cause = {"type": "automation", "name": row.get("context_name"), "trigger": row.get("context_source")}
        if row.get("context_entity_id") in linked:
            cause["entity"] = row["context_entity_id"]
        return cause
    if user_id := row.get("context_user_id"):
        return {"type": "person", "name": users.get(user_id)}
    when = row["when"]
    if any(0 <= when - s <= STARTUP_S for s in startups):
        return {"type": "startup"}
    if previous in GONE and row.get("state") not in GONE:
        return {"type": "reconnect"}
    return {"type": "none"}


def shape(
    rows: list[dict[str, Any]],
    devices: set[str],
    linked: set[str],
    users: dict[str, str | None],
    startups: list[float],
) -> tuple[list[dict[str, Any]], bool]:
    """The panel's rows, newest first, with each automation's repeated runs collapsed, and whether any were cut.

    rows are the logbook's, oldest first. A streak is the same automation running on the same trigger with no other
    entry of that automation in between; entries of other entities in between don't break it.
    """
    out: list[dict[str, Any]] = []
    streaks: dict[str, dict[str, Any]] = {}
    last_state: dict[str, str] = {}
    for row in rows:
        entity, when = row.get("entity_id"), row.get("when")
        if not isinstance(entity, str) or not isinstance(when, int | float):
            continue
        if "state" in row and (entity in devices or entity in linked):
            state = row["state"]
            kind = "automation" if entity in linked else "device"
            cause = _cause(row, linked, users, startups, last_state.get(entity))
            out.append(
                {"kind": kind, "when": when, "entity": entity, "name": row.get("name"), "state": state, "cause": cause}
            )
            last_state[entity] = state
            streaks.pop(entity, None)
        # A run is the automation's own triggered event; a hand-written logbook entry about it has no source key.
        elif row.get("domain") == "automation" and "source" in row and entity in linked:
            trigger = row.get("source")
            streak = streaks.get(entity)
            if streak is not None and streak["trigger"] == trigger:
                streak["count"] += 1
                streak["last"] = streak["when"] = when
                continue
            streak = {"kind": "run", "when": when, "entity": entity, "name": row.get("name"), "trigger": trigger}
            streak.update(count=1, first=when, last=when)
            streaks[entity] = streak
            out.append(streak)
    # A streak sits where its latest run is. The sort is stable, so same-second entries keep the log's order, reversed.
    out.reverse()
    out.sort(key=lambda e: e["when"], reverse=True)
    return out[:MAX_ENTRIES], len(out) > MAX_ENTRIES


async def _user_names(hass: HomeAssistant, rows: list[dict[str, Any]]) -> dict[str, str | None]:
    names: dict[str, str | None] = {}
    for user_id in {r["context_user_id"] for r in rows if isinstance(r.get("context_user_id"), str)}:
        user = await hass.auth.async_get_user(user_id)
        names[user_id] = user.name if user else None
    return names


async def async_activity(
    hass: HomeAssistant, devices: list[str], linked: set[str], start: datetime, end: datetime
) -> dict[str, Any]:
    """One page of a zone's Activity, from start to end."""
    from homeassistant.components.logbook.helpers import async_determine_event_types, async_filter_entities
    from homeassistant.components.recorder import get_instance

    instance = get_instance(hass)
    keep = min(MAX_LOOKBACK_HOURS, instance.keep_days * 24)
    page = {"start": start.timestamp(), "end": end.timestamp()}
    page["earliest"] = (dt_util.utcnow() - timedelta(hours=keep)).timestamp()
    entities = async_filter_entities(hass, list(dict.fromkeys([*devices, *sorted(linked)])))
    if not entities:
        return {**page, "entries": [], "more": False}
    event_types = async_determine_event_types(hass, entities, None)
    try:
        async with asyncio.timeout(QUERY_TIMEOUT_S):
            rows, startups = await instance.async_add_executor_job(_read, hass, event_types, entities, start, end)
    except TimeoutError as err:
        raise ActivityTimeout from err
    kept = set(entities)
    entries, more = shape(rows, set(devices) & kept, linked & kept, await _user_names(hass, rows), startups)
    return {**page, "entries": entries, "more": more}
