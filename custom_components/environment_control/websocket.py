"""The panel's two backend commands, for admins only: read the setup, and save it."""

from __future__ import annotations

from typing import Any

import probatio
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .store import ConfigStore, RevisionConflict
from .validation import InvalidConfig

CONFLICT = "Setup was saved from somewhere else since this was opened. Reopen the panel to see it."


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    """Register both commands."""
    websocket_api.async_register_command(hass, ws_config)
    websocket_api.async_register_command(hass, ws_config_save)


def _store(hass: HomeAssistant) -> ConfigStore | None:
    entries = hass.config_entries.async_loaded_entries(DOMAIN)
    return entries[0].runtime_data if entries else None


@websocket_api.require_admin
@websocket_api.websocket_command({probatio.Required("type"): f"{DOMAIN}/config"})
@callback
def ws_config(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Return the stored setup."""
    store = _store(hass)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Environment Control isn't set up.")
        return
    connection.send_result(msg["id"], store.data)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        probatio.Required("type"): f"{DOMAIN}/config/save",
        probatio.Required("revision"): int,
        probatio.Required("config"): dict,
    }
)
@websocket_api.async_response
async def ws_config_save(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """Store a new setup, if it's valid and based on the current revision."""
    store = _store(hass)
    if store is None:
        connection.send_error(msg["id"], "not_loaded", "Environment Control isn't set up.")
        return
    try:
        saved = await store.async_save(msg["revision"], msg["config"])
    except RevisionConflict:
        connection.send_error(msg["id"], "revision_conflict", CONFLICT)
    except InvalidConfig as err:
        connection.send_error(msg["id"], "invalid_config", str(err))
    else:
        connection.send_result(msg["id"], saved)
