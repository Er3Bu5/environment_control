# Design mock

The clickable design mock for milestone 1, its browser tests, and the builder that swaps the mock's
sample data for a snapshot of a real room. The sample data and tests double as fixtures for the panel.

The real-room snapshot (`ha-snap/*.json`) and the mock built from it hold actual readings, so they are
ignored and never committed. Run every command below from this folder.

## Files

The mock runs the way the panel will run in Home Assistant. The page plays HA, the panel's host element sits on it, and
the UI runs in the host's sandboxed frame with the same no-network CSP the real panel ships with.

| File | What it is |
|---|---|
| `environment-control-source.html` | The UI, which runs in the sandboxed frame. This is what gets edited |
| `host.js` | The panel element HA mounts: holds `hass`, forwards mapped states to the frame, runs the v1 write table |
| `fake-ha.js` | Stands in for HA: entities, services, the panel's backend commands, report delays, dropped commands, failsafes |
| `sample-seed.js` | The made-up room the fake HA starts with: stored config, entity states, failsafes |
| `dev-shell.html` | The page that plays HA, with a sidebar wired like HA's and the Test controls drawer outside the sandbox |
| `build-mock.py` | Assembles one page from the above, inlining Roboto (`../frontend/fonts/`, OFL) since the frame can't fetch it |
| `vpd-browser-test.mjs` | Browser tests, run in real Chromium against the assembled page |
| `build-snapshot.py` | Builds the UI and a seed from a real-room snapshot, then `environment-control-mock.html` |
| `ha-snap/*.py` | Read-only fetches from Home Assistant into `ha-snap/*.json` (not committed) |

## Workflow

Each change is one commit, made only once both suites pass. The tests assemble the page themselves.

```sh
# Sample-data suite
node vpd-browser-test.mjs "$PWD"

# Real-data suite, after building
python3 build-snapshot.py "$PWD"
MOCK_FILE=snapshot-ui.html SEED_FILE=snapshot-seed.js SMOKE=1 node vpd-browser-test.mjs "$PWD"

# The sample mock as one page, for viewing
python3 build-mock.py "$PWD" environment-control-source.html sample-seed.js mock-dev.html
```

A test run that died can leave Chromium behind: `pkill -f '[r]emote-debugging-port=9347'`.

Refreshing the snapshot needs `HA_URL` and `HA_TOKEN` in the environment:

```sh
source ~/.env.local
python3 ha-snap/states.py ha-snap/states.json
python3 ha-snap/history.py ha-snap/history.json
python3 ha-snap/history-long.py ha-snap/history-long.json
```

The built mock is published as a private Artifact. Screenshots and the built mock are output and are
ignored.
