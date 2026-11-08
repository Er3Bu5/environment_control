"""Environment Control: a sidebar panel for grow-room climate and lights.

This backend registers the panel and keeps the panel's own setup in HA's storage. It never calls a service and
never sets a state: everything that moves hardware goes through the panel's host element, in the browser, with
the user's own login.
"""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import DOMAIN, PANEL_ELEMENT, PANEL_ICON, PANEL_TITLE, PANEL_URL_PATH, STATIC_URL
from .store import ConfigStore
from .websocket import async_register_commands

FRONTEND_DIR = Path(__file__).parent / "frontend"

type EnvironmentControlConfigEntry = ConfigEntry[ConfigStore]


async def async_setup_entry(hass: HomeAssistant, entry: EnvironmentControlConfigEntry) -> bool:
    """Load the stored setup, then register the panel and its commands."""
    store = ConfigStore(hass)
    await store.async_load()
    entry.runtime_data = store

    # Static paths and websocket commands can't be unregistered, so they are added once per HA run.
    registered = hass.data.setdefault(DOMAIN, {})
    if not registered.get("static"):
        await hass.http.async_register_static_paths([StaticPathConfig(STATIC_URL, str(FRONTEND_DIR), True)])
        registered["static"] = True
    if not registered.get("commands"):
        async_register_commands(hass)
        registered["commands"] = True

    # The version in the URL makes the browser fetch the new host after an update instead of a cached one.
    version = (await async_get_integration(hass, DOMAIN)).version
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL}/host.js?v={version}",
        embed_iframe=False,
        require_admin=True,
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: EnvironmentControlConfigEntry) -> bool:
    """Take the panel out of the sidebar. Storage stays, so adding the integration again finds the setup."""
    frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    return True
