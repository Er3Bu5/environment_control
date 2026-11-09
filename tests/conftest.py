"""Shared fixtures."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Let HA load the integration from custom_components."""
    return


@pytest.fixture
def sample_config():
    """The mock's faked test data, so the backend is checked against the setup the UI really produces."""
    node = shutil.which("node")
    assert node, "node is needed to read the mock's sample room"
    script = (
        "const fs=require('fs'),vm=require('vm'),ctx={};vm.createContext(ctx);"
        "vm.runInContext(fs.readFileSync(process.argv[1],'utf8')+';this.SEED=SEED;',ctx);"
        "process.stdout.write(JSON.stringify(ctx.SEED.config));"
    )
    out = subprocess.run(  # noqa: S603 - fixed arguments, no user input
        [node, "-e", script, str(ROOT / "design" / "sample-seed.js")], capture_output=True, check=True, text=True
    )
    return json.loads(out.stdout)
