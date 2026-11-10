"""V3-J2 key-mirror pin (worker side).

The web app reads the stem objects this module's key builders write. The two sides
are in different languages in different packages, so only a test stops them
drifting — and a drifted key 404s, which is indistinguishable from "this job has no
stems", so the failure is silent. The TypeScript side is pinned to the same literals
in apps/web/src/lib/stems.test.mjs. Changing the layout fails both suites.
"""

import pytest

from worker.storage.r2_uploader import stem_download_r2_key, stem_play_r2_key

JOB = "550e8400-e29b-41d4-a716-446655440000"
SIX = ("vocals", "drums", "bass", "other", "guitar", "keys")


def test_playback_key_matches_the_web_literal_exactly():
    assert stem_play_r2_key(JOB, "drums") == f"{JOB}/_stems/play/drums.opus"
    assert stem_play_r2_key(JOB, "keys") == f"{JOB}/_stems/play/keys.opus"


def test_download_key_matches_the_web_literal_exactly():
    assert stem_download_r2_key(JOB, "bass") == f"{JOB}/_stems/dl/bass.wav"


def test_playback_is_opus_and_download_is_wav():
    """TSD 12.2: Opus for playback, WAV for the DAW hand-off.

    Serving WAV to the mixer is 240-360 MB per song against a measured 287 MB
    engine budget. That inversion is the specific defect this pairing prevents.
    """
    assert stem_play_r2_key(JOB, "vocals").endswith(".opus")
    assert stem_download_r2_key(JOB, "vocals").endswith(".wav")


def test_the_two_artifacts_live_in_different_sub_prefixes():
    """Side by side, vocals.opus and vocals.wav parse to the same stem name."""
    play = stem_play_r2_key(JOB, "other")
    dl = stem_download_r2_key(JOB, "other")
    assert play.rsplit("/", 1)[0] != dl.rsplit("/", 1)[0]


def test_both_keys_sit_under_the_job_prefix_so_retention_covers_them():
    """The property that matters, not an aesthetic choice.

    cleanup.py deletes a job's objects with ``delete_prefix(f"{job_id}/")`` and
    ``_job_id_of()`` reads the FIRST path segment. ``upload_play_chords`` writes
    ``jobs/<id>/play.chords.json``, whose first segment is the literal "jobs", so
    the per-job delete misses it entirely. Stems are ~50 MB each, six per job.
    """
    for stem in SIX:
        for key in (stem_play_r2_key(JOB, stem), stem_download_r2_key(JOB, stem)):
            assert key.split("/", 1)[0] == JOB, f"{key}: first segment must be the job id"
            assert not key.startswith("jobs/"), f"{key}: must not use the jobs/ prefix"


def test_stem_keys_never_collide_with_loop_keys():
    """Loops are ``{job_id}/{stem}/{section}_{idx}.wav``; ``_stems`` is disjoint."""
    for stem in SIX:
        assert stem_play_r2_key(JOB, stem).split("/")[1] == "_stems"


def test_keys_are_deterministic_so_a_reaper_requeue_overwrites_in_place():
    assert stem_play_r2_key(JOB, "bass") == stem_play_r2_key(JOB, "bass")
    assert stem_download_r2_key(JOB, "bass") == stem_download_r2_key(JOB, "bass")


def test_upload_stem_rejects_an_unknown_artifact_kind():
    from worker.storage.r2_uploader import upload_stem

    with pytest.raises(ValueError, match="unknown stem artifact kind"):
        upload_stem(JOB, "bass", "/nonexistent.wav", "sideways")


def test_upload_stem_sets_the_right_content_type_per_kind(monkeypatch):
    """Kills the mutation that serves Opus as audio/wav (or vice versa).

    The browser and R2 both go by Content-Type: a mislabelled playback object can be
    refused by the decoder or mishandled by a CDN, and a mislabelled download lands
    in a DAW with the wrong extension handling.
    """
    from worker.storage import r2_uploader

    seen: list[tuple[str, dict]] = []

    class FakeR2:
        def upload_file(self, local, bucket, key, ExtraArgs=None):  # noqa: N803
            seen.append((key, ExtraArgs or {}))

    monkeypatch.setattr(r2_uploader, "_r2", lambda: FakeR2())
    monkeypatch.setenv("R2_BUCKET_NAME", "b")

    r2_uploader.upload_stem(JOB, "bass", "/tmp/x.opus", "play")
    r2_uploader.upload_stem(JOB, "bass", "/tmp/x.wav", "download")

    kinds = dict((k, a.get("ContentType")) for k, a in seen)
    assert kinds[f"{JOB}/_stems/play/bass.opus"] == "audio/ogg"
    assert kinds[f"{JOB}/_stems/dl/bass.wav"] == "audio/wav"
