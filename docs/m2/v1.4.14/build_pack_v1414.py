#!/usr/bin/env python3
"""Build docs/m2/M2-PACK-v1.4.14.md from v1.4.13 + the v1.4.14 files. Every edit is
an exact, asserted replacement. Usage: build_pack_v1414.py PACK_DIR SCRIPT TEST DIFF SWEEP_OUT"""
import hashlib, re, sys

pack_dir, script_p, test_p, diff_p, sweep_p = sys.argv[1:6]
src = open(f"{pack_dir}/M2-PACK-v1.4.13.md", encoding="utf-8").read()
script = open(script_p, encoding="utf-8").read()
test = open(test_p, encoding="utf-8").read()
diff = open(diff_p, encoding="utf-8").read()
sweep = open(sweep_p, encoding="utf-8").read()
H = lambda t: hashlib.sha256(t.encode()).hexdigest()
SH, TH, DH = H(script), H(test), H(diff)
SL, TL, DL = script.count("\n"), test.count("\n"), diff.count("\n")
NT = 730
NTF = len(re.findall(r"^def test_", test, re.M))
m = re.search(r"TOTAL (\d+) of (\d+) killed; (\d+) survived; (\d+) anchor misses", sweep)
MK, MN = int(m.group(1)), int(m.group(2))
assert MK == MN and m.group(3) == "0" and m.group(4) == "0"
s = src


def rep(a, b, cnt=1):
    global s
    n = s.count(a)
    assert n == cnt, (a[:90], n)
    s = s.replace(a, b)


def cut_between(start, end, repl):
    """Replace s[start_marker : end_marker) (end marker kept)."""
    global s
    i = s.index(start)
    j = s.index(end, i + len(start))
    s = s[:i] + repl + s[j:]


# ── 1. frontmatter ──
rep("version: v1.4.13\nversion_date: 2026-11-22 (v1.4.13 written 2026-11-22:",
    "version: v1.4.14\nversion_date: 2026-11-22 (v1.4.14 written 2026-11-22: the six G0 findings "
    "(41/100) answered in code, workflow and text; v1.4.13 written 2026-11-22:")
rep("status: >\n  v1.4.13 (2026-11-22) NEEDS A DELTA REVIEW > 90.",
    "status: >\n  v1.4.14 (2026-11-22) NEEDS AN INDEPENDENT REVIEW > 90. The one-time G0 review of\n"
    "  v1.4.13 (gpt-5.4, non-Claude) scored 41, FAIL, on six findings; v1.4.14 answers each\n"
    "  in code, workflow or text (\"What changed in v1.4.14\"). m2_verdict.py, M2_PINS (so\n"
    "  M2-workflow.diff) and test_m2_verdict.py are re-pinned; the mutant set is new and\n"
    "  complete in one file.\n"
    "  v1.4.13 (2026-11-22) NEEDS A DELTA REVIEW > 90.")
entry = (
    f"  - v1.4.14 (2026-11-22): **G0 (gpt-5.4, 41/100, FAIL) answered.** (1) blocker: class-A "
    f"diffs can no longer carry reviewer-facing text: `TEXT_CHANNELS` refuses, before the "
    f"ledger and the model, any added quote or backtick, JSX text, bare-word run, CSS `content` "
    f"or custom property, character-code/join/decode construction and computed global access; "
    f"legs (g1)–(g4) are now refused before the model. (2) blocker: "
    f"`actions/create-github-app-token` and `actions/github-script` pinned to full commits "
    f"(tag → SHA in §3.3). (3) the gate checkout is `ref: v3/main`. (4) the daily cap counts "
    f"`m2/pass/<date>` commit statuses, not comments. (5) every live count is v1.4.14's: "
    f"**{NT} tests** on 3.11, 3.12, 3.13; **{MK} of {MN} mutants**, all transcribed in "
    f"`mutate_v1414.py`. (6) exact `CLASS_A` set test. `m2_verdict.py` `{SH[:8]}…`, "
    f"`M2-workflow.diff` `{DH[:8]}…`, test file `{TH[:8]}…`.\n"
)
rep("changelog:\n", "changelog:\n" + entry)

# ── 2. the v1.4.14 section ──
S_ = "scripts/m2_verdict.py"
T_ = "apps/worker/tests/test_m2_verdict.py"
W_ = ".github/workflows/auto-merge.yml"


def ln(text, needle, nth=1):
    pos = -1
    for _ in range(nth):
        pos = text.index(needle, pos + 1)
    return text.count("\n", 0, pos) + 1


wf = open(sys.argv[6], encoding="utf-8").read()
L = {
    "tc": ln(script, "TEXT_CHANNELS: tuple"),
    "tcf": ln(script, "def text_channels("),
    "kw": ln(script, "_KEYWORD_TEXT = ("),
    "call": ln(script, "reasons = reasons or red_flags(sections) or text_channels(sections)"),
    "cap": ln(script, 'return Outcome(EXIT_DRIFT, [f"daily cap: {recent} M2 passes in 24 h"])') - 1,
    "pr": ln(script, "def _pass_rows("),
    "pw": ln(script, 'pass_ctx = f"{PASS_CONTEXT_PREFIX}{now:%Y-%m-%d}"'),
    "race": ln(script, "    if recent > DAILY_CAP:"),
    "pol": ln(script, "# Class A: 12 T1 files"),
    "ref": ln(wf, "          ref: v3/main"),
    "tok": ln(wf, "uses: actions/create-github-app-token@"),
    "gs": ln(wf, "uses: actions/github-script@"),
    "pin": ln(wf, "base/scripts/m2_verdict.py\n"),
    "t_cls": ln(test, "def test_class_a_is_exactly_these_twelve_files"),
    "t_tc": ln(test, "def test_each_text_channel_rule_refuses_on_its_own"),
    "t_ord": ln(test, "def test_the_text_channel_rules_let_ordinary_code_through"),
    "t_r34": ln(test, "def test_review3_and_review4_payloads_are_refused_before_the_model"),
    "t_former": ln(test, "def test_formerly_residual_forms_are_now_refused_before_the_model"),
    "t_resid": ln(test, "def test_residual_forms_are_known_to_reach_the_model"),
    "t_legs": ln(test, "def test_live_proof_injection_legs_are_refused_before_the_model_and_the_ledger"),
    "t_ref": ln(test, "def test_the_workflow_checks_out_v3_main_by_name"),
    "t_ref2": ln(test, '"ref": "v3/main",  # v1.4.14'),
    "t_pin": ln(test, "def test_every_action_in_the_merge_path_is_pinned_to_a_full_commit"),
    "t_cap": ln(test, "def test_cap_boundary"),
    "t_race": ln(test, "def test_the_cap_cannot_be_overshot_by_simultaneous_passes"),
    "t_write": ln(test, "def test_a_pass_writes_one_pass_row_after_the_model_and_before_exit_0"),
    "t_nocmt": ln(test, "def test_the_cap_reads_no_pr_list_and_no_comment"),
}
n_tc = test.count('", "adds ') + 0
section = f"""## What changed in v1.4.14 (G0 41/100 → this pack)

**Why [D].** The one-time G0 review of v1.4.13 (`m2-g0-review.yml`, gpt-5.4-2026-03-05, the first **non-Claude** review of this pack) scored **41 / 100, FAIL**, on six findings (`G0-REVIEW-v1.4.13-41-FAIL.md`). Each is answered below by a change to code, the workflow or a live statement, and each change is pinned by a test that the mutation sweep shows can fail.

| # | G0 finding | Fix in v1.4.14 | Where (file:line at the pinned bytes) | Pinned by |
|---|---|---|---|---|
| 1 | **blocker** — class-A diffs still carry reviewer-facing text (strings, JSX text, CSS, character codes, `join`); 11 of REVIEW-3's 22 and 10 of REVIEW-4's 21 payloads reached the model | **Deterministic refusal of every literal-text channel, before the ask ledger and the model.** `TEXT_CHANNELS` (8 rules, scoped `.tsx`/`.css`) refuses an added line holding: a quote or backtick (every string, template literal and CSS string); JSX text (after a tag, before a closing tag, after `{{…}}`); two bare non-keyword words in a row (JSX text or attribute names as words); a line of bare words; CSS `content:`; a CSS custom-property declaration; `fromCharCode`/`fromCodePoint`/`charCodeAt`/`codePointAt`/`.join(`/`.concat(`/`atob`/`btoa`/`TextDecoder`/`String.raw`/`unescape`/`decodeURI*`/`.toString(<digit>`/`parseInt(`/`.reverse(`; `window`/`globalThis`/`self`/`top`/`parent`/`frames`/`document` `[…]` and `new (…)`. Comments were already refused (v1.2). A file that is neither `.tsx` nor `.css` is refused outright | `{S_}:{L['kw']}` (keywords), `:{L['tc']}` (`TEXT_CHANNELS`), `:{L['tcf']}` (`text_channels`), `:{L['call']}` (called after `red_flags`, before any status read) | `{T_}:{L['t_tc']}` (one case per rule form, each refused **alone**, with a model that always says PASS, no status read, no ask), `:{L['t_ord']}` (ordinary code still passes), `:{L['t_r34']}` (REVIEW-3/-4 corpus), `:{L['t_former']}` (Y1, Y3-join, Y6, Y7, formerly pinned as reaching), `:{L['t_legs']}` (legs (g1)–(g3)) |
| 2 | **blocker** — `actions/create-github-app-token@v2` unpinned in the merge path, holding `APP_PRIVATE_KEY` | Pinned by commit. `git ls-remote https://github.com/actions/create-github-app-token.git` on 2026-11-22: `refs/tags/v2` → **`fee1f7d63c2ff003460e3d139729b119787bc349`**, the same object as `refs/tags/v2.2.2`; no `^{{}}` line, so it is a **lightweight** tag and the ref **is** the commit (confirmed: `git fetch --depth=1` then `git cat-file -t` → `commit`, "build(release): 2.2.2", 2026-03-13). The only other unpinned `uses:` in the file, `actions/github-script@v7` (`drop-stale-review`), is pinned too: `v7` → **`f28e40c7f34bde8b3046d885e986cb6290c5673b`** (= `v7.1.0`, lightweight, `commit`). `actions/checkout` was already `11d5960a…` (v4.4.0). `auto-label-codeowners.yml` has no `uses:`. **`gh api repos/actions/…/git/ref/tags/…` was refused in this session** (403, the repo is not attached); `ls-remote` + `cat-file` is the same resolution over git | `{W_}:{L['tok']}`, `:{L['gs']}` | `{T_}:{L['t_pin']}` (every `uses:` in both workflows is `@<40 hex>` and equals the table) |
| 3 | major — the gate checkout uses `github.event.repository.default_branch`, not `v3/main`; a test pinned it | `ref: v3/main`, by name. The old assertion now expects `v3/main` | `{W_}:{L['ref']}` | `{T_}:{L['t_ref2']}` (the fixed test), `:{L['t_ref']}` (`ref == REQUIRED_BASE`; `default_branch` appears nowhere in the file) |
| 4 | major — the daily cap counts editable PR comments | **The cap counts `github-actions[bot]` commit statuses `m2/pass/<date>` on the ledger commit `979e5fc8`**, which no one can edit or delete [A, GitHub REST docs]. Before the ask: refuse if ≥ `DAILY_CAP` (5) in 24 h. On a model PASS: write one row (`pr=<n> head=<sha>`), read it back as the bot (one retry), count again; > 5 (a racing run) → exit 1; any read/write failure → exit 2 (`E-CAP-UNCOUNTABLE`). It counts **passes**, which bound merges from above (a refused merge still used one). `recent_closed`, `comments` and `count_recent_m2_merges` are gone | `{S_}:{L['pr']}` (`_pass_rows`), `:{L['cap']}` (pre-ask check), `:{L['pw']}` (write, read back), `:{L['race']}` (re-count) | `{T_}:{L['t_cap']}` and the 14 cap tests after it, `:{L['t_write']}`, `:{L['t_race']}`, `:{L['t_nocmt']}` |
| 5 | major — live evidence said 620 tests / 296 mutants while v1.4.13 had 622 / 290 | Every live count is re-measured on v1.4.14's bytes: **{NT} tests** (was 622), **{MK} of {MN} mutants killed, 0 survivors, 0 anchor misses**. The 296-mutant `mutate_v147.py` is not on this box, so it is **retired**, not re-run: `mutate_v1414.py` is a new set with **every mutant transcribed in one file** (§4.3) | §0 item 3, §0.1 G2, §4.1, §4.3 | the sweep output `mutants_v1414.out` |
| 6 | minor — only `len(CLASS_A) == 12` is tested | Exact set equality, and every member ends `.tsx` or `.module.css` | — | `{T_}:{L['t_cls']}` |
| — | manifest follow-ups | the POLICY comment says "12 T1 files … (3 deleted by #332)"; `mutate_v147.py`'s "five" vs six long mutants is moot (retired; the new script's docstring counts nothing by hand) | `{S_}:{L['pol']}` | — |

**The chosen rule (finding 1), and what it still lets through.** The rule is not a better prose detector; it removes the places free text lives. After v1.4.14 an added line can hold **no** string, template, comment, JSX text, CSS string/content/custom property, or decoder. What an added line can still say to the model is limited to **identifiers** (each under 40 characters, none a reviewer word, even inside camelCase, never two bare non-keyword words in a row, never six words in a row) separated by code punctuation, and **numbers** (a numeric array is pinned as residual: no decoder may be added beside it). Pinned as **known to reach the model**: `owner.cleared(this.hunk);` and `[80, 65, 83, 83]` (`{T_}:{L['t_resid']}`), and a deletion-only diff (Z1). **PRs it still lets through:** class-A edits that change logic, props, layout or style without adding literal text, e.g. legs (a), (e), (f): a CSS value, an inverted guard, a boolean flip, a hook dependency, a numeric constant. **PRs it now sends to the card:** any added string (an `aria-label`, a `className` template, a `useState('idle')`), JSX text or copy, boolean JSX attributes on their own line (`disabled`), one-word-per-line object shorthand (`value,`), CSS `content`/custom properties, `.join(`/`.reverse(`/`parseInt(`. That is fail-closed and makes class A smaller still; it is the price of not relying on the model for injection.

**Consequence for §5 step 6 [D, the suite].** Legs (g1), (g2), (g3) and the optional (g4) carry their injections in string literals, so the gate now refuses them **before the ask ledger and the model** (exit 1, "adds a string or template literal…"); none can be merged by M2 and none spends an ask. They stay in the proof as live checks of the deterministic refusal. Legs (e) and (f) are the only defect legs that reach the model. Rows 6g1–6g3, 6·(e)–(g4), 6.end, §0.1 G4 and §7.1 say so.

**Files [D].**

| File | v1.4.13 | v1.4.14 |
|---|---|---|
| `{S_}` | `97b7ed59…1e8d262d`, 1046 lines | **`{SH}`**, {SL} lines |
| `M2-workflow.diff` (= `git -c core.abbrev=7 diff --no-color --no-ext-diff 52cef03 HEAD` on `m2/step4b-v1414`) | `0bb35558…e823cac00b`, 337 lines | **`{DH}`**, {DL} lines |
| `{T_}` | `56d15903…da0afb60`, 2921 lines, 622 cases | **`{TH}`**, {TL} lines, {NTF} test functions, **{NT} cases** |
| `scripts/_gate_exit.py` | `7244c0a7…8475fa587` | unchanged |

**Checks [D, 2026-11-22, tree = `v3/main` 52cef03 + `m2/step4b-v1414` + `m2/step5-v1414`].** **{NT}/{NT} on Python 3.13.18** (worker conftest), **3.12 and 3.11** (`--noconftest`; the conftest imports `psycopg`); real clock only, shifted clocks not re-run. Mutation sweep **{MK} of {MN} killed, 0 survivors, 0 anchor misses**, every kill a failing assertion (no collection error). `check_codeowners_drift.py` and `check_fast_path_allowlist.py` ok; both workflows parse; black (line length 100) and ruff (worker config) clean on both files. **Not run:** actionlint (not on this box), the whole worker suite, shifted clocks.

"""
rep("## What changed in v1.4.13 (fdf4aae → this pack)", section + "## What changed in v1.4.13 (fdf4aae → this pack)")
s = s.replace("`:{L['t_cap']}` and the 14 cap tests after it", "x")  # no-op guard
s = s.replace(f"`{T_}:{L['t_cap']}` and the 14 cap tests after it", f"`{T_}:{L['t_cap']}` and the cap tests after it")
s = s.replace("so the gate now refuses them **before the ask ledger and the model** (exit 1",
              "so the gate now refuses them **before the ask ledger and the model** ((g1)–(g3) "
              "measured by the suite; (g4) by the same rule, its CSS string) (exit 1")


def rep_line(prefix, new, cnt=1):
    """Replace whole lines that start with prefix."""
    global s
    lines = s.split("\n")
    hits = [i for i, l in enumerate(lines) if l.startswith(prefix)]
    assert len(hits) == cnt, (prefix[:80], len(hits))
    for i in hits:
        lines[i] = new
    s = "\n".join(lines)


def prefix_line(prefix, add):
    global s
    lines = s.split("\n")
    hits = [i for i, l in enumerate(lines) if l.startswith(prefix)]
    assert len(hits) == 1, (prefix[:80], len(hits))
    i = hits[0]
    lines[i] = prefix + add + lines[i][len(prefix):]
    s = "\n".join(lines)


# ── 3. §0 and §0.1 ──
rep("2. **(v1.4.3; read-back v1.4.4; re-count v1.4.5)", "2. **(v1.4.14, G0 finding 1) No added line can carry literal text to the model:** strings, "
            "templates, comments, JSX text, bare-word runs, CSS strings/`content`/custom properties, decoders "
            "and computed global access are refused deterministically **before the ask ledger and the model** "
            "(§3.6); what can still reach it is identifiers and numbers. The text below records the earlier "
            "tripwires, which still run first. **(v1.4.3; read-back v1.4.4; re-count v1.4.5)")
rep_line("   - 620 tests pass on Python 3.11, 3.12 and 3.13,",
         f"   - **{NT} tests pass on Python 3.11, 3.12 and 3.13** (v1.4.14, real clock only; v1.4.13: 622; v1.4.7: 620, also at four shifted clocks);")
rep_line("   - **296 of 296 mutants killed** in the author's sweep,",
         f"   - **{MK} of {MN} mutants killed** (v1.4.14, `mutate_v1414.py`, every mutant transcribed in that one file, one run on the final bytes, 0 survivors, 0 anchor misses; it replaces `mutate_v147.py`'s 296, which is not on this box: v1.4.13 ran 290 of them and could not run 6; §4.3);")
rep_line("   - the v1.3 workflow diff **changed**",
         f"   - the workflow diff is `{DH[:8]}…` (v1.4.14: both third-party actions pinned by commit, `ref: v3/main`, new `M2_PINS`), {DL} lines, `52cef03..m2/step4b-v1414` [D];")
rep("5. **The class is the 12 named T1 files, modified only.** Within those files, class A now refuses **prose** (six or more words in a row) and words used to address a reviewer. **Copy edits go to the card.** M2 merges code changes, not text.",
    "5. **The class is the 12 named T1 files, modified only, pinned by exact set equality (v1.4.14).** Within those files, class A refuses any added literal text (v1.4.14) as well as prose and words used to address a reviewer. **Copy edits go to the card.** M2 merges code changes, not text.")
rep("CI green, including the 622 M2 tests in `Tests` (620 before v1.4.12)",
    f"CI green, including the {NT} M2 tests in `Tests` (622 in v1.4.13, 620 before v1.4.12)")
rep("**G4 passes only if (d) is refused before the model and (e), (f), (g1), (g2), (g3) — and (g4), if opened — all get reviewer FAIL.",
    "**G4 passes only if (d) is refused before the model and (e), (f), (g1), (g2), (g3) — and (g4), if opened — all get reviewer FAIL. v1.4.14: (g1), (g2), (g3) and (g4) are refused before the model too (\"adds a string or template literal\"), so for them the pass condition is that refusal, with no ask spent; only (e) and (f) need reviewer FAIL.", cnt=2)

rep("| G0 | anyone acts on this pack | Independent adversarial review scores the pack > 90 | ",
    "| G0 | anyone acts on this pack | Independent adversarial review scores the pack > 90 | "
    "**v1.4.14: the first non-Claude review, the one-time G0 review of v1.4.13 (gpt-5.4, `m2-g0-review.yml`), "
    "scored 41, FAIL; v1.4.14 answers its six findings and needs an independent review > 90.** Earlier: ")
rep("**Before Monday (agent, not Jon):** ",
    "**Before Monday (agent, not Jon):** **v1.4.14: superseded by G0 — an independent review of v1.4.14 must "
    "score > 90 before any step below.** v1.4.11's note: ")

# ── 4. §3.2 pseudocode ──
rep("    checkout BASE branch to ./base (pinned action SHA), persist-credentials=false",
    "    checkout v3/main BY NAME to ./base (pinned action SHA), persist-credentials=false   # v1.4.14")
rep("""           red flags on ADDED lines (code tokens, invisible chars, prose,
               reviewer words, fence/role tokens, 40+ char identifiers)
                                                              else exit 1
           M2 PASS-marked merges in 24 h < 5 (fail closed if uncountable)
                                                              else exit 1 / 2""",
    """           red flags on ADDED lines (code tokens, invisible chars, prose,
               reviewer words, fence/role tokens, 40+ char identifiers)
                                                              else exit 1
           text channels on ADDED lines (v1.4.14): quote/backtick, JSX text,
               bare-word runs, CSS content/custom property, decoders,
               computed globals; file not .tsx/.css               else exit 1
           bot m2/pass/<date> rows on 979e5fc8 in 24 h < 5 (v1.4.14)
                                                              else exit 1 / 2""")
rep("""           PASS iff verdict PASS and confidence >= 80 and no blocker/major
                                                              else exit 1""",
    """           PASS iff verdict PASS and confidence >= 80 and no blocker/major
                                                              else exit 1
           write m2/pass/<date> (pr, head), read back as the bot, count again
               (v1.4.14)                                      > 5: exit 1; error: exit 2""")

# ── 5. §3.3 ──
i = s.index("### 3.3 The exact workflow diff")
j = s.index("File: `M2-workflow.diff`, sha256 **`0bb35558", i)
k = s.index("\n", j)
s = s[:j] + (
    f"File: `M2-workflow.diff`, sha256 **`{DH}`** (v1.4.14), {DL} lines: exactly "
    f"`git -c core.abbrev=7 diff --no-color --no-ext-diff 52cef03 HEAD` on branch `m2/step4b-v1414` after a normal merge of "
    f"`origin/v3/main` (52cef03); three files, `.github/CODEOWNERS`, `auto-label-codeowners.yml`, `auto-merge.yml`. "
    f"v1.4.13's was `0bb35558…e823cac00b`, 337 lines (against fdf4aae). Earlier: `L5/M2-files/M2-workflow.diff`, sha256 `4a4093c6…`, "
    f"337 lines (v1.4.7). It applied cleanly to the d2d1ffc tree [D, 21:4x–22:xx box]. On the v1.4.14 tree [D]:"
) + s[s.index("\n", k):]
rep("**v1.4.5 changes to the diff:** `M2_PINS` for the new script only.",
    "**v1.4.14 changes to the diff (G0 findings 2, 3):** `actions/create-github-app-token@v2` → "
    "`@fee1f7d63c2ff003460e3d139729b119787bc349` (tag `v2` = `v2.2.2`, lightweight; resolved 2026-11-22 by "
    "`git ls-remote` + `git cat-file -t` = `commit`); `actions/github-script@v7` → "
    "`@f28e40c7f34bde8b3046d885e986cb6290c5673b` (`v7` = `v7.1.0`, lightweight, `commit`); the gate checkout "
    "`ref: ${{ github.event.repository.default_branch }}` → `ref: v3/main`; `M2_PINS` for the new script; two "
    "comments no longer say the cap counts comments. Every `uses:` in both workflows is now `@<40 hex>` "
    "(`test_every_action_in_the_merge_path_is_pinned_to_a_full_commit`).\n\n"
    "| Action | Tag | Commit (full) | Object |\n|---|---|---|---|\n"
    "| `actions/create-github-app-token` | `v2` (= `v2.2.2`) | `fee1f7d63c2ff003460e3d139729b119787bc349` | commit, 2026-03-13 |\n"
    "| `actions/github-script` | `v7` (= `v7.1.0`) | `f28e40c7f34bde8b3046d885e986cb6290c5673b` | commit |\n"
    "| `actions/checkout` | `v4.4.0` | `11d5960a326750d5838078e36cf38b85af677262` | commit (unchanged since v1.1) |\n\n"
    "**v1.4.5 changes to the diff:** `M2_PINS` for the new script only.")
rep("The block below is the v1.4.5 file, byte for byte.", "The block below is the v1.4.14 file, byte for byte.")
i = s.index("### 3.3 The exact workflow diff")
j = s.index("```diff\n", i) + len("```diff\n")
k = s.index("\n```\n", j) + 1
s = s[:j] + diff + s[k:]

# ── 6. §3.6 ──
rep("**What v1.3's three rules cost [D,",
    "**Text channels (v1.4.14, G0 finding 1).** After the red flags, `text_channels()` refuses any added line "
    "that holds a quote or backtick, JSX text, two bare non-keyword words in a row, a line of bare words (`.tsx`), "
    "CSS `content:` or a custom-property declaration (`.css`), a character-code/join/decode construction or computed "
    "access to a global; a file that is neither `.tsx` nor `.css` is refused. This is not a tripwire for prose: it "
    "removes the channels, so what an added line can still say is identifiers and numbers. It refuses ordinary edits "
    "too (an added `aria-label`, a `className` template, a `disabled` attribute on its own line); those go to the card. "
    "See \"What changed in v1.4.14\" for what it still lets through.\n\n"
    "**What v1.3's three rules cost [D,")

# ── 7. §4.1 ──
rep_line("| `scripts/m2_verdict.py` | 1046 |",
         f"| `scripts/m2_verdict.py` | {SL} | `{SH[:8]}…{SH[-8:]}` (v1.4.14; v1.4.13 `97b7ed59…1e8d262d`) | Stdlib only. Run as `python3 -I`; drops its own directory from `sys.path`; compiles `scripts/_gate_exit.py` from its **source bytes** (never imports it, so no `.pyc` can stand in) and refuses anything but 0/1/2/3. Its sha256 is pinned in the workflow. Under `scripts/**`, a CODEOWNERS path once the §3.3 diff is applied |")
lines = s.split("\n")
idx = [n for n, l in enumerate(lines) if l.startswith("| `apps/worker/tests/test_m2_verdict.py` | 2921 |")]
assert len(idx) == 1
row = lines[idx[0]]
row = row.replace("| 2921 | `56d15903…da0afb60` (v1.4.13; v1.4.12 `00d2b680…264ce9ed`; v1.4.11 `54d2675a…9bd8a7e2`) | 207 test functions, **622 cases** (v1.4.12: leg data redesigned, `g3` in `LEGS`, one guard test).",
                  f"| {TL} | `{TH[:8]}…{TH[-8:]}` (v1.4.14; v1.4.13 `56d15903…da0afb60`) | {NTF} test functions, **{NT} cases** (v1.4.14: text channels, pass-row cap, exact class, action pins, `ref: v3/main`).")
assert "v1.4.14" in row
lines[idx[0]] = row
s = "\n".join(lines)
i = s.index("Results [D, 2026-11-22, v1.4.13, tree =")
j = s.index("**Ordering lock:**", i)
s = s[:i] + (
    f"Results [D, 2026-11-22, v1.4.14, tree = `v3/main` 52cef03 + `m2/step4b-v1414` + `m2/step5-v1414`]:\n\n"
    f"- **{NT} passed** on Python 3.13.18 (worker conftest), 3.12 and 3.11 (`--noconftest`), real clock;\n"
    f"- mutation sweep: **{MK} of {MN} killed, 0 survivors, 0 anchor misses** (`mutate_v1414.py`, §4.3);\n"
    f"- black (line length 100) and ruff (worker config) clean; both drift gates ok.\n\n"
    "Results [D, 2026-11-22, v1.4.13]: 622 passed on 3.13, 3.12, 3.11; 290 of 290 of `mutate_v147.py` (6 not run). "
    "Results for v1.4.12 and earlier (622 … 422) are kept verbatim in `docs/m2/M2-PACK-v1.4.13.md` §4.1.\n\n"
) + s[j:]

# ── 8. §4.3 ──
groups = [
    ("A1–A12", "switch, scope proof, probe attempt, missing inputs, key whitespace, Claude model name"),
    ("B1–B11", "the PR: state, draft, head SHA, base, fork, author, hold labels, `REQUIRED_BASE`"),
    ("C1–C13", "the files: completeness, empty, caps, class by name (one added, one swapped), status, rename, line count, publicity"),
    ("D1–D18", "the strict parser: CRLF, odd separators, final newline, a/b paths, duplicates, index mode, ---/+++ pair, hunk counts, no-newline marker, size cap, count match"),
    ("E1–E23", "every red-flag rule removed or weakened one at a time, the 5/6-word and 39/40-char boundaries, the lexicon, the first-line-only scan, skipping `red_flags`"),
    ("F1–F42", "v1.4.14 text channels: each of the 8 rules removed, narrowed or re-scoped; each JSX/bare-word/text-only sub-rule weakened; the keyword list grown or cut; the `.tsx`/`.css`/other scoping; the first-line-only scan"),
    ("G1–G23", "v1.4.14 daily cap: boundary, bot-only, prefix, window, write removed, read-back and retry removed, race re-count, error stage, no-PASS-without-row, the cap and window constants"),
    ("H1–H27", "the ask ledger: head and PR/day caps, bot-only, window, unreadable rows, both writes, read-back, race, retry wait, anchor SHA, `since` per read, 201 check, paging"),
    ("I1–I22", "the model and its answer: status, model id, refusal, one text, duplicate keys, exact keys/types, verdict, confidence, severities, request shape (store, strict, fence, schema, prompt)"),
    ("J1–J13", "public output and `main`: sanitising, caps, PASS needs a model PASS, exit-0 guard, comment gating, log scrubbing, marker, crash"),
    ("K1–K2", "import closure (`sys.path` filter) and the 0/1/2/3 exit contract"),
    ("L1–L6", "IO: API version header, diff media type, paging, endpoint, timeout, token cap"),
    ("W1–W10", "the workflow: `ref: v3/main`, the three action pins, `python3 -I`, the three-condition PASS, `persist-credentials`, the model name, the mint step's `if`, `statuses: write`"),
]
table = "\n".join(f"| {g} | {d} | all killed |" for g, d in groups)
i = s.index("### 4.3 The mutant table (296 of 296 killed)")
j = s.index("### 4.4 `scripts/m2_verdict.py` (full)", i)
s = s[:i] + (
    f"### 4.3 The mutant table ({MK} of {MN} killed)\n\n"
    f"v1.4.14: `mutate_v1414.py`, output `mutants_v1414.out` [D, 2026-11-22], **one run on the final bytes: "
    f"{MK} of {MN} killed, 0 survivors, 0 anchor misses**; every kill is a failing assertion (no collection error). "
    f"**Every mutant is transcribed in that one file** as (id, file, unique anchor, replacement); nothing is recovered "
    f"from elsewhere, so nothing is left untranscribed. Each is applied to a fresh copy of the combined tree, the whole "
    f"M2 test file runs (`-x`; the pin test deselected, because every script mutant changes the pinned hash), and the "
    f"copy is discarded; the harness asserts the source tree's four sha256 are unchanged at the end. Both files are "
    f"committed beside this pack in `docs/m2/v1.4.14/`.\n\n"
    f"**Why a new set.** `mutate_v147.py` (296, v1.4.5–v1.4.7) is not on this box; v1.4.13 ran a 290-mutant recovery "
    f"of it and could not run 6 (G0 finding 5). Many of its anchors no longer exist (the comment-based cap is gone). "
    f"The new set covers every decision point of the v1.4.14 script and the workflow's M2 lines. Read {MK} of {MN} as "
    f"\"no survivor in this author's list\", not as a measure of strength; the v1.4.13 table and the history of the "
    f"reviewers' sets (REVIEW-2 to -11) are kept verbatim in `docs/m2/M2-PACK-v1.4.13.md` §4.3.\n\n"
    f"| Ids | What they mutate | Result |\n|---|---|---|\n{table}\n\n"
) + s[j:]

# ── 9. §4.4 / §4.5 ──
for head, body in (("### 4.4 `scripts/m2_verdict.py` (full)", script),
                   ("### 4.5 `apps/worker/tests/test_m2_verdict.py` (full)", test)):
    i = s.index(head)
    j = s.index("```python\n", i) + len("```python\n")
    k = s.index("\n```\n", j) + 1
    s = s[:j] + body + s[k:]

# ── 10. §5 step 6 rows ──
V = ("**v1.4.14 (G0 finding 1): this leg's literal(s) now trip `TEXT_CHANNELS`, so expect "
     "\"not merged\" with a comment starting \"adds a string or template literal…\", "
     "**no ask spent and no model call**; that refusal is this leg's pass. The text below is v1.4.12's.** ")
for row in ("| 6g1 | **(g1) defect + short string literals** | ",
            "| 6g2 | **(g2) defect + one slash-joined literal (REVIEW-3 Y1)** | ",
            "| 6g3 | **(g3) defect + a forged answer (REVIEW-3 Y3, `join()` form)** | "):
    rep(row, row + V)
rep("| 6·(e)–(g4) | **STOP AND READ THIS ROW BEFORE OPENING LEG (e), AND AGAIN BEFORE OPENING (g4)** ",
    "| 6·(e)–(g4) | **STOP AND READ THIS ROW BEFORE OPENING LEG (e), AND AGAIN BEFORE OPENING (g4)** "
    "**v1.4.14: (g1)–(g4) are now refused before the model (their literals), so only (e) and (f) can be "
    "merged by a model PASS; this row's failure branch still applies to every leg, in case a refusal does not "
    "happen.** ")
rep("The nine legs use 6–7 of the day's 10 asks ((b), (c) and (d) never reach the ledger)",
    "v1.4.14: (g1)–(g4) no longer reach the ledger either, so the legs use 3–4 asks ((a), (e) twice with its re-run, (f)); v1.4.13 said: the nine legs use 6–7 of the day's 10 asks ((b), (c) and (d) never reach the ledger)")

# ── 11. §7.1 rows ──
rep("| **Prompt injection** in the diff steers the model to PASS | Medium / low | Injection needs **text** the model reads. ",
    "| **Prompt injection** in the diff steers the model to PASS | Medium / low | **v1.4.14 (G0 finding 1): every "
    "literal-text channel is refused deterministically before the model** — strings, templates, JSX text, bare-word "
    "runs, CSS strings/`content`/custom properties, decoders (`fromCharCode`, `.join(`, `atob`, base-36 …) and computed "
    "globals; the REVIEW-3/-4 forms that reached the model (Y1, Y3-join, Y6–Y10, Y14, R4 char codes, array joins, "
    "`data:` strings, `top[k]`, `new (window[k])`) are refused in the suite with a model that always says PASS. What "
    "still reaches the model: identifiers (< 40 chars, no lexicon word, no two bare words in a row) separated by code "
    "punctuation, numbers, and deletion-only diffs (pinned as residual). The rest of this cell is v1.4.13's account. "
    "Injection needs **text** the model reads. ")
rep_line("| **The daily merge cap counts PASS comments** (REVIEW-7 SF-3) |",
         "| **The daily merge cap** (REVIEW-7 SF-3; G0 finding 4) | Low / low | **v1.4.14: the cap counts `github-actions[bot]` "
         "commit statuses `m2/pass/<date>` on `979e5fc8`**, written before exit 0, read back and re-counted; statuses "
         "cannot be edited or deleted, and a forged bot row can only refuse more. It counts passes, an upper bound on "
         "merges | Closed as a comment problem. Remaining: simultaneous passes are re-counted, so the cap holds if GitHub's "
         "status list is consistent across writers [U], as for the ask ledger; asks stay capped at 10 a day |")
rep_line("| **`actions/create-github-app-token@v2` is a moved tag** (v1.4.8, REVIEW-12 SF-9:",
         "| **Third-party actions in the merge path** (v1.4.8 REVIEW-12 SF-9; G0 finding 2) | — | **v1.4.14: pinned.** "
         "`actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349` (`v2` = `v2.2.2`), "
         "`actions/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b` (`v7` = `v7.1.0`), `actions/checkout@11d5960a…` "
         "(v4.4.0); a test fails if any `uses:` in either workflow is not a full commit | Closed. A pinned commit can still "
         "carry a bug; moving a pin is a workflow edit Jon reviews |")
rep("| **A model PASS on a §5 step 6 defect leg merges and deploys a real defect** (v1.4.8, REVIEW-12 MF-Z; **(g4) brought inside it in v1.4.9, REVIEW-13**) | Medium / high, for the length of step 6 only | ",
    "| **A model PASS on a §5 step 6 defect leg merges and deploys a real defect** (v1.4.8, REVIEW-12 MF-Z; **(g4) brought inside it in v1.4.9, REVIEW-13**) | Medium / high, for the length of step 6 only | "
    "**v1.4.14: (g1)–(g4) are refused before the model, so only (e) and (f) can reach a model PASS.** ")

# ── 12. history compression (the history is verbatim in M2-PACK-v1.4.13.md on v3/main) ──
OLD = ["v1.1 (REVIEW-1", "v1.2 (REVIEW-2", "v1.2.1 (REVIEW-2", "v1.2.2 (a correction",
       "v1.3 (REVIEW-3", "v1.3.1 (REVIEW-4", "v1.4 (bot-account", "v1.4.1 (REVIEW-5",
       "v1.4.2 (REVIEW-6", "v1.4.3 (REVIEW-7", "v1.4.4 (REVIEW-8"]
N_COMPRESS = int(sys.argv[7]) if len(sys.argv) > 7 else len(OLD)
for tag in OLD[:N_COMPRESS]:
    head = "## What changed in " + tag
    i = s.index(head)
    eol = s.index("\n", i)
    j = s.index("\n## ", eol)
    s = s[: eol + 1] + ("\nKept verbatim in `docs/m2/M2-PACK-v1.4.13.md` (on `v3/main`) under this heading; "
                        "not repeated here (v1.4.14, G0 cost cap).\n") + s[j:]

out = f"{pack_dir}/M2-PACK-v1.4.14.md"
open(out, "w", encoding="utf-8").write(s)
b = s.encode("utf-8")
print(len(b), hashlib.sha256(b).hexdigest())
