from __future__ import annotations

import hashlib
import json
from typing import Any


def strong_json_etag(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    digest = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    return f'"sha256:{digest}"'


def if_none_match_contains(value: str | None, etag: str) -> bool:
    if value is None:
        return False
    candidates = [part.strip() for part in value.split(",")]
    if "*" in candidates:
        return True
    weak = f"W/{etag}"
    return etag in candidates or weak in candidates
