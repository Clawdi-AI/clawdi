from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator

HostedRuntimeLanguage = Literal[
    "en",
    "zh-CN",
    "zh-TW",
    "ja",
    "ko",
    "es",
    "fr",
    "de",
    "pt",
]


class HostedRuntimeLocale(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: HostedRuntimeLanguage
    timezone: str = Field(min_length=1, max_length=255)

    @field_validator("timezone")
    @classmethod
    def _validate_timezone(cls, value: str) -> str:
        if value != value.strip():
            raise ValueError("timezone must not contain surrounding whitespace")
        try:
            ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError) as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc
        return value
