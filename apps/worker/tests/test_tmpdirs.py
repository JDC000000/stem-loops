"""Scratch dirs (user audio on local disk) must be removed when the job ends."""

import asyncio
import os
import time

import pytest

from worker import tmpdirs


@pytest.fixture(autouse=True)
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(tmpdirs, "WORK_ROOT", str(tmp_path / "work"))
    return tmp_path / "work"


def _touch(d):
    with open(os.path.join(d, "audio.wav"), "wb") as f:
        f.write(b"x")


def test_scope_removes_dirs_on_success_and_on_exception():
    with tmpdirs.job_scope():
        d1 = tmpdirs.mkdtemp("a_")
        _touch(d1)
    assert not os.path.exists(d1)
    with pytest.raises(RuntimeError), tmpdirs.job_scope():
        d2 = tmpdirs.mkdtemp("b_")
        _touch(d2)
        raise RuntimeError("boom")
    assert not os.path.exists(d2)


def test_scope_follows_asyncio_to_thread():
    made = []

    async def scenario():
        with tmpdirs.job_scope():
            made.append(await asyncio.to_thread(tmpdirs.mkdtemp, "t_"))
            assert os.path.isdir(made[0])

    asyncio.run(scenario())
    assert not os.path.exists(made[0])


def test_sweep_stale_only_removes_old(root):
    old = tmpdirs.mkdtemp("old_")
    new = tmpdirs.mkdtemp("new_")
    t = time.time() - 90000
    os.utime(old, (t, t))
    assert tmpdirs.sweep_stale(86400) == 1
    assert not os.path.exists(old) and os.path.exists(new)
