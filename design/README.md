# Design mock

The clickable design mock for milestone 1, its browser tests, and the builder that swaps the mock's
sample data for a snapshot of a real room. The sample data and tests double as fixtures for the panel.

The real-room snapshot (`ha-snap/*.json`) and the mock built from it hold actual readings, so they are
ignored and never committed. Run every command below from this folder.

## Files

| File | What it is |
|---|---|
| `environment-control-source.html` | The mock, with made-up readings. This is what gets edited |
| `vpd-browser-test.mjs` | Browser tests, run in real Chromium inside a sandboxed frame |
| `build-snapshot.py` | Builds `environment-control-mock.html`: the source with a real-room snapshot swapped in |
| `ha-snap/*.py` | Read-only fetches from Home Assistant into `ha-snap/*.json` (not committed) |

## Workflow

Each change is one commit, made only once both suites pass.

```sh
# Sample-data suite
node vpd-browser-test.mjs "$PWD"

# Real-data suite, after building
python3 build-snapshot.py "$PWD"
MOCK_FILE=environment-control-mock.html SMOKE=1 node vpd-browser-test.mjs "$PWD"
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
