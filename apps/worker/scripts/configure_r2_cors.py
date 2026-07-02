"""MERGE required CORS origins into the R2 bucket — never clobber existing ones.

The bucket (stem-loops-audio) is SHARED: Option A staging + Option B both use it,
and PutBucketCors REPLACES the whole config. So this reads the current rules,
appends ONLY the origins that are missing (leaving every existing rule — incl.
the orchestrator's staging origins — untouched), and writes the merged set.
Idempotent: re-running with nothing missing is a no-op.

Browser needs GET/HEAD (loop audition/zip) + PUT (presigned direct-to-R2 upload).

Usage:
    python configure_r2_cors.py [extra_origin ...]   # e.g. https://stem-loops-abc123.vercel.app
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from botocore.exceptions import ClientError  # noqa: E402

from worker.storage.r2_uploader import _r2  # noqa: E402

# Origins THIS app requires. The wildcard covers Vercel preview subdomains; pass the
# exact preview domain as an extra arg at deploy time for browsers that don't honor
# wildcard CORS origins.
REQUIRED_ORIGINS = [
    "https://stem-loops.com",
    "https://www.stem-loops.com",
    "http://localhost:3000",
    "https://*.vercel.app",
]
METHODS = ["GET", "HEAD", "PUT"]


def _existing_rules(s3, bucket: str) -> list:
    try:
        return s3.get_bucket_cors(Bucket=bucket).get("CORSRules", [])
    except ClientError as e:
        if "NoSuchCORSConfiguration" in e.response.get("Error", {}).get("Code", ""):
            return []
        raise


def run() -> None:
    bucket = os.environ["R2_BUCKET_NAME"]
    want = list(dict.fromkeys(REQUIRED_ORIGINS + [a for a in sys.argv[1:] if a.strip()]))
    s3 = _r2()

    rules = _existing_rules(s3, bucket)
    have = {o for r in rules for o in r.get("AllowedOrigins", [])}
    missing = [o for o in want if o not in have]

    if not missing:
        print("CORS already includes all required origins — no change.")
        print("Origins present:", sorted(have))
        return

    # MERGE: keep every existing rule verbatim; append one rule for the missing origins.
    rules.append(
        {
            "AllowedOrigins": missing,
            "AllowedMethods": METHODS,
            "AllowedHeaders": ["*"],
            "ExposeHeaders": ["ETag"],
            "MaxAgeSeconds": 3600,
        }
    )
    s3.put_bucket_cors(Bucket=bucket, CORSConfiguration={"CORSRules": rules})

    after = {o for r in _existing_rules(s3, bucket) for o in r.get("AllowedOrigins", [])}
    print("Added origins:", missing)
    print("CORS now allows (all preserved + new):", sorted(after))


if __name__ == "__main__":
    run()
