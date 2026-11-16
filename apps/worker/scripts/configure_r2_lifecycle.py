"""Set the R2 bucket's object-lifecycle rules.

HISTORY. This used to set a WHOLE-BUCKET "expire every object after 2 days" rule as a
belt-and-braces backstop for the 24-hour retention sweep. Since 2026-11-15 Pro and Studio
songs are kept while the subscription is effective plus 30 days (cleanup.RETAINED_UNTIL_SQL),
so an age rule over the whole bucket would delete a subscriber's library on day 2 while the
job row still says "kept": the player would 404 on every stem of a song the site lists.
R2 lifecycle rules filter by key PREFIX only, and job objects are keyed by job id, not by
plan, so no prefix rule can tell a Free song from a paid one.

So by default this script now sets NO expiration rule — only the incomplete-multipart
cleanup, which is never user content. Retention is enforced by the worker's sweep
(apps/worker/src/worker/cleanup.py), which deletes R2 objects itself.

OPERATOR ACTION (once, when deploying paid-plan retention): if the old 2-day rule was ever
applied, it is STILL ACTIVE on the bucket until this script is re-run. Re-run it:
  fly ssh console -a stem-loops -C "python /app/scripts/configure_r2_lifecycle.py"
Check the result in the Cloudflare dashboard (R2 -> bucket -> Settings -> Object lifecycle
rules): there must be no "Delete objects" rule covering the whole bucket.

R2_LIFECYCLE_EXPIRE_DAYS=<n> re-adds a whole-bucket expiration of n days. Only do that if
every paid library may be lost after n days; it is not the product's promise.
Idempotent. Reuses the worker's R2 client config.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from worker.storage.r2_uploader import _r2  # noqa: E402

_RAW = os.environ.get("R2_LIFECYCLE_EXPIRE_DAYS", "").strip()
# None = no whole-bucket expiration (the default; see the module docstring).
EXPIRE_DAYS: int | None = int(_RAW) if _RAW else None


def rules(expire_days: int | None = EXPIRE_DAYS) -> list[dict]:
    """The lifecycle rules this script writes (pure; tested)."""
    out: list[dict] = [
        {
            "ID": "abort-incomplete-multipart",
            "Status": "Enabled",
            "Filter": {"Prefix": ""},
            "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1},
        }
    ]
    if expire_days is not None:
        out.append(
            {
                "ID": "expire-ephemeral-job-io",
                "Status": "Enabled",
                "Filter": {"Prefix": ""},
                "Expiration": {"Days": expire_days},
            }
        )
    return out


def run() -> None:
    _r2().put_bucket_lifecycle_configuration(
        Bucket=os.environ["R2_BUCKET_NAME"],
        LifecycleConfiguration={"Rules": rules()},
    )
    if EXPIRE_DAYS is None:
        print("R2 lifecycle configured: no object expiration (retention is the worker's sweep)")
    else:
        print(f"R2 lifecycle configured: expire ALL objects after {EXPIRE_DAYS} days")


if __name__ == "__main__":
    run()
