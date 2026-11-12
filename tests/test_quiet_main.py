"""The Beta workflow's wait for a burst of merges to end, so the burst makes one beta."""

import importlib.util
import subprocess
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("quiet_main", Path(__file__).parents[1] / "scripts" / "quiet_main.py")
assert _spec and _spec.loader
quiet_main = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(quiet_main)

A, B = "a" * 40, "b" * 40


@pytest.mark.parametrize(
    ("head", "age", "expected"),
    [
        # Still the newest merge, and main has been quiet long enough.
        (A, 300, "go"),
        (A, 4000, "go"),
        # Still the newest, but another merge may be about to follow.
        (A, 0, "wait"),
        (A, 299, "wait"),
        # Overtaken: the newer merge's beta holds this one, however long it has been.
        (B, 0, "skip"),
        (B, 4000, "skip"),
    ],
)
def test_a_merge_makes_a_beta_only_once_main_has_been_quiet_with_it_still_newest(head, age, expected) -> None:
    assert quiet_main.decide(A, head, merged_at=1000.0, now=1000.0 + age) == expected


def _git(repo: Path, *args: str) -> str:
    cmd = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=nobody", "-c", "commit.gpgsign=false", *args]
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip()  # noqa: S603


def _merge(repo: Path, text: str) -> str:
    (repo / "file").write_text(text)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", text)
    return _git(repo, "rev-parse", "HEAD")


@pytest.fixture
def clone(tmp_path, monkeypatch):
    """A checkout of main as the workflow has it, and the repository it came from, where newer merges land."""
    origin, work = tmp_path / "origin", tmp_path / "work"
    origin.mkdir()
    _git(origin, "init", "-q", "-b", "main")
    first = _merge(origin, "one")
    subprocess.run(["git", "clone", "-q", str(origin), str(work)], check=True)  # noqa: S603, S607
    monkeypatch.chdir(work)
    monkeypatch.setattr(quiet_main.time, "sleep", lambda s: pytest.fail(f"slept {s}s"))
    return origin, first


def test_a_merge_overtaken_on_github_gives_way_without_waiting(clone, capsys) -> None:
    origin, first = clone
    _merge(origin, "two")
    assert quiet_main.main(["quiet_main.py", first]) == 0
    assert capsys.readouterr().out == "newest=false\n"


def test_the_newest_merge_goes_ahead_once_its_quiet_time_has_passed(clone, capsys, monkeypatch) -> None:
    _, first = clone
    merged_at = float(_git(Path.cwd(), "log", "-1", "--format=%ct", first))
    monkeypatch.setattr(quiet_main.time, "time", lambda: merged_at + quiet_main.QUIET_S)
    assert quiet_main.main(["quiet_main.py", first]) == 0
    assert capsys.readouterr().out == "newest=true\n"


def test_the_newest_merge_waits_out_what_is_left_of_its_quiet_time_then_looks_again(clone, capsys, monkeypatch) -> None:
    origin, first = clone
    merged_at = float(_git(Path.cwd(), "log", "-1", "--format=%ct", first))
    clock = {"now": merged_at + quiet_main.QUIET_S - 7}
    slept: list[float] = []

    def sleep(seconds: float) -> None:
        slept.append(seconds)
        clock["now"] += seconds
        # A newer merge lands while it waits.
        _merge(origin, "two")

    monkeypatch.setattr(quiet_main.time, "time", lambda: clock["now"])
    monkeypatch.setattr(quiet_main.time, "sleep", sleep)
    assert quiet_main.main(["quiet_main.py", first]) == 0
    assert slept == [7]
    assert capsys.readouterr().out == "newest=false\n"


def test_a_short_sha_is_refused(capsys) -> None:
    assert quiet_main.main(["quiet_main.py", "abc1234"]) == 2
    assert "isn't a full commit SHA" in capsys.readouterr().err
