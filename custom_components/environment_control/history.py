"""Recorded readings for the panel's charts, bucketed here so a week of 10 second readings never reaches a phone.

Read only, and only for entities the stored setup maps as a sensor's readings, over a fixed set of ranges. Every row
is read, never HA's minimal response, which drops a row that repeats the one before: on a board that reports the
same value every 10 seconds that would make a working sensor look stopped.

The accuracy rules are the live readings' rules. A reading that isn't a number is no data and breaks the line. A
reading counts for at most 10 minutes after it was recorded, so a board that stops reporting while it stays connected
breaks the line too, rather than drawing its last number on. Each bucket keeps its time-weighted mean and its own low
and high, so a spike inside a bucket still shows in a range's Min and Max.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import MAX_LOOKBACK_HOURS

# Matches the frontend's STALE_MS.
STALE_S = 10 * 60
# 4 is the light card's line; the rest are the History card's ranges, the longest as far back as the panel reads.
HOURS = frozenset({4, 6, 24, 72, MAX_LOOKBACK_HOURS})
MIN_BUCKETS, MAX_BUCKETS = 12, 1000
MAX_ENTITIES = 24


def sensor_readings(zone: Any) -> list[tuple[dict[str, Any], str, str]]:
    """Each (sensor, reading, entity) one zone of the stored setup maps."""
    out: list[tuple[dict[str, Any], str, str]] = []
    for s in (zone.get("sensors") or []) if isinstance(zone, dict) else []:
        entities = s.get("entities") if isinstance(s, dict) else None
        if isinstance(entities, dict):
            out.extend((s, reading, e) for reading, e in entities.items() if isinstance(e, str))
    return out


def mapped_readings(config: dict[str, Any]) -> set[str]:
    """Every entity the stored setup reads a sensor's readings from."""
    return {e for z in config.get("zones") or [] for _, _, e in sensor_readings(z)}


def number(state: Any) -> float | None:
    try:
        v = float(state)
    except TypeError, ValueError:
        return None
    return v if math.isfinite(v) else None


def bucket(rows: Iterable[tuple[float, Any]], start: float, end: float, n: int) -> list[list[float] | None]:
    """Each of n equal buckets from start to end as [mean, low, high], or None where there's no live reading.

    rows are (timestamp, state) in time order, starting with the state in force at start. Each numeric state holds
    until the next row, for at most STALE_S, and never past end.
    """
    step = (end - start) / n
    acc = [[0.0, 0.0, math.inf, -math.inf] for _ in range(n)]
    rows = list(rows)
    for i, (t, state) in enumerate(rows):
        v = number(state)
        if v is None:
            continue
        held_to = min(rows[i + 1][0] if i + 1 < len(rows) else end, t + STALE_S, end)
        lo_t, hi_t = max(t, start), held_to
        if hi_t <= lo_t:
            continue
        first = max(0, int((lo_t - start) // step))
        last = min(n - 1, math.ceil((hi_t - start) / step) - 1)
        for b in range(first, last + 1):
            b_start = start + b * step
            overlap = min(b_start + step, hi_t) - max(b_start, lo_t)
            if overlap <= 0:
                continue
            a = acc[b]
            a[0] += v * overlap
            a[1] += overlap
            a[2] = min(a[2], v)
            a[3] = max(a[3], v)
    return [[round(a[0] / a[1], 4), a[2], a[3]] if a[1] > 0 else None for a in acc]


def recorded(hass: HomeAssistant, entity: str, start: datetime, end: datetime) -> list[tuple[float, Any]]:
    """In the recorder's executor: every recorded (time, state) of one entity from start up to end, oldest first.

    The first row is the state in force at start, timed at start: the recorder doesn't keep when it was recorded.
    """
    from homeassistant.components.recorder import history

    found = history.get_significant_states(
        hass,
        start,
        end,
        [entity],
        include_start_time_state=True,
        significant_changes_only=False,
        minimal_response=False,
        no_attributes=True,
        compressed_state_format=True,
    ).get(entity, [])
    return [(float(r["lu"]), r["s"]) for r in found if isinstance(r, dict) and "lu" in r]


def reported(
    hass: HomeAssistant, entity: str, start: datetime, end: datetime, live: tuple[float, float] | None
) -> list[tuple[float, Any, float]]:
    """In the recorder's executor: every recorded (time, state, last reported) of one entity from start up to end,
    oldest first, starting with the state in force at start at its own time.

    A sensor that reports an unchanged value, without force_update, gets no new row: only the row's last reported time
    moves, and the recorder writes that onto the row only once the next row arrives. So the newest row's is taken from
    live, the (last updated, last reported) of the state Home Assistant holds now, and a row that was current when Home
    Assistant stopped never gets one. The recorder's own start state has neither time, so it is read here.
    """
    from homeassistant.components.recorder import get_instance, history
    from homeassistant.components.recorder.db_schema import States
    from homeassistant.components.recorder.util import session_scope
    from sqlalchemy import select

    found = history.state_changes_during_period(
        hass, start, end, entity, no_attributes=True, include_start_time_state=False
    ).get(entity, [])
    out = [(s.last_updated_timestamp, s.state, max(s.last_updated_timestamp, s.last_reported_timestamp)) for s in found]
    with session_scope(hass=hass, read_only=True) as session:
        if (metadata_id := get_instance(hass).states_meta_manager.get(entity, session, False)) is not None:
            first = session.execute(
                select(States.state, States.last_updated_ts, States.last_reported_ts)
                .where(States.metadata_id == metadata_id, States.last_updated_ts <= start.timestamp())
                .order_by(States.last_updated_ts.desc())
                .limit(1)
            ).first()
            if first is not None:
                out.insert(0, (first[1], first[0], max(first[1], first[2] or 0)))
    if out and live is not None and abs(out[-1][0] - live[0]) < 1e-3:
        out[-1] = (out[-1][0], out[-1][1], max(out[-1][2], live[1]))
    return out


def _read(hass: HomeAssistant, entities: list[str], start: datetime, end: datetime, n: int) -> dict[str, Any]:
    """In the recorder's executor: each entity's rows, bucketed one entity at a time so only one is held at once."""
    start_ts, end_ts, series = start.timestamp(), end.timestamp(), {}
    for entity in entities:
        rows = recorded(hass, entity, start, end)
        series[entity] = {"first": rows[0][0] if rows else None, "values": bucket(rows, start_ts, end_ts, n)}
    return {"start": start_ts, "end": end_ts, "step": (end_ts - start_ts) / n, "series": series}


async def async_history(hass: HomeAssistant, entities: list[str], hours: int, buckets: int) -> dict[str, Any]:
    """The bucketed history of each entity over the last hours, ending now."""
    from homeassistant.components.recorder import get_instance

    end = dt_util.utcnow()
    start = end - timedelta(hours=hours)
    return await get_instance(hass).async_add_executor_job(_read, hass, entities, start, end, buckets)
