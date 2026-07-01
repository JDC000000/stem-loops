"""Set an R2 object-lifecycle backstop so user content can't outlive its TTL.

Uploaded source files and generated loops are ephemeral (7-day active TTL via
jobs.expires_at + the T33 cleanup). This lifecycle rule is the belt-and-braces
backstop (PRD §6.1: no user content beyond TTL) — R2 auto-expires every object a
day past the active window, so a missed cleanup or an abandoned upload can't
linger as free storage. Idempotent. Reuses the worker's R2 client config.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from worker.storage.r2_uploader import _r2  # noqa: E402

# 7-day active TTL + 1 day margin. Everything in this bucket is ephemeral job I/O.
EXPIRE_DAYS = int(os.environ.get("R2_LIFECYCLE_EXPIRE_DAYS", "8"))


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
