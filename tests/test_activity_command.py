"""The activity command, against HA's own recorder and logbook: one zone's devices and linked automations, a page at a
time, with causes put in words and repeated runs collapsed."""

import time
from datetime import timedelta

import pytest
from homeassistant.components.automation import EVENT_AUTOMATION_TRIGGERED
from homeassistant.core import Context, HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.components.recorder.common import async_wait_recording_done

from custom_components.environment_control import activity
from custom_components.environment_control.const import DOMAIN


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(recorder_mock, enable_custom_integrations):
    """The recorder has to start before HA does, so it comes ahead of the shared fixture here."""
    return


HEATER, FAN, ALERT, OTHER = (
    "switch.garden_heater",
    "switch.veg_fan",
    "automation.garden_heat_alert",
    "automation.veg_alert",
)
ROOM = {
    "zones": [
        {
            "id": "garden",
            "name": "Garden",
            "sensors": [{"id": "s1", "name": "Left", "kind": "env", "entities": {"temperature": "sensor.left_temp"}}],
            "automations": [{"id": "a1", "entity": ALERT, "group": "alert_day"}],
        },
        {"id": "veg", "name": "Veg", "automations": [{"id": "a2", "entity": OTHER, "group": "alert_day"}]},
    ],
    "devices": [
        {"id": "d1", "name": "Heater", "zones": ["garden"], "entity": HEATER},
        {"id": "d2", "name": "Fan", "zones": ["veg"], "entity": FAN},
    ],
}


async def _setup(hass: HomeAssistant, hass_ws_client, logbook: bool):
    if logbook:
        assert await async_setup_component(hass, "automation", {})
        assert await async_setup_component(hass, "logbook", {})
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/config/save", "revision": 0, "config": ROOM})
    assert (await client.receive_json())["success"]
    return client


@pytest.fixture
async def room(hass: HomeAssistant, hass_ws_client):
    return await _setup(hass, hass_ws_client, logbook=True)


async def _activity(client, **msg):
    await client.send_json_auto_id({"type": f"{DOMAIN}/activity", **msg})
    return await client.receive_json()


def _day(**extra):
    end = dt_util.utcnow().timestamp() + 1
    return {"zone": "garden", "start": end - 86400, "end": end, **extra}


class Clock:
    """Moves frozen time on a second per step, so the log's order is the order written."""

    def __init__(self, hass, freezer, start):
        self.hass, self.freezer, self.now = hass, freezer, start

    async def step(self, fn):
        self.now += timedelta(seconds=1)
        self.freezer.move_to(self.now)
        fn()
        await self.hass.async_block_till_done()


def _run(hass, entity, source, context=None, name="Garden heat alert"):
    return lambda: hass.bus.async_fire(
        EVENT_AUTOMATION_TRIGGERED, {"name": name, "entity_id": entity, "source": source}, context=context
    )


def _set(hass, entity, state, context=None, **attrs):
    return lambda: hass.states.async_set(entity, state, attrs, context=context)


async def test_a_zone_page_through_the_real_logbook(room, hass, hass_ws_client, freezer) -> None:
    pat = await hass.auth.async_create_user("Pat")
    # Past the window where a change with no cause is put down to Home Assistant starting.
    clock = Clock(hass, freezer, dt_util.utcnow().replace(microsecond=0) + timedelta(minutes=10))
    for entity, state in ((HEATER, "off"), (FAN, "off"), (ALERT, "on"), (OTHER, "on")):
        await clock.step(_set(hass, entity, state))
    await clock.step(_set(hass, "sensor.left_temp", "20", unit_of_measurement="°C", state_class="measurement"))

    house = Context()
    await clock.step(_run(hass, "automation.house_lights", "time", house, name="House lights"))
    await clock.step(_set(hass, HEATER, "on", house))
    alert = Context()
    await clock.step(_run(hass, ALERT, "state of sensor.left_temp", alert))
    await clock.step(_set(hass, HEATER, "off", alert))
    for _ in range(2):
        await clock.step(_run(hass, ALERT, "state of sensor.left_temp"))
        await clock.step(_set(hass, "sensor.left_temp", "21", unit_of_measurement="°C", state_class="measurement"))
        await clock.step(_set(hass, FAN, "on"))
        await clock.step(_run(hass, OTHER, "time pattern", name="Veg alert"))
    await clock.step(_set(hass, HEATER, "on", Context(user_id=pat.id)))
    await clock.step(_set(hass, HEATER, "unavailable"))
    await clock.step(_set(hass, HEATER, "on"))
    await clock.step(_set(hass, ALERT, "off", Context(user_id=pat.id)))
    await async_wait_recording_done(hass)

    r = await _activity(await hass_ws_client(hass), **_day())
    assert r["success"], r
    result = r["result"]
    assert result["zone"] == "garden" and result["more"] is False
    assert result["earliest"] == pytest.approx(clock.now.timestamp() - 168 * 3600, abs=2)
    entries = result["entries"]
    for e in entries:
        e.pop("when")
        e.pop("name")
    t = clock.now.timestamp()
    assert entries == [
        {"kind": "automation", "entity": ALERT, "state": "off", "cause": {"type": "person", "name": "Pat"}},
        {"kind": "device", "entity": HEATER, "state": "on", "cause": {"type": "reconnect"}},
        {"kind": "device", "entity": HEATER, "state": "unavailable", "cause": {"type": "none"}},
        {"kind": "device", "entity": HEATER, "state": "on", "cause": {"type": "person", "name": "Pat"}},
        # Three runs on one trigger, with other zones' and the sensor's entries in between, are one row.
        {
            "kind": "run",
            "entity": ALERT,
            "trigger": "state of sensor.left_temp",
            "count": 3,
            "first": t - 13,
            "last": t - 7,
        },
        {
            "kind": "device",
            "entity": HEATER,
            "state": "off",
            "cause": {
                "type": "automation",
                "name": "Garden heat alert",
                "trigger": "state of sensor.left_temp",
                "entity": ALERT,
            },
        },
        # An automation the zone doesn't link is named, with its trigger, but its id isn't sent.
        {
            "kind": "device",
            "entity": HEATER,
            "state": "on",
            "cause": {"type": "automation", "name": "House lights", "trigger": "time"},
        },
    ]
    assert all(e["entity"] not in (FAN, OTHER, "sensor.left_temp") for e in entries)
    assert pat.id not in str(result)


def test_the_zone_asks_only_for_its_devices_and_linked_automations_never_its_sensors() -> None:
    assert activity.zone_entities(ROOM, "garden") == ([HEATER], {ALERT})
    assert activity.zone_entities(ROOM, "kitchen") is None


def test_a_streak_is_broken_by_another_trigger_or_another_entry_of_its_automation_only() -> None:
    def run(when, source="time", entity=ALERT):
        return {"when": when, "entity_id": entity, "domain": "automation", "name": "A", "source": source}

    rows = [
        run(1),
        run(2),
        {"when": 3, "entity_id": HEATER, "state": "on", "name": "Heater"},
        run(4),
        run(5, source="state"),
        run(6),
        {"when": 7, "entity_id": ALERT, "state": "off", "name": "A"},
        run(8),
        run(9, entity=OTHER),
    ]
    entries, more = activity.shape(rows, {HEATER}, {ALERT}, {}, [])
    runs = [(e["count"], e["first"], e["last"], e["trigger"]) for e in entries if e["kind"] == "run"]
    assert runs == [(1, 8, 8, "time"), (1, 6, 6, "time"), (1, 5, 5, "state"), (3, 1, 4, "time")]
    assert [e["kind"] for e in entries] == ["run", "automation", "run", "run", "run", "device"]
    assert more is False


async def test_a_change_with_no_cause_just_after_home_assistant_starts_is_put_down_to_the_start(
    room, hass, hass_ws_client
) -> None:
    hass.states.async_set(HEATER, "off")
    await hass.async_block_till_done()
    hass.states.async_set(HEATER, "on")
    await async_wait_recording_done(hass)
    r = await _activity(room, **_day())
    assert r["success"], r
    assert [e["cause"] for e in r["result"]["entries"]] == [{"type": "startup"}]


async def test_the_cap_keeps_the_newest_rows_and_says_more_exist(room, hass, freezer, monkeypatch) -> None:
    monkeypatch.setattr(activity, "MAX_ENTRIES", 2)
    clock = Clock(hass, freezer, dt_util.utcnow().replace(microsecond=0) + timedelta(minutes=10))
    for state in ("off", "on", "off", "on"):
        await clock.step(_set(hass, HEATER, state))
    await async_wait_recording_done(hass)
    r = await _activity(room, **_day())
    assert r["success"], r
    assert r["result"]["more"] is True
    assert [(e["state"], e["when"]) for e in r["result"]["entries"]] == [
        ("on", clock.now.timestamp()),
        ("off", clock.now.timestamp() - 1),
    ]


@pytest.mark.parametrize(
    ("msg", "code"),
    [
        (_day(zone="kitchen"), "not_found"),
        (_day(zone=HEATER), "not_found"),
        (_day(entities=[HEATER]), "invalid_format"),
        (_day(entity_id=HEATER), "invalid_format"),
        ({"zone": "garden", "start": 0, "end": 25 * 3600 + 1}, "invalid_format"),
        ({"zone": "garden", "start": time.time() - 26 * 3600, "end": time.time()}, "invalid_format"),
        ({"zone": "garden", "start": 100, "end": 100}, "invalid_format"),
        ({"zone": "garden", "start": 1e30, "end": 1e30 + 1}, "invalid_format"),
    ],
)
async def test_only_a_zone_of_the_setup_over_one_page_is_served(room, msg, code) -> None:
    r = await _activity(room, **msg)
    assert not r["success"]
    assert r["error"]["code"] == code


async def test_a_page_older_than_the_shared_lookback_is_refused(room) -> None:
    start = dt_util.utcnow().timestamp() - 168 * 3600 - 60
    r = await _activity(room, zone="garden", start=start, end=start + 3600)
    assert r["error"]["code"] == "invalid_format"
    # The same limit is History's longest range.
    await room.send_json_auto_id(
        {"type": f"{DOMAIN}/history", "entities": ["sensor.left_temp"], "hours": 168, "buckets": 300}
    )
    assert (await room.receive_json())["success"]


async def test_activity_is_for_admins_only(room, hass, hass_ws_client, hass_read_only_access_token) -> None:
    client = await hass_ws_client(hass, hass_read_only_access_token)
    r = await _activity(client, **_day())
    assert r["error"]["code"] == "unauthorized"


async def test_without_the_logbook_activity_says_so(hass, hass_ws_client) -> None:
    client = await _setup(hass, hass_ws_client, logbook=False)
    r = await _activity(client, **_day())
    assert r["error"]["code"] == "no_logbook"


async def test_a_slow_logbook_gives_a_clear_error(room, monkeypatch) -> None:
    def slow(*_args):
        time.sleep(0.5)
        return [], []

    monkeypatch.setattr(activity, "QUERY_TIMEOUT_S", 0.05)
    monkeypatch.setattr(activity, "_read", slow)
    r = await _activity(room, **_day())
    assert r["error"] == {"code": "timeout", "message": "Home Assistant's logbook took too long to answer. Try again."}
