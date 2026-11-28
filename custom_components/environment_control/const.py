"""Constants for Environment Control."""

DOMAIN = "environment_control"
PANEL_URL_PATH = "environment-control"
PANEL_ELEMENT = "environment-control-panel"
PANEL_TITLE = "Environment Control"
PANEL_ICON = "mdi:sprout"
STATIC_URL = f"/{DOMAIN}_static"

STORAGE_KEY = DOMAIN
STORAGE_VERSION = 1

# The host refuses anything larger before it reaches here; this is the backend's own limit.
MAX_CONFIG_BYTES = 512 * 1024
MAX_ZONES = 20
MAX_DEVICES = 200

# The catalog Setup picks from. A home has tens of devices and around a thousand entities; the caps keep a huge
# install's answer to a size a phone can take.
MAX_CATALOG_DEVICES = 1000
MAX_CATALOG_ENTITIES = 5000
# Automations a zone can link to switch on and off. A home that automates a lot has a few hundred.
MAX_CATALOG_AUTOMATIONS = 2000

# How far back the panel reads Home Assistant's records: History's longest range, and the oldest page of Activity.
# HA's recorder keeps 10 days by default; one value for both, so they move together when it changes.
MAX_LOOKBACK_HOURS = 168
