"""Behavioural tests for V3-J2 stem retention.

WHY THIS FILE EXISTS. An M-9 adversarial review ran 18 mutations against the first
version of this feature and **12 survived with every suite green**, because the only
tests covered the key-string builders. You could upload the WAV as the playback
artifact, make the encoder always fail, or change the retained stem set, and nothing
failed. These tests pin the BEHAVIOUR, and each names the mutation it kills.
"""

import json
import os
import subprocess

import pytest

from worker import pipeline

JOB = "550e8400-e29b-41d4-a716-446655440000"
SIX = ("vocals", "drums", "bass", "other", "guitar", "keys")


def _ffmpeg() -> str:
    return pipeline._ffmpeg_bin()


@pytest.fixture
def stem_wavs(tmp_path):
    """Six short, real 24-bit stereo WAVs — real files, so the encoder really runs."""
    paths = {}
    for i, name in enumerate(SIX):
        p = tmp_path / f"{name}.wav"
        subprocess.run(
            [
                _ffmpeg(),
                "-nostdin",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency={110 * (i + 1)}:duration=1:sample_rate=44100",
                "-ac",
                "2",
                "-c:a",
                "pcm_s24le",
                str(p),
            ],
            check=True,
            capture_output=True,
        )
        paths[name] = str(p)
    return paths


@pytest.fixture
def recorder(monkeypatch):
    """Capture every upload_stem call instead of talking to R2."""
    calls: list[tuple[str, str, str]] = []

    def fake_upload(job_id, stem, local_path, kind):
        calls.append((stem, local_path, kind))
        return f"{job_id}/_stems/{kind}/{stem}"

    monkeypatch.setattr(pipeline, "upload_stem", fake_upload)
    return calls


# --------------------------------------------------------------------------
# The retained set
# --------------------------------------------------------------------------


def test_all_stems_is_the_literal_six_not_a_derived_value():
    """Kills the ALL_STEMS mutation that survived.

    The rewritten test in test_chord_rebill.py asserts ``set(also) == set(ALL_STEMS)``,
    which is a TAUTOLOGY: it compares the code to itself, so renaming ``drums`` to
    ``piano`` passes. This asserts the literal names, which is the actual contract
    with htdemucs_6s and with apps/web/src/lib/stem-keys.ts.
    """
    assert set(pipeline.ALL_STEMS) == {"vocals", "drums", "bass", "other", "guitar", "keys"}
    assert len(pipeline.ALL_STEMS) == 6
    # drums and vocals are the two the old requested_stems filter could silently drop
    assert "drums" in pipeline.ALL_STEMS
    assert "vocals" in pipeline.ALL_STEMS


def test_a_stem_outside_the_closed_set_is_ignored(stem_wavs, recorder):
    """A stray key in stem_paths must not become an uploaded artifact."""
    paths = dict(stem_wavs)
    paths["harmonic_mix"] = paths["bass"]
    report = pipeline.retain_stems(JOB, paths)
    assert "harmonic_mix" not in report["play"]
    assert "harmonic_mix" not in report["download"]
    assert all(stem in SIX for stem, _, _ in recorder)


def test_a_missing_file_is_skipped_not_uploaded(recorder):
    report = pipeline.retain_stems(JOB, {"drums": "/does/not/exist.wav", "bass": None})
    assert report["play"] == []
    assert report["download"] == []
    assert recorder == []


# --------------------------------------------------------------------------
# Which artifact goes where — the original Defect 1
# --------------------------------------------------------------------------


def test_playback_gets_the_opus_and_download_gets_the_source_wav(stem_wavs, recorder):
    """Kills the mutation that uploads the WAV as the playback artifact.

    That was the original defect: serving WAV to the mixer is 240-360 MB per song
    against a measured 287 MB Variant D budget. The two artifacts are distinguished
    here by EXTENSION, not by trusting the kind label.
    """
    report = pipeline.retain_stems(JOB, stem_wavs)
    assert sorted(report["play"]) == sorted(SIX)
    assert sorted(report["download"]) == sorted(SIX)

    by_kind: dict[str, list[tuple[str, str]]] = {"play": [], "download": []}
    for stem, path, kind in recorder:
        by_kind[kind].append((stem, path))

    assert len(by_kind["play"]) == 6
    assert len(by_kind["download"]) == 6
    for stem, path in by_kind["play"]:
        assert path.endswith(".opus"), f"play artifact for {stem} must be Opus, got {path}"
        assert os.path.getsize(path) > 0
    for stem, path in by_kind["download"]:
        assert path.endswith(".wav"), f"download artifact for {stem} must be WAV, got {path}"
        assert path == stem_wavs[stem], "the download artifact IS the source wav"


def test_the_opus_is_smaller_than_the_wav_it_came_from(stem_wavs, recorder):
    """Cheap guard against the codec being swapped for something non-compressing.

    A mutation replacing ``libopus`` with ``pcm_s16le`` produces a `.opus` file
    holding WAV-size PCM, which passes an extension check and blows the memory budget.
    """
    pipeline.retain_stems(JOB, stem_wavs)
    opus = {s: p for s, p, k in recorder if k == "play"}
    for stem, path in opus.items():
        assert (
            os.path.getsize(path) < os.path.getsize(stem_wavs[stem]) / 2
        ), f"{stem}: {os.path.getsize(path)} vs wav {os.path.getsize(stem_wavs[stem])}"


def test_the_encoded_artifact_really_is_ogg_opus(stem_wavs, recorder):
    pipeline.retain_stems(JOB, {"bass": stem_wavs["bass"]})
    play = [p for _, p, k in recorder if k == "play"]
    assert len(play) == 1
    with open(play[0], "rb") as fh:
        head = fh.read(4)
    assert head == b"OggS", f"expected an Ogg container, got {head!r}"


# --------------------------------------------------------------------------
# Failure is loud — the review's BLOCKING finding
# --------------------------------------------------------------------------


def test_total_encode_failure_still_uploads_wavs_and_reports_incomplete(
    stem_wavs, recorder, monkeypatch
):
    """Kills the mutation where _encode_stem_opus always returns None.

    The reviewer's false green: with every encode failing, the job still reached
    ``done``, six WAVs uploaded, and the route returned the same shape as a job that
    predates V3-J2. ``/bin/false`` stands in for a broken ffmpeg or a build without
    libopus.
    """
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", lambda: "/bin/false")
    report = pipeline.retain_stems(JOB, stem_wavs)

    assert report["play"] == [], "nothing should be playable"
    assert sorted(report["download"]) == sorted(SIX), "the WAVs must still land"
    assert report["complete"] is False
    # the download set is what lets the route say "encoder broke" rather than "old job"
    assert len(report["download"]) > len(report["play"])


def test_encode_failure_logs_the_exit_code_and_ffmpeg_stderr(stem_wavs, monkeypatch, capsys):
    """The first version logged str(exc)[:200] — the COMMAND LINE, truncated before the
    exit status — and threw ffmpeg's stderr away, leaving a total failure undiagnosable.
    """
    monkeypatch.setattr(pipeline, "upload_stem", lambda *a, **k: "k")
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", lambda: "/bin/false")
    pipeline.retain_stems(JOB, {"drums": stem_wavs["drums"]})
    # log_structured writes JSON lines to STDERR (logger.py docstring), and
    # readouterr() DRAINS the buffer — so capture once and read both streams off
    # that single result. Calling it twice returns an empty second read.
    cap = capsys.readouterr()
    out = cap.err + cap.out

    assert "stem_opus_encode_failed" in out
    assert "returncode" in out, "the exit status must be logged, not swallowed"
    assert "stderr_tail" in out, "ffmpeg's own error text must be logged"
    assert JOB in out, "the job id must be present or the log cannot be acted on"


def test_an_incomplete_retention_reports_a_likely_cause(stem_wavs, monkeypatch, capsys):
    monkeypatch.setattr(pipeline, "upload_stem", lambda *a, **k: "k")
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", lambda: "/bin/false")
    pipeline.retain_stems(JOB, stem_wavs)
    cap = capsys.readouterr()
    out = cap.err + cap.out

    assert "stems_retained_incomplete" in out
    # six WAVs and zero Opus is an ENCODER problem, not an upload one
    assert "encoder" in out


def test_a_missing_ffmpeg_does_not_fail_the_job(stem_wavs, recorder, monkeypatch):
    """_ffmpeg_bin() used to be evaluated OUTSIDE the try, so InternalError escaped
    retain_stems and failed a job whose loops had already uploaded — the opposite of
    this function's documented posture.
    """

    def boom():
        raise pipeline.InternalError("ffmpeg unavailable: none found")

    monkeypatch.setattr(pipeline, "_ffmpeg_bin", boom)
    report = pipeline.retain_stems(JOB, stem_wavs)  # must NOT raise
    assert report["play"] == []
    assert sorted(report["download"]) == sorted(SIX)


def test_an_upload_failure_for_one_stem_does_not_lose_the_others(stem_wavs, monkeypatch):
    seen: list[tuple[str, str]] = []

    def flaky(job_id, stem, local_path, kind):
        if stem == "guitar":
            raise RuntimeError("R2 503")
        seen.append((stem, kind))
        return "k"

    monkeypatch.setattr(pipeline, "upload_stem", flaky)
    report = pipeline.retain_stems(JOB, stem_wavs)
    assert "guitar" not in report["play"]
    assert "guitar" not in report["download"]
    assert len(report["play"]) == 5
    assert report["complete"] is False


# --------------------------------------------------------------------------
# Report shape — the route's contract
# --------------------------------------------------------------------------


def test_complete_is_true_only_when_all_six_are_PLAYABLE(stem_wavs, recorder):
    report = pipeline.retain_stems(JOB, stem_wavs)
    assert report["complete"] is True
    assert set(report["expected"]) == set(pipeline.ALL_STEMS)


def test_complete_is_false_when_a_stem_is_absent(stem_wavs, recorder):
    partial = {k: v for k, v in stem_wavs.items() if k != "drums"}
    report = pipeline.retain_stems(JOB, partial)
    assert report["complete"] is False
    assert "drums" not in report["play"]
    # expected still names all six, so a consumer can see WHAT is missing
    assert "drums" in report["expected"]


# --------------------------------------------------------------------------
# Telemetry is part of the fix, so it is pinned like the fix
# --------------------------------------------------------------------------


def _capture_sentry(monkeypatch):
    """Record sentry_sdk.capture_message calls instead of sending them."""
    sent: list[tuple[str, str]] = []
    monkeypatch.setattr(
        pipeline.sentry_sdk,
        "capture_message",
        lambda msg, level=None, **k: sent.append((msg, level)),
    )
    return sent


def test_incomplete_retention_reports_to_sentry(stem_wavs, recorder, monkeypatch):
    """Kills the mutation that deletes the capture_message call.

    The whole point of the F1 fix is that a broken job is VISIBLE. A log line that
    nobody greps is not visibility, so the Sentry half is pinned, not just the log.
    """
    sent = _capture_sentry(monkeypatch)
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", lambda: "/bin/false")
    pipeline.retain_stems(JOB, stem_wavs)

    assert len(sent) == 1, "exactly one Sentry event per incomplete retention"
    msg, level = sent[0]
    assert level == "error"
    assert "0/6 playable" in msg
    assert "6/6 downloadable" in msg
    assert "likely_cause=encoder" in msg
    assert JOB in msg


def test_a_PARTIAL_retention_also_alerts(stem_wavs, monkeypatch):
    """Kills the mutation that alerts only when ZERO stems are playable.

    5 of 6 is a song with an instrument silently missing — the exact failure the
    `complete` flag exists to prevent. If only a total failure alerted, a partial
    one would go back to being silent.
    """
    sent = _capture_sentry(monkeypatch)
    real_encode = pipeline._encode_stem_opus

    def encode_all_but_guitar(src, out_dir, stem, job_id=""):
        return None if stem == "guitar" else real_encode(src, out_dir, stem, job_id)

    monkeypatch.setattr(pipeline, "_encode_stem_opus", encode_all_but_guitar)
    monkeypatch.setattr(pipeline, "upload_stem", lambda *a, **k: "k")

    report = pipeline.retain_stems(JOB, stem_wavs)
    assert len(report["play"]) == 5
    assert report["complete"] is False
    assert len(sent) == 1, "a partial retention must alert too, not just a total failure"
    assert "5/6 playable" in sent[0][0]
    # 5 playable vs 6 downloadable is FEWER encodes than uploads -> the encoder.
    assert "likely_cause=encoder" in sent[0][0]


def test_a_complete_retention_is_SILENT(stem_wavs, recorder, monkeypatch):
    """The other half of the contract: six of six must not page anyone."""
    sent = _capture_sentry(monkeypatch)
    report = pipeline.retain_stems(JOB, stem_wavs)
    assert report["complete"] is True
    assert sent == []


def test_a_sentry_outage_cannot_fail_the_job(stem_wavs, recorder, monkeypatch):
    """Telemetry is never load-bearing — capture_message is wrapped in suppress()."""

    def boom(*a, **k):
        raise RuntimeError("sentry down")

    monkeypatch.setattr(pipeline.sentry_sdk, "capture_message", boom)
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", lambda: "/bin/false")
    report = pipeline.retain_stems(JOB, stem_wavs)  # must not raise
    assert report["complete"] is False


def test_the_job_id_reaches_the_encoder_log(stem_wavs, monkeypatch, capsys):
    """Kills the mutation that stops passing job_id into _encode_stem_opus.

    Without it the encode-failure log names a stem but not which job, which is the
    difference between an actionable alert and a curiosity.
    """
    monkeypatch.setattr(pipeline, "upload_stem", lambda *a, **k: "k")
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", lambda: "/bin/false")
    pipeline.retain_stems(JOB, {"drums": stem_wavs["drums"]})
    cap = capsys.readouterr()
    out = cap.err + cap.out
    assert '"event": "stem_opus_encode_failed"' in out
    assert JOB in out


def test_the_logged_stderr_is_the_TAIL_and_long_enough_to_diagnose(monkeypatch, capsys, tmp_path):
    """Kills the mutation that truncates stderr to a useless prefix.

    ffmpeg puts its banner at the TOP and the actual reason on the LAST line, so a
    head-truncated stderr is worse than none. A fake ffmpeg emits a long banner then
    the real cause; the cause must survive.
    """
    fake = tmp_path / "ffmpeg"
    fake.write_text(
        "#!/bin/sh\n"
        "i=0; while [ $i -lt 40 ]; do echo 'ffmpeg version banner line' >&2; i=$((i+1)); done\n"
        "echo \"Unknown encoder 'libopus'\" >&2\n"
        "exit 1\n"
    )
    fake.chmod(0o755)
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", lambda: str(fake))
    monkeypatch.setattr(pipeline, "upload_stem", lambda *a, **k: "k")

    src = tmp_path / "s.wav"
    src.write_bytes(b"RIFF....WAVEfmt ")
    pipeline.retain_stems(JOB, {"drums": str(src)})
    cap = capsys.readouterr()
    out = cap.err + cap.out
    assert "Unknown encoder" in out, "the LAST stderr line is the diagnosis and must survive"

    # log_structured nests detail as a JSON STRING inside a JSON record
    # (logger.py:54-58), so the fields are escaped and a naive substring match on
    # '"returncode": 1' fails. Parse it rather than match the escaping.
    rec = next(
        json.loads(line)
        for line in out.splitlines()
        if line.startswith("{") and "stem_opus_encode_failed" in line
    )
    detail = json.loads(rec["detail"])
    assert detail["returncode"] == 1
    assert detail["job_id"] == JOB
    assert "Unknown encoder" in detail["stderr_tail"]
    # The precise property is that the slice is taken from the END: the tail must
    # FINISH with ffmpeg's last line. (A first draft asserted the banner was absent
    # from the last 40 chars, which is wrong — the error line is only 25 chars, so
    # the preceding banner legitimately falls inside that window.)
    assert detail["stderr_tail"].rstrip().endswith("Unknown encoder 'libopus'")
    assert len(detail["stderr_tail"]) <= 500


# --------------------------------------------------------------------------
# The encode parameters are a budget, not a detail
# --------------------------------------------------------------------------


def test_the_encoded_stream_is_opus_and_reports_48_kHz(stem_wavs, recorder):
    """Codec and container sanity.

    NOTE this canNOT pin STEM_OPUS_RATE: Opus is natively 48 kHz and ALWAYS reports
    48000 here, whatever `-ar` was. A reviewer's `-ar 24000` mutation survived this
    assertion; the test below is the one that catches it.
    """
    pipeline.retain_stems(JOB, {"bass": stem_wavs["bass"]})
    opus = [p for _, p, k in recorder if k == "play"][0]
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,codec_name",
            "-of",
            "default=nw=1:nk=1",
            opus,
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()
    assert probe[0] == "opus", f"codec must be opus, got {probe[0]}"
    assert probe[1] == "48000"


def test_content_above_12_kHz_SURVIVES_the_encode(tmp_path, monkeypatch):
    """Kills a mutation of STEM_OPUS_RATE — behaviourally, not by reading a constant.

    `-ar 24000` puts the Nyquist limit at 12 kHz, so everything above it is destroyed
    before libopus ever sees it. The encoded file still REPORTS 48000 (Opus always
    does), which is why the probe test above cannot catch it. What changes is the
    audio: cymbals and air disappear from every stem, permanently, and nothing in the
    pipeline would say so.

    So: encode a 16 kHz tone and measure whether it is still there.
    """
    import numpy as np
    import soundfile as sf

    src = tmp_path / "hi.wav"
    sr = 48000
    tone_hz = 16000
    n = sr * 2
    sig = 0.5 * np.sin(2 * np.pi * tone_hz * np.arange(n) / sr)
    sf.write(str(src), np.column_stack([sig, sig]), sr, subtype="PCM_24")

    out_dir = str(tmp_path)
    opus = pipeline._encode_stem_opus(str(src), out_dir, "hi", job_id=JOB)
    assert opus, "the probe tone must encode"

    decoded = tmp_path / "decoded.wav"
    subprocess.run(
        [
            pipeline._ffmpeg_bin(),
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
            "-i",
            opus,
            "-ac",
            "1",
            "-ar",
            str(sr),
            str(decoded),
        ],
        check=True,
        capture_output=True,
    )
    y, _ = sf.read(str(decoded))
    spec = np.abs(np.fft.rfft(y * np.hanning(len(y))))
    freqs = np.fft.rfftfreq(len(y), 1 / sr)

    band = (freqs > tone_hz - 800) & (freqs < tone_hz + 800)
    rest = freqs < 10000
    energy_at_tone = float(spec[band].max())
    energy_below = float(spec[rest].max()) + 1e-9

    assert energy_at_tone > energy_below, (
        f"the {tone_hz} Hz tone did not survive the encode "
        f"(peak {energy_at_tone:.1f} vs {energy_below:.1f} below 10 kHz) — "
        "STEM_OPUS_RATE is almost certainly below 48000, which silently destroys "
        "everything above its Nyquist limit"
    )


def test_the_bitrate_stays_inside_the_4_to_5_MB_per_stem_budget(stem_wavs, recorder):
    """Kills a mutation of STEM_OPUS_BITRATE.

    TSD 12.2 budgets 4-5 MB per stem and 3.1's whole 287 MB memory figure rests on
    it. Raising the bitrate keeps every extension and size-vs-WAV check happy while
    silently blowing that budget, so the bound is asserted directly: at 128 kbps a
    1-second stereo stem is ~16 KB, and a 5-minute one projects to ~4.8 MB.
    """
    assert pipeline.STEM_OPUS_BITRATE == "128k"
    pipeline.retain_stems(JOB, {"bass": stem_wavs["bass"]})
    opus = [p for _, p, k in recorder if k == "play"][0]
    seconds = 1.0
    projected_5min_mb = os.path.getsize(opus) / seconds * 300 / 1024 / 1024
    assert (
        projected_5min_mb < 6.0
    ), f"projected {projected_5min_mb:.2f} MB for a 5-minute stem — over the 4-5 MB budget"


def test_a_zero_byte_encode_is_treated_as_failure(stem_wavs, monkeypatch, tmp_path):
    """Kills the mutation that drops the empty-output check.

    ffmpeg can exit 0 having written nothing. Uploading a 0-byte .opus would give
    the mixer a channel that decodes to silence, with `complete: true` — a false
    green of exactly the kind this PR exists to remove.
    """
    fake = tmp_path / "ffmpeg"
    fake.write_text('#!/bin/sh\nfor a in "$@"; do out="$a"; done\n: > "$out"\nexit 0\n')
    fake.chmod(0o755)
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", lambda: str(fake))
    uploaded: list[str] = []
    monkeypatch.setattr(pipeline, "upload_stem", lambda j, s, p, k: uploaded.append(k) or "key")
    report = pipeline.retain_stems(JOB, {"drums": stem_wavs["drums"]})
    assert report["play"] == [], "a zero-byte encode must not count as playable"
    assert "play" not in uploaded, "a zero-byte encode must never be uploaded"
