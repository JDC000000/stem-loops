"""Manifest of approved training data sources for ChordNet Y1.

Each `DataSource` describes one upstream corpus: license, canonical URL, size,
citation, and retrieval notes (anything a human needs to know to actually pull
the files down). This module is the SINGLE source of truth read by:

- `apps/training/data/download.py` — picks the URL and license per `--source`.
- `apps/training/DATA-PROVENANCE.md` — the audit trail Jon can show in a
  cease-and-desist defense and the attribution document for the eventual
  open-source weights release.

Per the V3-Phase-2 Y1 decision (`claude/phase-2-y1-chord-model-decision.md`
v1.1), only permissively licensed sources are allowed: CC0, CC BY, CC BY-SA,
and public-domain / MIT. No scraped-from-YouTube corpora.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DataSource:
    """One upstream training corpus."""

    name: str
    """Short slug used on the CLI, e.g. 'billboard', 'aam', 'guitarset'."""

    license: str
    """SPDX-ish license string, e.g. 'CC0-1.0', 'CC-BY-4.0'."""

    url: str
    """Canonical landing / download URL (Zenodo record, GitHub repo, etc.)."""

    size_gb: float
    """Approximate total download size in GB. Dev subsets may be smaller."""

    citation: str
    """Full academic citation used in DATA-PROVENANCE.md."""

    retrieval_notes: str
    """
    Anything a human needs to know to actually fetch the files: whether audio
    is distributed, any email-request gate, dev-subset vs full corpus, etc.
    """


# ─────────────────────────────────────────────────────────────────────────────
# The approved Y1 training corpora. Order matters only for display.
# ─────────────────────────────────────────────────────────────────────────────

DATA_SOURCES: list[DataSource] = [
    DataSource(
        name="billboard",
        license="CC0-1.0",
        url="https://ddmal.music.mcgill.ca/research/The_McGill_Billboard_Project_(Chord_Analysis_Dataset)",
        size_gb=0.05,
        citation=(
            "Burgoyne, J. A., Wild, J., & Fujinaga, I. (2011). "
            "An Expert Ground-Truth Set for Audio Chord Recognition and Music "
            "Analysis. In Proceedings of the 12th International Society for "
            "Music Information Retrieval Conference (ISMIR 2011), Miami, FL."
        ),
        retrieval_notes=(
            "Annotations only. The McGill Billboard corpus distributes CHORD "
            "LABELS (CC0) — audio is NOT included and must be sourced "
            "separately per the decision record. Retrieve the label bundle "
            "from ddmal.music.mcgill.ca, or request current canonical "
            "distribution from J. A. Burgoyne (University of Amsterdam); see "
            "claude/correspondence/burgoyne-mcgill-billboard-outreach.md."
        ),
    ),
    DataSource(
        name="aam",
        license="CC-BY-4.0",
        url="https://zenodo.org/records/5794629",
        size_gb=209.0,
        citation=(
            "Ostermann, F., Vatolkin, I., & Ebeling, M. (2023). "
            "AAM: A Dataset of Artificial Audio Multitracks for Diverse Music "
            "Information Retrieval Tasks. Zenodo record 5794629."
        ),
        retrieval_notes=(
            "Full corpus is ~209 GB. The download CLI pulls a DEV SUBSET by "
            "default; fetching the full corpus requires --full. Multitrack "
            "stems + aligned chord/beat/key annotations."
        ),
    ),
    DataSource(
        name="guitarset",
        license="CC-BY-4.0",
        url="https://zenodo.org/records/3371780",
        size_gb=2.5,
        citation=(
            "Xi, Q., Bittner, R. M., Pauwels, J., Ye, X., & Bello, J. P. "
            "(2018). GuitarSet: A Dataset for Guitar Transcription. "
            "In Proceedings of the 19th International Society for Music "
            "Information Retrieval Conference (ISMIR 2018), Paris, France."
        ),
        retrieval_notes=(
            "360 ~30-second solo guitar recordings with per-string pitch "
            "and chord annotations. Clean source for guitar-centric chord "
            "supervision in the student pipeline."
        ),
    ),
    DataSource(
        name="winterreise",
        license="CC-BY-3.0",
        url="https://www.audiolabs-erlangen.de/resources/MIR/2021-Schubert-Winterreise",
        size_gb=1.2,
        citation=(
            "Weiß, C., Zalkow, F., Arifi-Müller, V., Müller, M., Koops, H. V., "
            "Volk, A., & Grohganz, H. (2021). Schubert Winterreise Dataset: "
            "A Multimodal Scenario for Music Analysis. "
            "ACM Journal on Computing and Cultural Heritage, 14(2)."
        ),
        retrieval_notes=(
            "Nine complete performances of Schubert's Winterreise cycle with "
            "aligned chord, key, local-key, and measure annotations. "
            "Classical / art-song coverage for genre balance."
        ),
    ),
    DataSource(
        name="pdmx",
        license="CC-BY-4.0",
        url="https://zenodo.org/records/15571083",
        size_gb=18.0,
        citation=(
            "Long, P., Edwards, D., Wu, Y., Dixon, S., McAuley, J., & Berg-"
            "Kirkpatrick, T. (2025). PDMX: A Large-Scale Public Domain "
            "MusicXML Dataset for Symbolic Music Processing. Zenodo record "
            "15571083."
        ),
        retrieval_notes=(
            "MuseScore public-domain MusicXML scores. Use the "
            "`no_license_conflict` subset only — this is the filter "
            "guaranteed clear of upstream CC-BY-NC / CC-BY-ND content. "
            "Feeds synthetic-rendering (pyFluidSynth) in PR-Y1.3."
        ),
    ),
    DataSource(
        name="openewld",
        license="MIT (code) + public-domain (content)",
        url="https://github.com/00sapo/OpenEWLD",
        size_gb=0.2,
        citation=(
            "Simonetta, F. (2019). OpenEWLD: A dataset for Enhanced Wikifonia "
            "Leadsheets, based on the Wikifonia project. "
            "https://github.com/00sapo/OpenEWLD"
        ),
        retrieval_notes=(
            "Public-domain subset of the Wikifonia lead-sheet collection. "
            "Lead-sheet MusicXML with chord symbols + melody; lightweight "
            "second feed for synthetic rendering alongside PDMX."
        ),
    ),
    DataSource(
        name="fma",
        license="per-track CC (CC-BY-4.0, CC-BY-SA-4.0, CC0-1.0 only)",
        url="https://github.com/mdeff/fma",
        size_gb=93.0,
        citation=(
            "Defferrard, M., Benzi, K., Vandergheynst, P., & Bresson, X. "
            "(2017). FMA: A Dataset for Music Analysis. In Proceedings of "
            "the 18th International Society for Music Information Retrieval "
            "Conference (ISMIR 2017), Suzhou, China."
        ),
        retrieval_notes=(
            "Free Music Archive bulk dump. The download CLI FILTERS to only "
            "CC-BY-4.0, CC-BY-SA-4.0, and CC0-1.0 per-track licenses using "
            "the shipped track metadata. Any other license tier (CC-BY-NC, "
            "CC-BY-ND, CC-BY-NC-SA, etc.) is excluded at retrieval time."
        ),
    ),
]


def by_name(name: str) -> DataSource:
    """Look up a source by its CLI slug. Raises KeyError on unknown name."""
    for src in DATA_SOURCES:
        if src.name == name:
            return src
    raise KeyError(f"Unknown data source: {name!r}. Known: {[s.name for s in DATA_SOURCES]}")
