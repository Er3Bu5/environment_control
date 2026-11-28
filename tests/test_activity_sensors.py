"""Activity's sensor rows: a zone's mapped readings that Home Assistant recorded going unavailable or unknown and coming
back, merged by time with the logbook's rows and paged with them. Silence alone is never a row."""

import json
from datetime import timedelta

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.components.recorder.common import async_wait_recording_done

from custom_components.environment_control import activity
from custom_components.environment_control.activity import Reading, Turn
from custom_components.environment_control.const import DOMAIN


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(recorder_mock, enable_custom_integrations):
    """The recorder has to start before HA does, so it comes ahead of the shared fixture here."""
    return


HEATER = "switch.garden_heater"
LEFT = {
    "temperature": "sensor.left_temp",
    "humidity": "sensor.left_rh",
    "vpd": "sensor.left_vpd",
    "light": "sensor.left_lux",
}
RIGHT, VEG = "sensor.right_temp", "sensor.veg_temp"
ROOM = {
    "zones": [
        {
            "id": "garden",
            "name": "Garden",
            "sensors": [
                {"id": "s1", "name": "Left", "kind": "env", "entities": LEFT},
                {"id": "s3", "name": "Right", "kind": "env", "entities": {"temperature": RIGHT}},
            ],
        },
        {
            "id": "veg",
            "name": "Veg",
            "sensors": [{"id": "s2", "name": "Veg", "kind": "env", "entities": {"temperature": VEG}}],
        },
    ],
    "devices": [{"id": "d1", "name": "Heater", "zones": ["garden"], "entity": HEATER}],
}
# Distinctive, so the answer can be searched for them.
VALUES = {"temperature": "23.456", "humidity": "61.789", "vpd": "1.2345", "light": "40321"}


@pytest.fixture
async def room(hass: HomeAssistant, hass_ws_client):
    assert await async_setup_component(hass, "logbook", {})
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/config/save", "revision": 0, "config": ROOM})
    assert (await client.receive_json())["success"]
    # Closed, since these tests move the clock on by many minutes: an open connection's heartbeat would lapse.
    await client.close()

    async def ask(**msg):
        return await _activity(await hass_ws_client(hass), **msg)

    return ask


async def _activity(client, **msg):
    await client.send_json_auto_id({"type": f"{DOMAIN}/activity", **msg})
    r = await client.receive_json()
    assert r["success"], r
    return r["result"]


class Clock:
    # Far less than half an hour in all, the life of the test's access token.
    def __init__(self, hass, freezer):
        self.hass, self.freezer = hass, freezer
        # Past the recorder's start, so whether a row is within the startup window is judged from after it.
        self.now = dt_util.utcnow().replace(microsecond=0) + timedelta(seconds=1)

    async def at(self, seconds, *changes):
        """Move on, then make every change in the same instant."""
        self.now += timedelta(seconds=seconds)
        self.freezer.move_to(self.now)
        for entity, state in changes:
            self.hass.states.async_set(entity, state)
        await self.hass.async_block_till_done()
        return self.now.timestamp()


def _left(state=None):
    return [(e, state or VALUES[r]) for r, e in LEFT.items()]


def test_unavailable_then_back_is_a_stop_and_a_return() -> None:
    rows = [(0, "20"), (100, "20.5"), (150, "unavailable"), (400, "21")]
    assert activity.turns(rows) == [Turn(150, "stopped", 150), Turn(400, "back", 150)]


def test_unknown_counts_like_unavailable() -> None:
    rows = [(0, "20"), (100, "unknown"), (105, "unavailable"), (110, "21")]
    assert activity.turns(rows) == [Turn(100, "stopped", 100), Turn(110, "back", 100)]


def test_a_reading_already_down_at_the_first_row_is_only_back() -> None:
    assert activity.turns([(0, "unavailable"), (50, "unknown"), (100, "21")]) == [Turn(100, "back", None)]


def test_four_readings_stopping_together_are_one_row_and_three_are_three() -> None:
    readings = [Reading("s1", "Left", r, e) for r, e in LEFT.items()]
    found = {e: [Turn(100 + i * 0.2, "stopped", 90), Turn(200, "back", 90)] for i, e in enumerate(LEFT.values())}
    rows = [x.row for x in activity.sensor_rows(readings, found, 0, 1000)]
    assert rows == [
        {"kind": "sensor", "when": 100, "sensor": "s1", "name": "Left", "reading": "all", "state": "stopped"},
        {"kind": "sensor", "when": 200, "sensor": "s1", "name": "Left", "reading": "all", "state": "back"},
    ]
    found["sensor.left_lux"] = []
    rows = [x.row for x in activity.sensor_rows(readings, found, 0, 1000)]
    assert [(r["reading"], r["state"]) for r in rows] == [
        ("temperature", "stopped"),
        ("humidity", "stopped"),
        ("vpd", "stopped"),
        ("temperature", "back"),
        ("humidity", "back"),
        ("vpd", "back"),
    ]
    # More than a second apart is not together.
    found = {e: [Turn(100 + i * 0.5, "stopped", 90)] for i, e in enumerate(LEFT.values())}
    assert [x.row["reading"] for x in activity.sensor_rows(readings, found, 0, 1000)] == list(LEFT)


def test_a_sensor_row_soon_after_a_start_is_put_down_to_it() -> None:
    readings = [Reading("s3", "Right", "temperature", RIGHT)]
    turns = [Turn(900, "stopped", 800), Turn(1100, "back", 800), Turn(1000 + activity.STARTUP_S + 1, "stopped", 1100)]
    rows = [x.row for x in activity.sensor_rows(readings, {RIGHT: turns}, 0, 2000, [1000])]
    assert [r.get("cause") for r in rows] == [None, {"type": "startup"}, None]


async def test_a_zone_page_with_sensor_rows_among_the_logbook(room, hass, freezer, monkeypatch) -> None:
    # Slices of a few seconds, so rows fall on their edges too.
    monkeypatch.setattr(activity, "SLICE_HOURS", 4 / 3600)
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (HEATER, "off"), (RIGHT, "19.5"), (VEG, "18.25"), *_left())
    t_on = await clock.at(1, (HEATER, "on"))
    t_gone = await clock.at(1, *_left("unavailable"))
    await clock.at(1, (VEG, "unavailable"))
    t_off = await clock.at(1, (HEATER, "off"))
    t_back = await clock.at(1, *_left())
    t_lux = await clock.at(1, ("sensor.left_lux", "unknown"))
    t_lux_back = await clock.at(1, ("sensor.left_lux", "40000"))
    t_late = await clock.at(activity.STARTUP_S + 30, ("sensor.left_lux", "unavailable"))
    t_heat = await clock.at(1, (HEATER, "on"))
    await async_wait_recording_done(hass)

    result = await room(zone="garden", start=t0 - 60, end=t_heat + 1)
    assert result["more"] is False
    rows = [(e["kind"], e["when"], e.get("reading"), e.get("state"), e.get("since")) for e in result["entries"]]
    assert rows == [
        ("device", t_heat, None, "on", None),
        ("sensor", t_late, "light", "stopped", None),
        ("sensor", t_lux_back, "light", "back", t_lux),
        ("sensor", t_lux, "light", "stopped", None),
        ("sensor", t_back, "all", "back", t_gone),
        ("device", t_off, None, "off", None),
        ("sensor", t_gone, "all", "stopped", None),
        ("device", t_on, None, "on", None),
    ]
    sensor_rows = [e for e in result["entries"] if e["kind"] == "sensor"]
    assert all(e["sensor"] == "s1" and e["name"] == "Left" for e in sensor_rows)
    # The test's recorder started just before t0, so the early rows read as a restart's and the late ones don't.
    assert [e.get("cause") for e in sensor_rows if e["when"] in (t_gone, t_late)] == [None, {"type": "startup"}]
    allowed = {"kind", "when", "sensor", "name", "reading", "state", "since", "cause"}
    assert all(set(e) <= allowed for e in sensor_rows)
    text = json.dumps(result)
    for secret in (*LEFT.values(), RIGHT, VEG, "s2", *VALUES.values(), "40000", "19.5", "18.25"):
        assert secret not in text


async def test_a_reading_stopped_before_the_page_shows_only_its_return(room, hass, freezer, monkeypatch) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (HEATER, "off"), (RIGHT, "19.5"), ("sensor.left_temp", "20.5"))
    t_gone = await clock.at(5, (RIGHT, "unavailable"), ("sensor.left_temp", "unavailable"))
    t_back = await clock.at(120, ("sensor.left_temp", "21.5"))
    await async_wait_recording_done(hass)

    # Right is stopped all through the page and Left stopped before it: only Left's return, and when it stopped is
    # further back than the page reaches.
    result = await room(zone="garden", start=t_gone + 60, end=t_back + 1)
    assert [(e["reading"], e["state"], e.get("since")) for e in result["entries"]] == [("temperature", "back", None)]

    # A page that reaches the stop, read in slices too short for the return's to reach it, pairs them.
    monkeypatch.setattr(activity, "SLICE_HOURS", 60 / 3600)
    result = await room(zone="garden", start=t0 - 60, end=t_back + 1)
    assert [(e["when"], e["sensor"], e["reading"], e["state"], e.get("since")) for e in result["entries"]] == [
        (t_back, "s1", "temperature", "back", t_gone),
        (t_gone, "s3", "temperature", "stopped", None),
        (t_gone, "s1", "temperature", "stopped", None),
    ]


async def test_a_sensor_of_another_zone_never_appears(room, hass, freezer) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (VEG, "18.25"), (HEATER, "off"))
    await clock.at(1, (VEG, "unavailable"))
    t_end = await clock.at(1, (VEG, "18.5"))
    await async_wait_recording_done(hass)
    assert (await room(zone="garden", start=t0 - 60, end=t_end + 1))["entries"] == []
    veg = await room(zone="veg", start=t0 - 60, end=t_end + 1)
    assert [(e["sensor"], e["state"]) for e in veg["entries"]] == [("s2", "back"), ("s2", "stopped")]


async def test_the_cap_and_cursor_take_each_sensor_row_once(room, hass, freezer, monkeypatch) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (HEATER, "off"), (RIGHT, "19.5"))
    for i in range(4):
        await clock.at(1, (RIGHT, "unavailable"))
        await clock.at(1, (HEATER, "on" if i % 2 == 0 else "off"))
        await clock.at(1, (RIGHT, f"19.{i}"))
    t_end = clock.now.timestamp() + 1
    await async_wait_recording_done(hass)
    whole = (await room(zone="garden", start=t0 - 60, end=t_end))["entries"]
    assert len(whole) == 12 and sum(e["kind"] == "sensor" for e in whole) == 8

    monkeypatch.setattr(activity, "MAX_ENTRIES", 5)
    monkeypatch.setattr(activity, "SLICE_HOURS", 3 / 3600)
    pages, end = [], t_end
    while True:
        page = await room(zone="garden", start=t0 - 60, end=end)
        pages.append(page["entries"])
        if not page["more"]:
            break
        end = page["next_end"]
        assert all(e["when"] >= end for e in page["entries"])
    assert len(pages) == 3
    assert [e for p in pages for e in p] == whole


async def _direct(hass, start, end):
    # Straight to the read, not over the socket: these histories run longer than a test's access token lives.
    zone = activity.zone_entities(ROOM, "garden")
    result = await activity.async_activity(hass, "garden", zone, start, end)
    return [(e["when"], e["reading"], e["state"]) for e in result["entries"] if e["kind"] == "sensor"]


async def test_a_reading_silent_for_an_hour_but_still_a_number_is_no_row(room, hass, freezer) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (RIGHT, "19.5"))
    # Reported again unchanged, then nothing at all for an hour.
    await clock.at(60, (RIGHT, "19.5"))
    t_end = await clock.at(60 * 60, (RIGHT, "19.6"))
    await async_wait_recording_done(hass)
    assert await _direct(hass, t0 - 60, t_end + 1) == []


async def test_a_steady_reading_with_an_attribute_only_change_is_no_row(room, hass, freezer) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (RIGHT, "19.5"))
    for _ in range(3):
        await clock.at(4 * 60, (RIGHT, "19.5"))
    # A unit or name change writes a row whose state hasn't moved.
    await clock.at(60)
    hass.states.async_set(RIGHT, "19.5", {"unit_of_measurement": "C"})
    for _ in range(7):
        t_end = await clock.at(4 * 60, (RIGHT, "19.5"))
    await async_wait_recording_done(hass)
    assert await _direct(hass, t0 - 60, t_end + 1) == []


async def test_a_reading_that_writes_only_changes_is_judged_by_its_states(room, hass, freezer) -> None:
    # As MQTT and Zigbee sensors do: a value that holds moves nothing, so silence can't be told from steadiness.
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (RIGHT, "19.5"))
    t_gone = await clock.at(60 * 60, (RIGHT, "unavailable"))
    t_back = await clock.at(60, (RIGHT, "19.6"))
    t_end = await clock.at(30 * 60, (HEATER, "on"))
    await async_wait_recording_done(hass)
    assert await _direct(hass, t0 - 60, t_end + 1) == [
        (t_back, "temperature", "back"),
        (t_gone, "temperature", "stopped"),
    ]


async def test_readings_stopping_half_a_second_apart_across_a_slice_edge_are_one_row(
    room, hass, freezer, monkeypatch
) -> None:
    monkeypatch.setattr(activity, "SLICE_HOURS", 4 / 3600)
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, *_left())
    t_gone = await clock.at(5, *_left("unavailable")[:2])
    await clock.at(0.5, *_left("unavailable")[2:])
    # A slice starts between the two halves.
    result = await room(zone="garden", start=t0 - 60, end=t_gone + 0.25 + 4 * 3)
    assert [(e["when"], e["reading"], e["state"]) for e in result["entries"]] == [(t_gone, "all", "stopped")]


async def test_a_stop_at_the_cursor_beside_a_logbook_row_is_taken_once(room, hass, freezer, monkeypatch) -> None:
    clock = Clock(hass, freezer)
    t0 = await clock.at(0, (HEATER, "off"), (RIGHT, "19.5"), ("sensor.left_temp", "20.5"))
    await clock.at(1, (HEATER, "on"))
    # The cap is met on the first of the three rows at this time; the other two still belong to this page.
    t_both = await clock.at(1, (HEATER, "off"), (RIGHT, "unavailable"), ("sensor.left_temp", "unavailable"))
    t_end = await clock.at(1, (HEATER, "on"))
    await async_wait_recording_done(hass)
    whole = (await room(zone="garden", start=t0 - 60, end=t_end + 1))["entries"]

    monkeypatch.setattr(activity, "MAX_ENTRIES", 2)
    first = await room(zone="garden", start=t0 - 60, end=t_end + 1)
    assert first["more"] is True and first["next_end"] == t_both
    second = await room(zone="garden", start=t0 - 60, end=first["next_end"])
    assert [e for e in first["entries"] + second["entries"] if e["kind"] == "sensor"] == [
        e for e in whole if e["kind"] == "sensor"
    ]
    assert [e["when"] for e in first["entries"] + second["entries"]] == [e["when"] for e in whole]
