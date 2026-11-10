"""The panel's backend commands: admin only, revision-checked, validated, and stored."""

import copy

import pytest
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.environment_control.const import DOMAIN


@pytest.fixture
async def loaded(hass: HomeAssistant) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, title="Environment Control")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def _send(client, **msg):
    await client.send_json_auto_id(msg)
    return await client.receive_json()


async def test_a_first_install_has_no_zones(hass, loaded, hass_ws_client) -> None:
    client = await hass_ws_client(hass)
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["success"] and r["result"] == {"revision": 0, "zones": [], "devices": []}


async def test_a_save_is_stored_and_moves_the_revision_on(
    hass, loaded, hass_ws_client, hass_storage, sample_unlinked
) -> None:
    sample_config = sample_unlinked
    client = await hass_ws_client(hass)
    cfg = {"zones": sample_config["zones"], "devices": sample_config["devices"]}
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=0, config=cfg)
    assert r["success"], r
    assert r["result"]["revision"] == 1
    await hass.async_block_till_done()
    assert hass_storage[DOMAIN]["data"]["revision"] == 1
    assert [z["id"] for z in hass_storage[DOMAIN]["data"]["zones"]] == [z["id"] for z in sample_config["zones"]]
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["result"]["revision"] == 1


async def test_a_save_survives_reloading_the_integration(hass, loaded, hass_ws_client, sample_unlinked) -> None:
    sample_config = sample_unlinked
    client = await hass_ws_client(hass)
    cfg = {"zones": sample_config["zones"], "devices": sample_config["devices"]}
    assert (await _send(client, type=f"{DOMAIN}/config/save", revision=0, config=cfg))["success"]
    assert await hass.config_entries.async_reload(loaded.entry_id)
    await hass.async_block_till_done()
    r = await _send(client, type=f"{DOMAIN}/config")
    assert r["result"]["revision"] == 1 and len(r["result"]["zones"]) == len(sample_config["zones"])


async def test_a_save_from_a_stale_copy_is_refused(hass, loaded, hass_ws_client, hass_storage) -> None:
    client = await hass_ws_client(hass)
    assert (await _send(client, type=f"{DOMAIN}/config/save", revision=0, config={"zones": [], "devices": []}))[
        "success"
    ]
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=0, config={"zones": [{"id": "late"}], "devices": []})
    assert not r["success"] and r["error"]["code"] == "revision_conflict"
    await hass.async_block_till_done()
    assert hass_storage[DOMAIN]["data"]["zones"] == []


async def test_an_invalid_setup_is_refused_and_nothing_is_stored(
    hass, loaded, hass_ws_client, hass_storage, sample_config
) -> None:
    client = await hass_ws_client(hass)
    bad = copy.deepcopy({"zones": sample_config["zones"], "devices": sample_config["devices"]})
    bad["devices"].append({"id": "lock", "zones": [bad["zones"][0]["id"]], "entity": "lock.front_door"})
    r = await _send(client, type=f"{DOMAIN}/config/save", revision=0, config=bad)
    assert not r["success"] and r["error"]["code"] == "invalid_config"
    assert "can't control" in r["error"]["message"]
    await hass.async_block_till_done()
    assert DOMAIN not in hass_storage


async def test_a_malformed_message_is_refused(hass, loaded, hass_ws_client) -> None:
    client = await hass_ws_client(hass)
    r = await _send(client, type=f"{DOMAIN}/config/save", revision="1", config={})
    assert not r["success"] and r["error"]["code"] == "invalid_format"


async def test_both_commands_are_for_admins_only(hass, loaded, hass_ws_client, hass_read_only_access_token) -> None:
    client = await hass_ws_client(hass, hass_read_only_access_token)
    for msg in (
        {"type": f"{DOMAIN}/config"},
        {"type": f"{DOMAIN}/config/save", "revision": 0, "config": {"zones": [], "devices": []}},
    ):
        r = await _send(client, **msg)
        assert not r["success"] and r["error"]["code"] == "unauthorized"


async def test_commands_say_so_when_the_integration_is_not_loaded(hass, loaded, hass_ws_client) -> None:
    assert await hass.config_entries.async_unload(loaded.entry_id)
    client = await hass_ws_client(hass)
    r = await _send(client, type=f"{DOMAIN}/config")
    assert not r["success"] and r["error"]["code"] == "not_loaded"
