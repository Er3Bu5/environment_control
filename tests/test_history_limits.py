"""The history command's `limits`, against HA's own recorder: limits and day and night as they were over the range."""

import copy
from datetime import timedelta

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.components.recorder.common import async_wait_recording_done

from custom_components.environment_control.const import DOMAIN
from custom_components.environment_control.limits import clock_periods, merge


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(recorder_mock, enable_custom_integrations):
    """The recorder has to start before HA does, so it comes ahead of the shared fixture here."""
    return


H = timedelta(hours=1)
ZONE = {
    "id": "garden",
    "name": "Garden",
    "sensors": [{"id": "s1", "name": "Left", "kind": "env", "entities": {"temperature": "sensor.left_temp"}}],
    "bands": {
        "day": {"temperature": [20, 22, 24, 26, 28], "humidity": [50, 55, 60, 65, 70], "vpd": [1, 1, 1, 1, 1]},
        "night": {"temperature": [16, 18, 20, 22, 24], "humidity": [50, 55, 60, 65, 70], "vpd": [1, 1, 1, 1, 1]},
    },
    "helpers": {"bands": {"day": {"temperature": {"max": "input_number.day_max"}}}},
    "periodMode": "fixed",
    "dayAt": 360,
    "nightAt": 1080,
}


def _room(**over):
    return {"zones": [{**copy.deepcopy(ZONE), **over}], "devices": []}


async def _start(hass):
    """The store, set up at whatever time the test has frozen. A panel login can't be made in the past, so saves
    made earlier go straight to the store, and the panel connects once the clock is back at now."""
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry.runtime_data


async def _save(store, revision, config):
    # A copy, as a save over the websocket would be: the store keeps what it's given.
    await store.async_save(revision, copy.deepcopy(config))


async def _history(client, **msg):
    msg = {"entities": ["sensor.left_temp"], "hours": 24, "buckets": 24, **msg}
    await client.send_json_auto_id({"type": f"{DOMAIN}/history", **msg})
    return await client.receive_json()


async def _set(hass, freezer, at, entity, state):
    freezer.move_to(at)
    hass.states.async_set(entity, state)
    await hass.async_block_till_done()


@pytest.fixture
def now():
    return dt_util.utcnow().replace(microsecond=0)


async def test_a_helper_max_changed_twice_steps_twice_and_carries_through_unavailable(
    hass: HomeAssistant, hass_ws_client, freezer, now
) -> None:
    freezer.move_to(now - 30 * H)
    store = await _start(hass)
    await _save(store, 0, _room())
    await _set(hass, freezer, now - 26 * H, "input_number.day_max", "28")
    await _set(hass, freezer, now - 10 * H, "input_number.day_max", "29")
    await _set(hass, freezer, now - 8 * H, "input_number.day_max", "unavailable")
    await _set(hass, freezer, now - 6 * H, "input_number.day_max", "29")
    await _set(hass, freezer, now - 2 * H, "input_number.day_max", "30")
    freezer.move_to(now)
    await async_wait_recording_done(hass)
    client = await hass_ws_client(hass)

    r = await _history(client, zone="garden", metric="temperature")
    assert r["success"], r
    limits, start = r["result"]["limits"], r["result"]["start"]
    day_max = limits["day"]["max"]
    assert [v for _, v in day_max] == [28.0, 29.0, 30.0]
    assert [t for t, _ in day_max] == pytest.approx(
        [start, (now - 10 * H).timestamp(), (now - 2 * H).timestamp()], abs=1
    )
    assert limits["day"]["high"] == [[start, 26]] and limits["night"]["target"] == [[start, 20]]
    assert limits["known_from"] is None


async def test_two_saves_step_a_stored_limit_and_a_switch_to_a_helper_is_stitched(
    hass: HomeAssistant, hass_ws_client, freezer, now
) -> None:
    # The zone is made 6 hours ago, so a 24 hour range knows its stored values only from then.
    freezer.move_to(now - 6 * H)
    store = await _start(hass)
    await _save(store, 0, _room())
    await _set(hass, freezer, now - 5 * H, "input_number.day_min", "19")
    freezer.move_to(now - 3 * H)
    room = _room()
    room["zones"][0]["bands"]["day"]["temperature"] = [20, 22, 24, 27, 28]
    room["zones"][0]["helpers"]["bands"]["day"]["temperature"]["min"] = "input_number.day_min"
    await _save(store, 1, room)
    await _set(hass, freezer, now - 2 * H, "input_number.day_min", "21")
    freezer.move_to(now - H)
    room["zones"][0]["bands"]["day"]["temperature"] = [20, 22, 24, 25, 28]
    await _save(store, 2, room)
    freezer.move_to(now)
    await async_wait_recording_done(hass)
    client = await hass_ws_client(hass)

    r = await _history(client, zone="garden", metric="temperature")
    assert r["success"], r
    limits, start = r["result"]["limits"], r["result"]["start"]
    t = [(now - k * H).timestamp() for k in (3, 2, 1)]
    assert limits["day"]["high"] == [[start, 26], [t[0], 27], [t[2], 25]]
    assert limits["day"]["min"] == [[start, 20], [t[0], 19.0], [pytest.approx(t[1], abs=1), 21.0]]
    assert limits["known_from"] == (now - 6 * H).timestamp()


async def test_a_setup_saved_before_the_log_holds_its_current_values_for_the_whole_range(
    hass: HomeAssistant, hass_ws_client, hass_storage, freezer, now
) -> None:
    freezer.move_to(now)
    hass_storage[DOMAIN] = {"version": 1, "minor_version": 1, "key": DOMAIN, "data": {**_room(), "revision": 4}}
    await _start(hass)
    client = await hass_ws_client(hass)
    r = await _history(client, zone="garden", metric="temperature")
    assert r["success"], r
    limits = r["result"]["limits"]
    assert limits["night"]["max"] == [[r["result"]["start"], 24]]
    # Known only from when this code started, which is the range's end: every stored value is assumed throughout.
    assert limits["known_from"] == r["result"]["end"]


async def test_the_period_follows_its_time_helpers_as_they_were(
    hass: HomeAssistant, hass_ws_client, freezer, now
) -> None:
    await hass.config.async_set_time_zone("UTC")
    freezer.move_to(now - 30 * H)
    store = await _start(hass)
    room = _room(periodMode="helper")
    room["zones"][0]["helpers"].update(day="input_datetime.on", night="input_datetime.off")
    await _save(store, 0, room)
    await _set(hass, freezer, now - 29 * H, "input_datetime.on", "06:00:00")
    await _set(hass, freezer, now - 29 * H, "input_datetime.off", "18:00:00")
    await _set(hass, freezer, now - 12 * H, "input_datetime.off", "20:00:00")
    freezer.move_to(now)
    await async_wait_recording_done(hass)
    client = await hass_ws_client(hass)

    r = await _history(client, zone="garden", metric="humidity")
    assert r["success"], r
    start, end = r["result"]["start"], r["result"]["end"]
    changed = (now - 12 * H).timestamp()
    want = merge(clock_periods([(start, 360, 1080), (changed, 360, 1200)], start, end, dt_util.UTC))
    period = r["result"]["limits"]["period"]
    assert [p for _, p in period] == [p for _, p in want]
    assert [t for t, _ in period] == pytest.approx([t for t, _ in want], abs=1)


async def test_the_readings_are_what_they_were_without_limits(
    hass: HomeAssistant, hass_ws_client, freezer, now
) -> None:
    freezer.move_to(now - 2 * H)
    store = await _start(hass)
    await _save(store, 0, _room())
    for i in range(30):
        await _set(hass, freezer, now - 2 * H + i * timedelta(minutes=3), "sensor.left_temp", str(20 + i % 3))
    freezer.move_to(now)
    await async_wait_recording_done(hass)
    client = await hass_ws_client(hass)
    plain = await _history(client, hours=4, buckets=12)
    with_limits = await _history(client, hours=4, buckets=12, zone="garden", metric="vpd")
    assert plain["success"] and with_limits["success"]
    assert "limits" not in plain["result"]
    rest = {k: v for k, v in with_limits["result"].items() if k != "limits"}
    assert rest == plain["result"]


@pytest.mark.parametrize(
    ("msg", "code"),
    [
        ({"zone": "kitchen", "metric": "temperature"}, "not_found"),
        ({"zone": "garden", "metric": "pressure"}, "invalid_format"),
        ({"zone": "garden"}, "invalid_format"),
        ({"zone": "garden", "metric": "temperature", "entities": ["sensor.kitchen_temp"]}, "unauthorized"),
    ],
)
async def test_limits_are_only_for_a_zone_in_the_setup(hass: HomeAssistant, hass_ws_client, msg, code) -> None:
    await _save(await _start(hass), 0, _room())
    r = await _history(await hass_ws_client(hass), **msg)
    assert not r["success"]
    assert r["error"]["code"] == code


async def test_limits_are_for_admins_only(hass: HomeAssistant, hass_ws_client, hass_read_only_access_token) -> None:
    await _save(await _start(hass), 0, _room())
    client = await hass_ws_client(hass, hass_read_only_access_token)
    r = await _history(client, zone="garden", metric="temperature")
    assert not r["success"]
    assert r["error"]["code"] == "unauthorized"
