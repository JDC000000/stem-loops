"""Set R2 bucket CORS: browser fetches loop WAVs (GET/HEAD, P3-4) AND uploads the
source file via presigned PUT (file-upload MVP — the browser PUTs direct to R2).

Allows GET/HEAD/PUT from the production origin + localhost dev. Run once per bucket
(idempotent). Reuses the worker's R2 client config (endpoint from R2_ENDPOINT_URL,
else built from R2_ACCOUNT_ID).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from worker.storage.r2_uploader import _r2  # noqa: E402

ALLOWED_ORIGINS = [
    "https://stem-loops.com",
    "https://www.stem-loops.com",
    "http://localhost:3000",
]


def run() -> None:
    _r2().put_bucket_cors(
        Bucket=os.environ["R2_BUCKET_NAME"],
        CORSConfiguration={
            "CORSRules": [
                {
                    "AllowedOrigins": ALLOWED_ORIGINS,
                    # PUT: presigned direct-to-R2 source upload. GET/HEAD: loop audition/zip.
                    "AllowedMethods": ["GET", "HEAD", "PUT"],
                    "AllowedHeaders": ["*"],
                    "ExposeHeaders": ["ETag"],
                    "MaxAgeSeconds": 3600,
                }
            ]
        },
    )
    print("R2 CORS configured (GET/HEAD/PUT) for:", ", ".join(ALLOWED_ORIGINS))


if __name__ == "__main__":
    run()
