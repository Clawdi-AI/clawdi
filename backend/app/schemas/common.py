from __future__ import annotations

from pydantic import BaseModel, Field


class Paginated[T](BaseModel):
    """Generic wrapper for paginated list responses.

    Clients can read `total` to render page counters and `items` for the row
    content. `page` is 1-based to match what UIs show ("Page 1 of 4").
    """

    items: list[T]
    total: int = Field(..., ge=0)
    page: int = Field(..., ge=1)
    page_size: int = Field(..., ge=1, le=200)
