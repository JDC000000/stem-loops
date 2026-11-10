"""V3-J2 key-mirror pin (worker side).

The web app reads the stem objects this module's key builder writes. The two
builders are in different languages in different packages, so only a test stops
them drifting — and a drifted key 404s, which is indistinguishable from "this job
has no stems", so the failure is silent. The TypeScript side is pinned to the same
literal in apps/web/src/lib/stems.test.mjs. Changing the layout fails both.
"""

from worker.storage.r2_uploader import stem_r2_key

JOB = "550e8400-e29b-41d4-a716-446655440000"


def test_stem_key_matches_the_web_literal_exactly():
    assert stem_r2_key(JOB, "drums") == f"{JOB}/_stems/drums.wav"
    assert stem_r2_key(JOB, "keys") == f"{JOB}/_stems/keys.wav"


def test_stem_keys_sit_under_the_job_prefix_so_retention_covers_them():
    """The property that matters, not an aesthetic choice.

    cleanup.py deletes a job's objects with ``delete_prefix(f"{job_id}/")`` and
    ``_job_id_of()`` reads the FIRST path segment. ``upload_play_chords`` writes
    ``jobs/<id>/play.chords.json``, whose first segment is the literal "jobs", so
    the per-job delete misses it entirely and it survives until the budget-limited
    orphan sweep happens to catch it. A stem is 40-60 MB and there are six per job,
    so leaking stems would be materially worse than leaking a small JSON.
    """
    for stem in ("drums", "bass", "guitar", "keys", "vocals", "other"):
        key = stem_r2_key(JOB, stem)
        assert key.split("/", 1)[0] == JOB, f"{stem}: first segment must be the job id"
        assert not key.startswith("jobs/"), f"{stem}: must not use the jobs/ prefix"


def test_stem_keys_never_collide_with_loop_keys():
    """Loops are ``{job_id}/{stem}/{section}_{idx}.wav``.

    ``_stems`` is underscore-prefixed (matching ``_input.wav``) and no stem is named
    ``_stems``, so the two namespaces are disjoint.
    """
    for stem in ("drums", "bass", "guitar", "keys", "vocals", "other"):
        assert stem_r2_key(JOB, stem).split("/")[1] == "_stems"


def test_keys_are_deterministic_so_a_retry_overwrites_in_place():
    assert stem_r2_key(JOB, "bass") == stem_r2_key(JOB, "bass")
