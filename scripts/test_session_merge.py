"""Offline tests for scripts/session-merge.sh (shared A/B merge wrapper + #414 unread-note ACK guard).

`gh`, `date` and `sleep` are stubbed via PATH: `gh` serves #414 pages and PR files from a fixture JSON state file and records every
POST; `date` without -d answers a fixed FAKE_NOW; `sleep` is a no-op. A run that passes every pre-claim check posts its CLAIM, then the
stub refuses the un-draft call, so an allowed claim is observed as exit 4 + CLAIM + RELEASE; nothing past the un-draft is reached.
Run: python3 -m pytest scripts/test_session_merge.py -q
"""
import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from datetime import datetime, timedelta, timezone

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "session-merge.sh")
SHA = "0123456789abcdef0123456789abcdef01234567"
REAL_DATE = subprocess.run(["bash", "-c", "command -v date"], capture_output=True, text=True).stdout.strip()

GH_STUB = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
st_path = os.environ["GH_STATE"]
st = json.load(open(st_path))
a = sys.argv[1:]
assert a and a[0] == "api", a
a = a[1:]
method, fields, jqx, path = "GET", {}, None, None
i = 0
while i < len(a):
    x = a[i]
    if x == "-X": method = a[i + 1]; i += 2
    elif x in ("-f", "-F"):
        k, v = a[i + 1].split("=", 1)
        if x == "-F" and v.startswith("@"): v = open(v[1:]).read()
        fields[k] = v; i += 2
    elif x == "--jq": jqx = a[i + 1]; i += 2
    else: path = x; i += 1
st.setdefault("calls", []).append([method, path])
def save(): json.dump(st, open(st_path, "w"))
def out(obj):
    save()
    s = json.dumps(obj)
    if jqx is not None:
        p = subprocess.run(["jq", "-r", jqx], input=s, capture_output=True, text=True)
        sys.stdout.write(p.stdout); sys.exit(p.returncode)
    sys.stdout.write(s); sys.exit(0)
def fail(msg): save(); sys.stderr.write(msg + "\n"); sys.exit(1)
R = "repos/JDC000000/stem-loops/"
if path == R + "issues/414" and method == "GET":
    if st.get("fail_414"): fail("HTTP 404: Not Found")
    out({"comments": len(st["comments"])})
if path.startswith(R + "issues/414/comments") and method == "GET":
    page = int(path.split("&page=")[1])
    out(st["comments"][100 * (page - 1):100 * page])
if path == R + "issues/414/comments" and method == "POST":
    cid = max([c["id"] for c in st["comments"]] + [1000]) + 1
    ts = subprocess.run([os.environ["REAL_DATE"], "-u", "-d", "@" + open(os.environ["FAKE_CLOCK"]).read().strip(), "+%Y-%m-%dT%H:%M:%SZ"],
                        capture_output=True, text=True).stdout.strip()
    st["comments"].append({"id": cid, "created_at": ts, "body": fields["body"]})
    st.setdefault("posts", []).append(fields["body"])
    inj = st.pop("inject_on_post", None)
    if inj:
        st["comments"].append({"id": cid + 1, "created_at": ts, "body": inj})
    if st.get("fail_release_post") and fields["body"].startswith("RELEASE"):
        st["comments"].pop(); st["posts"].pop(); st.setdefault("release_attempts", []).append(fields["body"])
        fail("HTTP 422: refused")
    if st.get("post_5xx_once"):
        st["post_5xx_once"] = False; fail("HTTP 502: Bad Gateway")
    out({"id": cid})
if path.startswith(R + "pulls?state=open") and method == "GET" and "open_prs" in st:
    out([{"number": n} for n in st["open_prs"]])
if "/files" in path and "/pulls/" in path:
    n = path.split("/pulls/")[1].split("/")[0]
    if n in st.get("pr_files", {}):
        out([{"filename": f} for f in st["pr_files"][n]])
    out([{"filename": f} for f in st.get("files", [])])
if st.get("tail"):
    HEAD, MERGE = "a" * 40, "b" * 40
    merged = os.path.exists(st_path + ".merged")
    if path.endswith("/ccr/ready_for_review") and method == "POST": out({"draft": False})
    if path == R + "pulls/500" and method == "GET":
        out({"head": {"sha": HEAD}, "merged": merged, "merge_commit_sha": MERGE if merged else None})
    if path.startswith(R + "compare/v3/main..."): out({"behind_by": 0})
    if path == R + "issues/500/comments" and method == "POST":
        st.setdefault("pr_posts", []).append(fields["body"]); out({"id": 1})
    if "/check-runs" in path:
        sha = path.split("/commits/")[1].split("/")[0]
        adv = st.pop("advance_on_pr_ci", 0) if sha == HEAD else 0
        if adv:
            ck = os.environ["FAKE_CLOCK"]; t0 = int(open(ck).read()); open(ck, "w").write(str(t0 + adv))
        inj = st.pop("inject_on_pr_ci", None) if sha == HEAD else None
        if inj:
            st["comments"].append({"id": 9000 + len(st["comments"]), "created_at": "2026-11-26T17:05:00Z", "body": inj})
        kind = st.get("pr_ci", "green") if sha == HEAD else st.get("main_ci", "green")
        runs = [{"status": "completed", "conclusion": "success"} for _ in range(12)]
        if kind == "red": runs[3]["conclusion"] = "failure"
        if kind == "unknown": runs[3] = {"status": "in_progress", "conclusion": None}
        out({"check_runs": runs})
if st.get("ready_ok"):
    if path.endswith("/ccr/ready_for_review") and method == "POST": out({"draft": False})
    if path == R + "pulls/500" and method == "GET": out({"head": {"sha": "a" * 40}})
    if path.startswith(R + "compare/v3/main..."): out({"behind_by": 1})
    if path == R + "pulls/500/update-branch" and method == "PUT": out({"message": "Updating pull request branch."})
fail("HTTP 422: stub refuses " + method + " " + path)
'''

DATE_STUB = '''#!/usr/bin/env bash
for x in "$@"; do case "$x" in -d|-d*|--date*) exec "$REAL_DATE" "$@";; esac; done
exec "$REAL_DATE" -d "@$(cat "$FAKE_CLOCK")" "$@"
'''

GIT_STUB = '''#!/usr/bin/env bash
echo "$*" >> "$GH_STATE.git.log"
case " $* " in
  *" fetch "*) [ -e "$GH_STATE.fetchfail" ] && exit 128; exit 0;;
  *" show "*) cat "$GH_STATE.gate.sh"; exit 0;;
  *" checkout "*) exit 0;;
esac
exit 1
'''

FAKE_GATE = '''#!/usr/bin/env bash
echo "DRY_RUN=${DRY_RUN:-} JON_ROW=$JON_ROW JON_PR=$JON_PR $*" >> "$GH_STATE.gate.log"
if [ "${DRY_RUN:-0}" = 1 ]; then cat "$GH_STATE.dry"; exit "$(cat "$GH_STATE.dryrc")"; fi
touch "$GH_STATE.merged"; echo "merged"
'''

# the wrapper does `cd /home/claude/stem-loops` before the gate; in tests that cd goes to a temp dir (sourced via BASH_ENV)
CD_SHIM = '''cd(){ if [ "${1:-}" = /home/claude/stem-loops ]; then builtin cd "$TEST_CLONE"; else builtin cd "$@"; fi; }
'''


def ts(s):
    return int(datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())


def iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


DAY = "2026-11-26"  # before the freeze


def at(hhmm, day=DAY):
    return ts(f"{day}T{hhmm}:00Z")


class Harness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        b = os.path.join(self.tmp, "bin")
        os.mkdir(b)
        for name, body in (("gh", GH_STUB), ("date", DATE_STUB), ("sleep", "#!/bin/sh\nexit 0\n"), ("git", GIT_STUB)):
            p = os.path.join(b, name)
            with open(p, "w") as f:
                f.write(body)
            os.chmod(p, 0o755)
        self.bin = b
        self.rv1 = os.path.join(self.tmp, "r1.md")
        self.rv2 = os.path.join(self.tmp, "r2.md")
        for p in (self.rv1, self.rv2):
            with open(p, "w") as f:
                f.write(p)
        self.state = os.path.join(self.tmp, "state.json")
        self.clock = os.path.join(self.tmp, "clock")
        self.clone = os.path.join(self.tmp, "clone")
        os.mkdir(self.clone)
        self.bash_env = os.path.join(self.tmp, "bash_env")
        with open(self.bash_env, "w") as f:
            f.write(CD_SHIM)
        with open(self.state + ".gate.sh", "w") as f:
            f.write(FAKE_GATE)
        self.set_dry("DRY_RUN fail=0 (no merge)\n", 0)

    def set_dry(self, text, rc):
        with open(self.state + ".dry", "w") as f:
            f.write(text)
        with open(self.state + ".dryrc", "w") as f:
            f.write(str(rc))

    def side(self, ext):
        p = self.state + ext
        return open(p).read().splitlines() if os.path.exists(p) else []

    def run_sm(self, tag, now, comments=(), files=("apps/web/x.ts",), args=None, extra=None, **st):
        state = {"comments": [dict(c) for c in comments], "files": list(files)}
        state.update(st)
        with open(self.state, "w") as f:
            json.dump(state, f)
        with open(self.clock, "w") as f:
            f.write(str(now))
        env = {k: v for k, v in os.environ.items() if k not in ("ALLOW_WINDOW", "BLOCKER", "ACK_SINCE", "JON_ROW")}
        env.update(PATH=self.bin + os.pathsep + env["PATH"], GH_STATE=self.state, FAKE_CLOCK=self.clock, REAL_DATE=REAL_DATE,
                   BASH_ENV=self.bash_env, TEST_CLONE=self.clone,
                   SESSION_TAG=tag, BASE=os.path.join(self.tmp, "base"))
        env.update(extra or {})
        argv = args if args is not None else ["500", SHA, self.rv1, self.rv2]
        p = subprocess.run(["bash", SCRIPT, *argv], capture_output=True, text=True, env=env, timeout=60)
        with open(self.state) as f:
            self.st = json.load(f)
        self.posts = self.st.get("posts", [])
        return p

    def assertClaimed(self, p, tag="23A"):
        self.assertEqual(p.returncode, 4, p.stdout + p.stderr)
        self.assertTrue(self.posts and self.posts[0].startswith(f"CLAIM {tag} #500 until "), self.posts)
        self.assertEqual(self.posts[-1], f"RELEASE {tag} #500 not merged (un-draft refused)")

    def assertRefused(self, p, rc=3, text=None):
        self.assertEqual(p.returncode, rc, p.stdout + p.stderr)
        self.assertFalse(any(x.startswith("CLAIM") for x in self.posts), self.posts)
        if text:
            self.assertIn(text, p.stdout + p.stderr)


def c(cid, when, body):
    return {"id": cid, "created_at": iso(when) if isinstance(when, int) else when, "body": body}


class Usage(Harness):
    def test_bad_tags(self):
        for tag in ("23C", "23", "3A", "23a", "123A", ""):
            with self.subTest(tag=tag):
                self.assertEqual(self.run_sm(tag, at("15:00")).returncode, 2)

    def test_same_review_file_twice(self):
        self.assertEqual(self.run_sm("23A", at("15:00"), args=["500", SHA, self.rv1, self.rv1]).returncode, 2)

    def test_short_sha(self):
        self.assertEqual(self.run_sm("23A", at("15:00"), args=["500", SHA[:7], self.rv1, self.rv2]).returncode, 2)

    def test_bad_ack_since(self):
        self.assertEqual(self.run_sm("23A", at("15:00"), extra={"ACK_SINCE": "not-a-date"}).returncode, 2)

    def test_no_tmp_leak_on_early_exits(self):
        td = os.path.join(self.tmp, "tmpdir")
        os.mkdir(td)
        cases = (["500", SHA, self.rv1, self.rv1], ["500", SHA[:7], self.rv1, self.rv2], ["x", SHA, self.rv1, self.rv2], ["500"],
                 ["ack"], ["ack", "7x"], ["ack", "4242"])
        for argv in cases:
            with self.subTest(argv=argv):
                self.assertEqual(self.run_sm("23A", at("15:00"), args=argv, extra={"TMPDIR": td}).returncode, 2)
                self.assertEqual(os.listdir(td), [])
        self.run_sm("23A", at("14:00"), extra={"TMPDIR": td})  # protocol refusal (exit 3)
        self.assertEqual(os.listdir(td), [])

    def test_414_unreadable(self):
        p = self.run_sm("23A", at("15:00"), fail_414=True)
        self.assertRefused(p, rc=11)


class ABlocks(Harness):
    """A claims only when [now, now+40m] fits inside 15:00-17:00Z or 21:00-22:00Z."""

    def test_allowed(self):
        for hhmm in ("15:00", "15:30", "16:20", "21:00", "21:20"):
            with self.subTest(hhmm=hhmm):
                self.assertClaimed(self.run_sm("23A", at(hhmm)))

    def test_refused(self):
        for hhmm in ("14:59", "16:21", "16:59", "17:00", "20:59", "21:21", "21:59", "22:00", "03:00"):
            with self.subTest(hhmm=hhmm):
                self.assertRefused(self.run_sm("23A", at(hhmm)), text="outside every A block")

    def test_one_second_past_fit(self):
        self.assertRefused(self.run_sm("23A", at("16:20") + 1))
        self.assertRefused(self.run_sm("23A", at("15:00") - 1))


class BBlocks(Harness):
    """B claims only when [now, now+40m] touches no A block."""

    def test_allowed(self):
        for hhmm in ("14:20", "17:00", "17:20", "18:30", "20:20", "22:00", "22:20", "23:30", "03:00"):
            with self.subTest(hhmm=hhmm):
                self.assertClaimed(self.run_sm("23B", at(hhmm)), tag="23B")

    def test_refused_a_block(self):
        for hhmm in ("14:21", "15:00", "16:59", "20:21", "21:30", "21:59"):
            with self.subTest(hhmm=hhmm):
                self.assertRefused(self.run_sm("23B", at(hhmm)), text="A block")

    def test_allow_window_waives_block_only(self):
        self.assertClaimed(self.run_sm("23B", at("15:30"), extra={"ALLOW_WINDOW": "4242"}), tag="23B")
        self.assertRefused(self.run_sm("23B", at("18:10"), extra={"ALLOW_WINDOW": "4242"}), text="DEPLOY slot")

    def test_allow_window_must_be_numeric(self):
        self.assertEqual(self.run_sm("23B", at("15:30"), extra={"ALLOW_WINDOW": "yes"}).returncode, 2)


class DeploySlots(Harness):
    def test_b_refused(self):
        for hhmm in ("17:21", "18:00", "18:29", "22:21", "23:00", "23:29"):
            with self.subTest(hhmm=hhmm):
                self.assertRefused(self.run_sm("23B", at(hhmm)), text="DEPLOY slot")

    def test_a_refused_even_with_allow_window(self):
        for hhmm in ("17:21", "18:00", "18:29", "23:10"):
            with self.subTest(hhmm=hhmm):
                self.assertRefused(self.run_sm("23A", at(hhmm), extra={"ALLOW_WINDOW": "4242"}), text="DEPLOY slot")

    def test_a_allow_window_outside_slots(self):
        self.assertClaimed(self.run_sm("23A", at("19:00"), extra={"ALLOW_WINDOW": "4242"}))

    def test_slot_across_midnight_boundary(self):
        # 23B at 22:51 → window ends 23:31, touching the 23:00 slot of the same day
        self.assertRefused(self.run_sm("23B", at("22:51")), text="DEPLOY slot")


class LiveClaims(Harness):
    def test_other_session_claim_live(self):
        cm = [c(1, at("16:50"), "CLAIM 23A #400 until 2026-11-26T17:30Z")]
        self.assertRefused(self.run_sm("23B", at("17:00"), cm), text="OTHER LIVE")

    def test_other_session_claim_released(self):
        cm = [c(1, at("16:50"), "CLAIM 23A #400 until 2026-11-26T17:30Z"), c(2, at("16:55"), "RELEASE 23A #400 merged abc1234")]
        self.assertClaimed(self.run_sm("23B", at("17:00"), cm), tag="23B")

    def test_release_of_other_pr_does_not_end_claim(self):
        cm = [c(1, at("16:50"), "CLAIM 23A #400 until 2026-11-26T17:30Z"), c(2, at("16:55"), "RELEASE 23A #401 merged")]
        self.assertRefused(self.run_sm("23B", at("17:00"), cm), text="OTHER LIVE")

    def test_other_session_claim_expired(self):
        cm = [c(1, at("16:00"), "CLAIM 23A #400 until 2026-11-26T16:40Z")]
        self.assertClaimed(self.run_sm("23B", at("17:00"), cm), tag="23B")

    def test_b_claim_blocks_a(self):
        cm = [c(1, at("14:50"), "CLAIM 23B #400 until 15:30Z")]
        self.assertRefused(self.run_sm("23A", at("15:10"), cm), text="OTHER LIVE")

    def test_own_claim_ignored(self):
        cm = [c(1, at("14:50"), "CLAIM 23A #400 until 15:30Z")]
        self.assertClaimed(self.run_sm("23A", at("15:10"), cm))

    def test_jon_deploy_live(self):
        cm = [c(1, at("16:55"), "DEPLOY Jon abc1234 until 2026-11-26T17:45Z")]
        self.assertRefused(self.run_sm("23B", at("17:00"), cm), text="OTHER LIVE")

    def test_untagged_lines_fail_closed(self):
        for body in ("CLAIM #400 until 2026-11-26T17:30Z", "CLAIM someone #400 until 2026-11-26T17:30Z",
                     "DEPLOY abc1234 until 2026-11-26T17:30Z", "CLAIM 23C #400"):
            with self.subTest(body=body):
                self.assertRefused(self.run_sm("23B", at("17:00"), [c(1, at("16:55"), body)]), text="OTHER LIVE")

    def test_untagged_release_releases_nothing(self):
        cm = [c(1, at("16:50"), "CLAIM 23A #400 until 2026-11-26T17:30Z"), c(2, at("16:55"), "RELEASE #400 merged")]
        self.assertRefused(self.run_sm("23B", at("17:00"), cm), text="OTHER LIVE")

    def test_unparsable_until_lives_120_min(self):
        cm = [c(1, at("12:00"), "CLAIM 23A #400 until later")]
        self.assertRefused(self.run_sm("23B", at("13:59"), cm), text="OTHER LIVE")
        self.assertClaimed(self.run_sm("23B", at("14:01"), cm), tag="23B")


class UnreadNotes(Harness):
    def test_note_blocks(self):
        for head in ("NOTE", "PROTOCOL", "QUEUE", "note", "**NOTE**", "> QUEUE:"):
            with self.subTest(head=head):
                cm = [c(77, at("16:00"), f"{head} 23B please read\nmore text")]
                p = self.run_sm("23A", at("16:10"), cm)
                self.assertRefused(p, rc=13)
                self.assertIn(f"77 {head} 23B please read", p.stdout)

    def test_ack_clears(self):
        cm = [c(77, at("16:00"), "NOTE 23B please read"), c(78, at("16:05"), "ACK 23A 77")]
        self.assertClaimed(self.run_sm("23A", at("16:10"), cm))

    def test_ack_list_and_other_line(self):
        cm = [c(77, at("16:00"), "PROTOCOL 23B new times"), c(78, at("16:05"), "context\nACK 23A 12,77,90\n")]
        self.assertClaimed(self.run_sm("23A", at("16:10"), cm))

    def test_ack_of_another_id_does_not_clear(self):
        cm = [c(77, at("16:00"), "NOTE 23B please read"), c(78, at("16:05"), "ACK 23A 7,770")]
        p = self.run_sm("23A", at("16:10"), cm)
        self.assertRefused(p, rc=13)
        self.assertIn("77 NOTE 23B please read", p.stdout)

    def test_ack_by_other_session_does_not_clear(self):
        cm = [c(77, at("16:00"), "NOTE Jon read this"), c(78, at("16:05"), "ACK 23B 77")]
        self.assertRefused(self.run_sm("23A", at("16:10"), cm), rc=13)

    def test_own_note_not_required(self):
        for body in ("NOTE 23A for the other side", "QUEUE 23A #500 #501", "**NOTE** 23A hold"):
            with self.subTest(body=body):
                self.assertClaimed(self.run_sm("23A", at("16:10"), [c(77, at("16:00"), body)]))

    def test_own_tag_with_punctuation_not_exempt(self):
        for body in ("NOTE 23B: please hold", "NOTE 23B, hold", "NOTE (23B) hold"):
            with self.subTest(body=body):
                p = self.run_sm("23B", at("17:10"), [c(77, at("17:00"), body)])
                self.assertRefused(p, rc=13)
                self.assertIn("77 " + body, p.stdout)

    def test_other_note_while_own_acked(self):
        cm = [c(77, at("16:00"), "NOTE 23B one"), c(79, at("16:01"), "QUEUE Jon two"), c(78, at("16:05"), "ACK 23A 77")]
        p = self.run_sm("23A", at("16:10"), cm)
        self.assertRefused(p, rc=13)
        self.assertIn("79 QUEUE Jon two", p.stdout)
        self.assertNotIn("77 NOTE", p.stdout)

    def test_non_note_lines_ignored(self):
        cm = [c(77, at("16:00"), "NOTES are below"), c(78, at("16:00"), "Context: NOTE 23B inside"), c(79, at("16:00"), "RELEASE 23B #1 merged")]
        self.assertClaimed(self.run_sm("23A", at("16:10"), cm))

    def test_ack_since_cutoff(self):
        cm = [c(77, at("15:00"), "NOTE 23B old")]
        self.assertRefused(self.run_sm("23A", at("16:10"), cm), rc=13)
        self.assertClaimed(self.run_sm("23A", at("16:10"), cm, extra={"ACK_SINCE": "2026-11-26T15:30:00Z"}))
        self.assertRefused(self.run_sm("23A", at("16:10"), cm, extra={"ACK_SINCE": "2026-11-26T15:00:00Z"}), rc=13)

    def test_two_page_window(self):
        filler = [c(2000 + i, at("10:00") + i, f"chatter {i}") for i in range(250)]
        old = list(filler)
        old[10] = c(77, at("10:00") + 10, "NOTE 23B on page 1")  # page 1 of 3: outside the last two pages
        self.assertClaimed(self.run_sm("23A", at("16:10"), old))
        recent = list(filler)
        recent[110] = c(77, at("10:00") + 110, "NOTE 23B on page 2")
        self.assertRefused(self.run_sm("23A", at("16:10"), recent), rc=13)

    def test_note_blocks_b_too(self):
        cm = [c(77, at("16:00"), "NOTE 23A merges paused")]
        self.assertRefused(self.run_sm("23B", at("17:10"), cm), rc=13)
        self.assertClaimed(self.run_sm("23B", at("17:10"), cm + [c(78, at("16:30"), "ACK 23B 77")]), tag="23B")


NOTES = [c(77, at("16:00"), "NOTE 23B one"), c(79, at("16:01"), "**QUEUE** Jon two"), c(80, at("16:02"), "CLAIM 23B #9 until 16:40Z"),
         c(81, at("16:03"), "plain chatter\nNOTE on line 2")]


class AckSubcommand(Harness):
    def test_posts_one_line(self):
        p = self.run_sm("23A", at("16:10"), NOTES, args=["ack", "77", "79", "77"])
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(self.posts, ["ACK 23A 77,79"])

    def test_bad_id(self):
        for argv in (["ack"], ["ack", "77x"], ["ack", "-1"]):
            with self.subTest(argv=argv):
                self.assertEqual(self.run_sm("23A", at("16:10"), args=argv).returncode, 2)
                self.assertEqual(self.posts, [])

    def test_5xx_read_back_no_double_post(self):
        p = self.run_sm("23B", at("16:10"), NOTES, args=["ack", "77"], post_5xx_once=True)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(self.posts, ["ACK 23B 77"])

    def test_real_id_ok_unknown_and_non_note_refused(self):
        self.assertEqual(self.run_sm("23A", at("16:10"), NOTES, args=["ack", "79"]).returncode, 0)
        self.assertEqual(self.posts, ["ACK 23A 79"])
        for argv in (["ack", "4242"], ["ack", "80"], ["ack", "81"], ["ack", "77", "80"], ["ack", "77", "4242"]):
            with self.subTest(argv=argv):
                p = self.run_sm("23A", at("16:10"), NOTES, args=argv)
                self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
                self.assertIn("nothing posted", p.stdout)
                self.assertEqual(self.posts, [])

    def test_id_outside_two_page_window_refused(self):
        cm = [c(2000 + i, at("10:00") + i, f"chatter {i}") for i in range(250)]
        cm[10] = c(77, at("10:00") + 10, "NOTE 23B on page 1")
        self.assertEqual(self.run_sm("23A", at("16:10"), cm, args=["ack", "77"]).returncode, 2)
        self.assertEqual(self.posts, [])

    def test_ack_then_claim(self):
        cm = [c(77, at("16:00"), "NOTE 23B please read")]
        self.run_sm("23A", at("16:05"), cm, args=["ack", "77"])
        self.assertClaimed(self.run_sm("23A", at("16:10"), self.st["comments"]))


class AbandonInfo(Harness):
    def test_race_posts_info_not_note(self):
        # another session's claim appears right after ours: the trap posts INFO (not a RELEASE, not a NOTE)
        p = self.run_sm("23B", at("17:00"), inject_on_post="CLAIM 23A #400 until 2026-11-26T17:40Z")
        self.assertEqual(p.returncode, 3, p.stdout + p.stderr)
        self.assertIn("race:", p.stdout)
        self.assertEqual(self.posts[-1], "INFO 23B #500 window abandoned (another session's claim is live; this is not a RELEASE)")
        self.assertFalse(any(x.startswith(("NOTE", "RELEASE")) for x in self.posts), self.posts)
        later = [x for x in self.st["comments"] if not x["body"].startswith("CLAIM")]
        self.assertClaimed(self.run_sm("23A", at("16:00"), later))

    def test_info_line_needs_no_ack_and_cannot_be_acked(self):
        cm = [c(77, at("16:00"), "INFO 23B #9 window abandoned (another session's claim is live; this is not a RELEASE)")]
        self.assertClaimed(self.run_sm("23A", at("16:10"), cm))
        self.assertEqual(self.run_sm("23A", at("16:10"), cm, args=["ack", "77"]).returncode, 2)


class UndraftOrder(Harness):
    def test_undraft_once_before_update_branch(self):
        p = self.run_sm("23A", at("15:00"), ready_ok=True)
        self.assertEqual(p.returncode, 5, p.stdout + p.stderr)
        calls = [f"{m} {x}" for m, x in self.st["calls"]]
        rd = [i for i, x in enumerate(calls) if x == "POST repos/JDC000000/stem-loops/pulls/500/ccr/ready_for_review"]
        ub = [i for i, x in enumerate(calls) if x == "PUT repos/JDC000000/stem-loops/pulls/500/update-branch"]
        self.assertEqual(len(rd), 1, calls)
        self.assertEqual(len(ub), 1, calls)
        self.assertLess(rd[0], ub[0])
        self.assertEqual(self.posts[-1], "RELEASE 23A #500 not merged (update-branch)")


class Tail(Harness):
    """End-to-end past the un-draft: B session at 17:00Z on 2026-11-26 (claim window 17:00-17:40Z)."""
    NOW = at("17:00")
    PR_TAIL = ["VERDICT body r1", "VERDICT body r2"]

    def go(self, **st):
        return self.run_sm("23B", self.NOW, tail=True, **st)

    def test_happy_path(self):
        p = self.go()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertEqual(self.posts[0][:20], "CLAIM 23B #500 until")
        self.assertEqual(self.posts[-1], "RELEASE 23B #500 merged bbbbbbb")
        gl = self.side(".gate.log")
        self.assertEqual(len(gl), 2, gl)
        self.assertTrue(gl[0].startswith("DRY_RUN=1 JON_ROW=95 JON_PR=500 500 "), gl)
        self.assertTrue(gl[1].startswith("DRY_RUN= JON_ROW=95 JON_PR=500 500 "), gl)  # exactly one real run
        self.assertIn(SHA, gl[1])
        pr = self.st.get("pr_posts", [])
        self.assertEqual(len(pr), 3, pr)
        self.assertEqual(pr[0], self.rv1)
        self.assertEqual(pr[1], self.rv2)
        self.assertEqual(pr[2], "```\nDRY_RUN fail=0 (no merge)\n```\n")
        git = self.side(".git.log")
        self.assertTrue(any(" fetch " in f" {x} " for x in git) and any("checkout" in x for x in git), git)

    def test_unread_note_between_claim_and_gate(self):
        p = self.go(inject_on_pr_ci="NOTE 23A hold merges")
        self.assertEqual(p.returncode, 13, p.stdout + p.stderr)
        self.assertIn("NOTE 23A hold merges", p.stdout)
        self.assertEqual(self.posts[-1], "RELEASE 23B #500 not merged (unread #414 note)")
        self.assertEqual(self.side(".git.log"), [])
        self.assertEqual(self.side(".gate.log"), [])

    def test_own_claim_expiring_at_pre_gate(self):
        p = self.go(advance_on_pr_ci=39 * 60)  # now 17:39, claim until 17:40
        self.assertEqual(p.returncode, 3, p.stdout + p.stderr)
        self.assertEqual(self.posts[-1], "RELEASE 23B #500 not merged (own claim expiring; re-claim)")
        self.assertEqual(self.side(".git.log"), [])

    def test_deploy_slot_at_pre_gate(self):
        # clock jumps into the 18:00Z DEPLOY slot (claim also expired): refused before any git call
        p = self.go(advance_on_pr_ci=65 * 60)
        self.assertEqual(p.returncode, 3, p.stdout + p.stderr)
        self.assertTrue(self.posts[-1].startswith("RELEASE 23B #500 not merged ("), self.posts)
        self.assertEqual(self.side(".git.log"), [])

    def test_window_recheck_protocol_expired_at_pre_gate(self):
        # claim at 23:35Z on 12-18 (valid to 12-19T00:00Z), until 00:15Z; at the pre-gate re-check it is 00:05Z: the claim is not
        # expiring (00:13Z cut-off) but the protocol is: only the pre-gate window re-check refuses
        p = self.run_sm("23B", ts("2026-12-18T23:35:00Z"), files=["docs/x.md"], tail=True, advance_on_pr_ci=30 * 60)
        self.assertEqual(p.returncode, 3, p.stdout + p.stderr)
        self.assertTrue(self.posts[-1].startswith("RELEASE 23B #500 not merged (now: PROTOCOL 2026-11-28 expired"), self.posts)
        self.assertEqual(self.side(".git.log"), [])

    def test_gate_fetch_fails(self):
        open(self.state + ".fetchfail", "w").close()
        p = self.go()
        self.assertEqual(p.returncode, 7, p.stdout + p.stderr)
        self.assertEqual(self.posts[-1], "RELEASE 23B #500 not merged (gate fetch failed)")
        self.assertEqual(self.side(".gate.log"), [])

    def test_dry_run_not_clean(self):
        for text, rc in (("DRY_RUN fail=1 (no merge)\n", 1), ("DRY_RUN fail=1 (no merge)\n", 0), ("FAIL: x\nDRY_RUN\n", 0),
                         ("DRY_RUN fail=0 (no merge)\n", 1), ("DRY_RUN fail=01 (no merge)\n", 0), ("x DRY_RUN fail=0 (no merge)\n", 0), ("", 0)):
            with self.subTest(text=text, rc=rc):
                for ext in (".merged", ".gate.log", ".git.log"):
                    if os.path.exists(self.state + ext):
                        os.remove(self.state + ext)
                self.set_dry(text, rc)
                p = self.go()
                self.assertEqual(p.returncode, 7, p.stdout + p.stderr)
                self.assertTrue(self.posts[-1].startswith("RELEASE 23B #500 not merged (DRY_RUN"), self.posts)
                self.assertEqual(len(self.side(".gate.log")), 1)  # no real run
                self.assertEqual(self.st.get("pr_posts", []), [])

    def test_main_ci_red(self):
        p = self.go(main_ci="red")
        self.assertEqual(p.returncode, 9, p.stdout + p.stderr)
        self.assertIn("MAIN RED", p.stdout)
        self.assertEqual(self.posts[-1], "RELEASE 23B #500 merged bbbbbbb")

    def test_main_ci_unknown(self):
        p = self.go(main_ci="unknown")
        self.assertEqual(p.returncode, 10, p.stdout + p.stderr)
        # CI watch = CI_WATCH_SECS (2400) / 20 = 120 polls, then one final read: 121 check-run reads of the merge commit
        polls = [x for x in self.st["calls"] if x[1].startswith("repos/JDC000000/stem-loops/commits/" + "b" * 40 + "/check-runs")]
        self.assertEqual(len(polls), 121, len(polls))

    def test_release_post_fails_after_merge(self):
        p = self.go(fail_release_post=True)
        self.assertEqual(p.returncode, 12, p.stdout + p.stderr)
        self.assertIn("RELEASE POST FAILED", p.stdout)
        self.assertIn("RELEASE 23B #500 merged bbbbbbb", self.st.get("release_attempts", []))
        self.assertEqual(len(self.side(".gate.log")), 2)

    def test_pr_ci_red(self):
        p = self.go(pr_ci="red")
        self.assertEqual(p.returncode, 6, p.stdout + p.stderr)
        self.assertEqual(self.side(".git.log"), [])


class Freeze(Harness):
    AFTER = "2026-12-01"  # inside the v1.2 freeze [11-30T01:00Z, 12-03T01:00Z)

    def test_apps_frozen_for_both(self):
        self.assertRefused(self.run_sm("23B", at("17:00", self.AFTER)), text="freeze")
        self.assertRefused(self.run_sm("23A", at("15:00", self.AFTER)), text="freeze")

    def test_no_apps_files_not_frozen(self):
        self.assertClaimed(self.run_sm("23B", at("17:00", self.AFTER), files=["packages/ui/a.ts", "docs/x.md"]), tag="23B")
        self.assertClaimed(self.run_sm("23A", at("15:00", self.AFTER), files=["scripts/x.sh"]))

    def test_blocker_lifts_freeze(self):
        self.assertClaimed(self.run_sm("23B", at("17:00", self.AFTER), extra={"BLOCKER": "123"}), tag="23B")

    def test_freeze_boundary(self):
        # v1.2 (Jon L12): frozen from 01:00Z on 11-30 (Sun 18:00 Vancouver). 01:00:00Z is the first frozen second; 00:59:59Z is open.
        self.assertRefused(self.run_sm("23B", ts("2026-11-30T01:00:00Z")), text="freeze")
        self.assertClaimed(self.run_sm("23B", ts("2026-11-30T00:59:59Z"), files=["apps/a.ts"]), tag="23B")

    def test_old_freeze_start_now_open(self):
        # the v1.1 freeze start (11-27 23:00Z) no longer freezes: apps/** PRs can merge on Sat 11-28 (24B's batch)
        self.assertClaimed(self.run_sm("23B", ts("2026-11-27T23:30:00Z")), tag="23B")
        self.assertClaimed(self.run_sm("23B", at("17:00", "2026-11-28")), tag="23B")
        self.assertClaimed(self.run_sm("23A", at("15:00", "2026-11-29")))

    def test_files_listing_capped_fails_closed(self):
        many = [f"docs/{i}.md" for i in range(100)]
        self.assertRefused(self.run_sm("23B", at("17:00", self.AFTER), files=many), text="freeze")

    def test_freeze_ends(self):
        # frozen in [11-27T23:00Z, 12-03T01:00Z): 00:50Z on 12-03 is frozen, 01:00Z and later are not (B windows clear of blocks/slots)
        self.assertRefused(self.run_sm("23B", ts("2026-12-03T00:50:00Z")), text="freeze")
        self.assertRefused(self.run_sm("23B", ts("2026-12-03T00:59:59Z")), text="freeze")  # last frozen second (R1 fable mutant 00:55Z)
        self.assertClaimed(self.run_sm("23B", ts("2026-12-03T01:00:00Z")), tag="23B")
        self.assertClaimed(self.run_sm("23A", at("15:00", "2026-12-03")))

    def test_protocol_expired(self):
        self.assertRefused(self.run_sm("23B", ts("2026-12-19T00:00:00Z"), files=["docs/x.md"]), text="expired")
        self.assertRefused(self.run_sm("23B", ts("2026-12-19T03:00:00Z"), files=["docs/x.md"]), text="PROTOCOL 2026-11-28 expired")
        self.assertClaimed(self.run_sm("23B", ts("2026-12-18T23:40:00Z"), files=["docs/x.md"]), tag="23B")
        self.assertClaimed(self.run_sm("23B", ts("2026-12-03T03:00:00Z"), files=["docs/x.md"]), tag="23B")  # old 12-03 expiry is gone


class SharedFiles(Harness):
    """v1.1: a warning naming other open PRs that share a changed file; never a refusal (B session, 17:00Z on 11-26)."""
    NOW = at("17:00")

    def test_warns_and_still_claims(self):
        p = self.run_sm("23B", self.NOW, files=["apps/web/x.ts", "docs/a.md"], open_prs=[500, 501, 502, 503],
                        pr_files={"501": ["apps/web/x.ts", "docs/y.md"], "502": ["docs/z.md"], "503": ["docs/a.md", "apps/web/x.ts"]})
        self.assertClaimed(p, tag="23B")
        self.assertIn("WARNING: open PR #501 also changes: apps/web/x.ts", p.stdout)
        self.assertIn("WARNING: open PR #503 also changes: apps/web/x.ts docs/a.md", p.stdout)
        self.assertNotIn("#502", p.stdout)
        self.assertNotIn("#500 also", p.stdout)

    def test_no_overlap_no_warning(self):
        p = self.run_sm("23B", self.NOW, open_prs=[500, 502], pr_files={"502": ["docs/z.md"]})
        self.assertClaimed(p, tag="23B")
        self.assertNotIn("WARNING", p.stdout)

    def test_unreadable_listing_is_skipped_not_refused(self):
        p = self.run_sm("23B", self.NOW)  # stub refuses the open-PR listing
        self.assertClaimed(p, tag="23B")
        self.assertIn("WARN shared-file check skipped (open PRs unreadable)", p.stdout)

    def test_warning_before_unread_note_exit(self):
        p = self.run_sm("23B", self.NOW, comments=[c(7, at("16:00"), "NOTE 23A hold")], open_prs=[500, 501], pr_files={"501": ["apps/web/x.ts"]})
        self.assertRefused(p, rc=13)
        self.assertIn("WARNING: open PR #501 also changes: apps/web/x.ts", p.stdout)


if __name__ == "__main__":
    unittest.main()
