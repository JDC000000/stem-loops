# DATA-PROVENANCE.md

Living audit trail for every dataset used to train the stem-loops V3
ChordNet student. Two purposes:

1. **Cease-and-desist defense.** If any upstream rights-holder questions
   stem-loops' training inputs, this document — together with the
   `cache/MANIFEST.jsonl` hashes — is the primary evidence that every byte
   came from a permissively licensed source and was taken under its stated
   terms.
2. **Open-source attribution.** Per
   `claude/phase-2-y1-chord-model-decision.md` v1.1, if the trained weights
   clear the 20-song held-out eval, Jon releases them under Apache-2.0. The
   release ships with a copy of this document so every upstream dataset is
   credited in the form each license requires.

## Process

- Every entry below is **pre-populated** the day the source is approved for
  the Y1 recipe. `Downloaded`, `SHA-256`, and `Provenance verified by`
  fields are set to `pending` until the real download lands via
  `python -m training.data.download --source <name> --confirm`.
- When a download completes, the CLI appends to
  `apps/training/data/cache/MANIFEST.jsonl`. The human running the download
  is responsible for copying the resulting SHA-256(s) and timestamp back
  into the matching entry in this file in the same PR.
- Do not edit `License` or `Citation` fields unless the upstream source has
  itself changed those terms. Any such edit requires a separate PR with the
  upstream page linked as evidence.

## Entries

### McGill Billboard (CC0)

- **Source:** https://ddmal.music.mcgill.ca/research/The_McGill_Billboard_Project_(Chord_Analysis_Dataset)
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> origin/v3/main
- **License:** CC0-1.0 (public domain dedication) — **labels only**.
  As fetched in PR-Y1.3c, the ChoCo re-packaging adds a CC-BY-4.0 overlay
  on the partition structure (the labels themselves remain CC0); credit
  ChoCo in the release alongside the McGill citation.
<<<<<<< HEAD
=======
- **License:** CC0-1.0 (public domain dedication) — **labels only**
>>>>>>> origin/v3/main
=======
>>>>>>> origin/v3/main
- **Audio:** NOT distributed. We source audio separately per the decision
  record; audio source + license is tracked in a per-track audio-provenance
  table landed in a later PR. This entry covers only the Billboard
  annotation bundle.
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> origin/v3/main
- **Download command:** `python -m training.data.download --source billboard --confirm`
  (fallback path: shallow-clones `github.com/smashub/choco` and keeps only
  `partitions/billboard/`. The Burgoyne/UvA canonical distribution replaces
  this path once the outreach in
  `claude/correspondence/burgoyne-mcgill-billboard-outreach.md` lands.)
<<<<<<< HEAD
=======
>>>>>>> origin/v3/main
=======
>>>>>>> origin/v3/main
- **Downloaded:** pending
- **SHA-256 of label bundle:** pending
- **Citation:** Burgoyne, J. A., Wild, J., & Fujinaga, I. (2011).
  An Expert Ground-Truth Set for Audio Chord Recognition and Music
  Analysis. In Proceedings of the 12th International Society for Music
  Information Retrieval Conference (ISMIR 2011), Miami, FL.
- **Attribution requirement:** None (CC0). We still credit DDMAL in the
  open-source release notes.
- **Usage scope:** Training labels + 20-song held-out eval.
- **Provenance verified by:** pending

### AAM — Artificial Audio Multitracks (CC BY 4.0)

- **Source:** https://zenodo.org/records/5794629
- **License:** CC-BY-4.0
- **Audio:** Multitrack stems included.
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> origin/v3/main
- **Download command (sample, ~21 GB):** `python -m training.data.download --source aam --confirm`
- **Download command (full, ~209 GB):** `python -m training.data.download --source aam --confirm --full`
  (Sample mode takes the first 300 file entries alphabetically from the
  Zenodo file list — deterministic ~10% coverage without a second API round
  trip. Each downloaded file is MD5-verified against the Zenodo checksum.)
<<<<<<< HEAD
=======
>>>>>>> origin/v3/main
=======
>>>>>>> origin/v3/main
- **Downloaded:** pending
- **SHA-256(s):** pending (dev-subset archive; `--full` variant when fetched)
- **Citation:** Ostermann, F., Vatolkin, I., & Ebeling, M. (2023).
  AAM: A Dataset of Artificial Audio Multitracks for Diverse Music
  Information Retrieval Tasks. Zenodo record 5794629.
- **Attribution requirement:** CC-BY-4.0 — credit author(s) + license in
  release notes + weights README.
- **Usage scope:** Student training (chord/beat/key supervision).
- **Provenance verified by:** pending

### GuitarSet (CC BY 4.0)

- **Source:** https://zenodo.org/records/3371780
- **License:** CC-BY-4.0
- **Audio:** 360 solo guitar recordings (~30 s each) included.
<<<<<<< HEAD
<<<<<<< HEAD
- **Download command:** `python -m training.data.download --source guitarset --confirm`
  (Pulls every file listed on the Zenodo record (~2.5 GB total); each
  archive is MD5-verified against the Zenodo checksum.)
=======
>>>>>>> origin/v3/main
=======
- **Download command:** `python -m training.data.download --source guitarset --confirm`
  (Pulls every file listed on the Zenodo record (~2.5 GB total); each
  archive is MD5-verified against the Zenodo checksum.)
>>>>>>> origin/v3/main
- **Downloaded:** pending
- **SHA-256(s):** pending
- **Citation:** Xi, Q., Bittner, R. M., Pauwels, J., Ye, X., & Bello, J. P.
  (2018). GuitarSet: A Dataset for Guitar Transcription. In Proceedings of
  the 19th International Society for Music Information Retrieval
  Conference (ISMIR 2018), Paris, France.
- **Attribution requirement:** CC-BY-4.0 — credit author(s) + license.
- **Usage scope:** Guitar-centric chord supervision.
- **Provenance verified by:** pending

### Schubert Winterreise (CC BY 3.0)

- **Source:** https://www.audiolabs-erlangen.de/resources/MIR/2021-Schubert-Winterreise
- **License:** CC-BY-3.0
- **Audio:** Nine complete performances included.
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> origin/v3/main
- **Download command:** MANUAL FETCH ONLY. The AudioLabs Erlangen page has
  no automatable endpoint (no public Zenodo mirror and the landing page
  gates downloads behind a form). Running
  `python -m training.data.download --source winterreise --confirm`
  intentionally exits with `not-yet-implemented` (rc=3) and points back to
  this entry.

  Manual steps:
  1. Visit https://www.audiolabs-erlangen.de/resources/MIR/2021-Schubert-Winterreise
     and complete the data-request form (free; the AudioLabs team emails a
     download link, typically same-day).
  2. Download every archive the link covers into
     `apps/training/data/cache/winterreise/`.
  3. For each archive, run `sha256sum <file>` and append a matching line to
     `apps/training/data/cache/MANIFEST.jsonl` in the same shape as the
     automated sources use (`{source, filename, sha256, license,
     download_timestamp, src_url}`), using `CC-BY-3.0` and
     `https://www.audiolabs-erlangen.de/resources/MIR/2021-Schubert-Winterreise`
     as the license and src_url.
  4. Copy each archive's SHA-256 + the UTC timestamp back into this entry
     in the same PR.
<<<<<<< HEAD
=======
>>>>>>> origin/v3/main
=======
>>>>>>> origin/v3/main
- **Downloaded:** pending
- **SHA-256(s):** pending
- **Citation:** Weiß, C., Zalkow, F., Arifi-Müller, V., Müller, M.,
  Koops, H. V., Volk, A., & Grohganz, H. (2021). Schubert Winterreise
  Dataset: A Multimodal Scenario for Music Analysis. ACM Journal on
  Computing and Cultural Heritage, 14(2).
- **Attribution requirement:** CC-BY-3.0 — credit author(s) + AudioLabs
  Erlangen + license.
- **Usage scope:** Classical / art-song coverage in the training mix.
- **Provenance verified by:** pending

### PDMX — MuseScore Public-Domain MusicXML (CC BY 4.0)

- **Source:** https://zenodo.org/records/15571083
- **License:** CC-BY-4.0
- **Subset used:** `no_license_conflict` only. The broader PDMX archive
  contains a mix of licenses; we restrict strictly to the pre-filtered
  subset the authors guarantee as free of upstream conflicts.
<<<<<<< HEAD
<<<<<<< HEAD
- **Download command:** `python -m training.data.download --source pdmx --confirm`
=======
>>>>>>> origin/v3/main
=======
- **Download command:** `python -m training.data.download --source pdmx --confirm`
>>>>>>> origin/v3/main
- **Downloaded:** pending
- **SHA-256(s):** pending
- **Citation:** Long, P., Edwards, D., Wu, Y., Dixon, S., McAuley, J., &
  Berg-Kirkpatrick, T. (2025). PDMX: A Large-Scale Public Domain MusicXML
  Dataset for Symbolic Music Processing. Zenodo record 15571083.
- **Attribution requirement:** CC-BY-4.0 — credit author(s) + license.
- **Usage scope:** Input to synthetic rendering (PR-Y1.3).
- **Provenance verified by:** pending

### OpenEWLD (MIT code + public-domain content)

- **Source:** https://github.com/00sapo/OpenEWLD
- **License:** MIT for repo code; public-domain for the Wikifonia-derived
  lead-sheet content included.
<<<<<<< HEAD
<<<<<<< HEAD
- **Download command:** `python -m training.data.download --source openewld --confirm`
=======
>>>>>>> origin/v3/main
=======
- **Download command:** `python -m training.data.download --source openewld --confirm`
>>>>>>> origin/v3/main
- **Downloaded:** pending
- **SHA-256(s):** pending
- **Citation:** Simonetta, F. (2019). OpenEWLD: A dataset for Enhanced
  Wikifonia Leadsheets, based on the Wikifonia project.
  https://github.com/00sapo/OpenEWLD
- **Attribution requirement:** MIT notice + OpenEWLD credit in release
  notes.
- **Usage scope:** Second feed for synthetic rendering alongside PDMX.
- **Provenance verified by:** pending

### FMA — Free Music Archive (per-track CC filter)

- **Source:** https://github.com/mdeff/fma
- **License:** Per-track. We retain **only** tracks whose metadata lists
  CC-BY-4.0, CC-BY-SA-4.0, or CC0-1.0. Any other license tier (CC-BY-NC,
  CC-BY-ND, CC-BY-NC-SA, all-rights-reserved, etc.) is dropped at
  retrieval time by the download CLI's FMA filter.
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> origin/v3/main
- **Download command (small audio subset):** `python -m training.data.download --source fma --confirm`
- **Download command (medium audio subset):** `python -m training.data.download --source fma --confirm --full`
  (Both commands fetch `fma_metadata.zip` first, filter `tracks.csv` to the
  allowlisted licenses, and write the retained-track roster to
  `apps/training/data/cache/fma/fma_retained_tracks.csv`. The audio archive
  (`fma_small.zip` or `fma_medium.zip`) is monolithic on the Switch cloud
  mirror; the training-data loader extracts only the retained tracks from
  it at train time, so any excluded-license audio is never written to the
  on-disk training set.)
<<<<<<< HEAD
=======
>>>>>>> origin/v3/main
=======
>>>>>>> origin/v3/main
- **Downloaded:** pending
- **SHA-256(s):** pending (per retained track; the filter log also lands
  in the manifest)
- **Citation:** Defferrard, M., Benzi, K., Vandergheynst, P., & Bresson, X.
  (2017). FMA: A Dataset for Music Analysis. In Proceedings of the 18th
  International Society for Music Information Retrieval Conference
  (ISMIR 2017), Suzhou, China.
- **Attribution requirement:** Per-track — the retained-tracks manifest
  records each track's license and attribution requirement verbatim.
  CC-BY-SA tracks propagate share-alike obligations to any derivative
  that embeds their audio directly; we only use them for feature
  extraction (CQT / chromagram) at train time, not re-distribution.
- **Usage scope:** Student training (real-audio feature coverage).
- **Provenance verified by:** pending

<<<<<<< HEAD
### FluidR3_GM soundfont (MIT)

- **Source:** https://musical-artifacts.com/artifacts/738/FluidR3_GM.sf2
- **License:** MIT (Frank Wen, 2000). Travels in the open-source weights
  bundle; the MIT notice ships beside the release.
- **Audio:** N/A — SoundFont asset, not a corpus. Used by
  `apps/training/data/synthetic_render.py` to render the PDMX + OpenEWLD
  MIDI/MusicXML feeds into training audio.
- **Download command:** `python -m training.data.download --source fluidr3 --confirm`
- **Downloaded:** pending
- **SHA-256 pinning (QA-B H3 flow):** No SHA-256 is baked into the download
  CLI on first run; `FLUIDR3_SHA256` in `apps/training/data/download.py`
  starts as `None`. The first successful fetch prints the computed sha256
  to stderr and logs it. Jon pastes that value back into `FLUIDR3_SHA256`
  (and updates this line to record it) in the same PR; every subsequent
  download then verifies against that pin and raises
  `ChecksumMismatchError` on drift. This replaces the original 32-char
  hex constant that was MD5-shaped and never actually compared — see
  `claude/phase-2-y1-qa-b-code-review.md` H3.
- **Citation:** Wen, F. (2000). FluidR3_GM: A General MIDI SoundFont. MIT
  License. Distributed via musical-artifacts.com.
- **Attribution requirement:** MIT notice + author credit in the release
  notes.
- **Usage scope:** Default soundfont for synthetic-rendering (PR-Y1.3).
- **Provenance verified by:** pending

=======
>>>>>>> origin/v3/main
## Audio provenance for the Billboard eval

The 20-song held-out eval uses Billboard chord labels against commercially-
released audio. The per-track audio source + license (purchased / licensed
/ under which safe-harbour) is tracked in a separate per-track table landed
in the PR that introduces the eval runner. Nothing in this file authorises
use of commercially-released audio outside that explicit per-track table.

## Changelog

- **2026-11-04 — PR-Y1.2:** File created. Seven sources pre-populated,
  all fields `pending` until the respective downloads land.
<<<<<<< HEAD
<<<<<<< HEAD
=======
>>>>>>> origin/v3/main
- **2026-11-04 — PR-Y1.3c:** Per-source `Download command:` lines added
  for Billboard (ChoCo fallback), AAM (sample vs `--full`), GuitarSet,
  PDMX, OpenEWLD, and FMA. Winterreise entry expanded with the explicit
  manual-fetch steps that the CLI now points back to. `Downloaded`,
  `SHA-256`, and `Provenance verified by` fields stay `pending` until Jon
  actually runs each command.
<<<<<<< HEAD
- **2026-11-04 — PR-QA-B-fixups (H3):** FluidR3_GM entry added. The
  download CLI's `FLUIDR3_SHA256` constant is `None` on first run and is
  pinned from the first successful fetch; mismatches on subsequent runs
  raise `ChecksumMismatchError`. The previous 32-char hex constant was
  MD5-shaped and never compared — bytes on disk were trusted implicitly
  and the MIT-licensing claim rested on that implicit trust.
=======
>>>>>>> origin/v3/main
=======
>>>>>>> origin/v3/main
