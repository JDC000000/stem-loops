"""Set an R2 object-lifecycle backstop so user content can't outlive its TTL.

Uploaded source files and generated loops are ephemeral (24-hour active TTL via
jobs.expires_at + the worker's retention sweep, which deletes R2 objects itself).
This lifecycle rule is only the belt-and-braces backstop (PRD §6.1: no user content
beyond TTL) if the sweep is down. R2 lifecycle rules are DAY-granular, so the minimum
safe backstop is 2 days (a 1-day rule could delete an object a few hours early, while
a job is still live). Idempotent. Reuses the worker's R2 client config.

Run (operator, once, after the 24h worker is deployed; needs the R2_* secrets):
  fly ssh console -a stem-loops -C "python /app/scripts/configure_r2_lifecycle.py"
or locally: cd apps/worker && R2_LIFECYCLE_EXPIRE_DAYS=2 python scripts/configure_r2_lifecycle.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from worker.storage.r2_uploader import _r2  # noqa: E402

# 24h active TTL, rounded up to the day-granular minimum with margin = 2 days.
# Everything in this bucket is ephemeral job I/O.
EXPIRE_DAYS = int(os.environ.get("R2_LIFECYCLE_EXPIRE_DAYS", "2"))


def run() -> None:
    _r2().put_bucket_lifecycle_configuration(
        Bucket=os.environ["R2_BUCKET_NAME"],
        LifecycleConfiguration={
            "Rules": [
                {
                    "ID": "expire-ephemeral-job-io",
                    "Status": "Enabled",
                    "Filter": {"Prefix": ""},  # whole bucket: all objects are job I/O
                    "Expiration": {"Days": EXPIRE_DAYS},
                    "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1},
                }
            ]
        },
    )
    print(f"R2 lifecycle configured: expire all objects after {EXPIRE_DAYS} days")


if __name__ == "__main__":
    run()
