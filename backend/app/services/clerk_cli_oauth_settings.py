"""Typed database contract for Cloud CLI OAuth configuration."""

from __future__ import annotations

from ipaddress import IPv6Address
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

import idna
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator

from app.core.config import canonical_clerk_authorized_party, canonical_clerk_issuer

CLERK_CLI_OAUTH_SETTING_KEY = "clerk_cli_oauth"
CLERK_CLI_OAUTH_SCHEMA_VERSION = 1
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_OBJECT_LIST_ADAPTER = TypeAdapter(list[object], config=ConfigDict(strict=True))


def _trimmed(value: str, *, field_name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field_name} must not be empty")
    if any(character.isspace() for character in normalized):
        raise ValueError(f"{field_name} must not contain whitespace")
    return normalized


def _canonical_authorized_parties(value: object) -> object:
    try:
        items = _OBJECT_LIST_ADAPTER.validate_python(value)
    except ValueError:
        return value
    canonical: set[str] = set()
    for item in items:
        if not isinstance(item, str):
            return value
        if len(item) > 512:
            raise ValueError("authorized_parties entries must be at most 512 characters")
        canonical_party = canonical_clerk_authorized_party(item)
        if not canonical_party:
            raise ValueError("authorized_parties entries must not be empty")
        canonical.add(canonical_party)
    return sorted(canonical)


def canonical_cli_oauth_redirect_uri(value: str) -> str:
    raw = value.strip()
    if "\\" in raw:
        raise ValueError("redirect_uri must be an exact loopback callback URL")
    try:
        parsed = urlsplit(raw)
        host = parsed.hostname
        port = parsed.port
    except ValueError as error:
        raise ValueError("redirect_uri must be an exact loopback callback URL") from error
    if (
        parsed.scheme.lower() != "http"
        or host is None
        or port is None
        or port in {0, 80}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/oauth/callback"
        or parsed.query
        or parsed.fragment
        or "?" in raw
        or "#" in raw
    ):
        raise ValueError("redirect_uri must be an exact loopback /oauth/callback URL with a port")
    try:
        if ":" in host:
            canonical_host = IPv6Address(host).compressed
            rendered_host = f"[{canonical_host}]"
        else:
            canonical_host = idna.encode(host, uts46=True, std3_rules=True).decode("ascii").lower()
            rendered_host = canonical_host
    except (ValueError, idna.IDNAError, UnicodeError) as error:
        raise ValueError("redirect_uri must contain a valid loopback host") from error
    if canonical_host not in _LOOPBACK_HOSTS:
        raise ValueError("redirect_uri must use localhost, 127.0.0.1, or [::1]")
    return urlunsplit(("http", f"{rendered_host}:{port}", "/oauth/callback", "", ""))


class ClerkCliOAuthSetting(BaseModel):
    """Atomic value stored under the global ``clerk_cli_oauth`` key.

    The migration seeds one completely empty disabled value. Once any field is
    configured, the issuer, public client, redirect, and revoke identifiers are
    required even while disabled. Audience and authorized-party binding remain
    optional to match Clerk's access-token claim semantics.
    """

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)

    enabled: bool = False
    schema_version: Literal[1] = CLERK_CLI_OAUTH_SCHEMA_VERSION
    issuer: str = Field(default="", max_length=512)
    client_id: str = Field(default="", max_length=512)
    application_id: str = Field(default="", max_length=512)
    redirect_uri: str = Field(default="", max_length=2048)
    audience: str = Field(default="", max_length=512)
    authorized_parties: list[str] = Field(default_factory=list, max_length=32)

    @field_validator("issuer")
    @classmethod
    def canonicalize_optional_issuer(cls, value: str) -> str:
        normalized = value.strip()
        return canonical_clerk_issuer(normalized) if normalized else ""

    @field_validator("client_id", "application_id", "audience")
    @classmethod
    def trim_optional_identifiers(cls, value: str) -> str:
        return value.strip()

    @field_validator("redirect_uri")
    @classmethod
    def canonicalize_optional_redirect_uri(cls, value: str) -> str:
        normalized = value.strip()
        return canonical_cli_oauth_redirect_uri(normalized) if normalized else ""

    @field_validator("authorized_parties", mode="before")
    @classmethod
    def canonicalize_authorized_parties(cls, value: object) -> object:
        return _canonical_authorized_parties(value)

    @model_validator(mode="after")
    def reject_partial_or_empty_enabled_config(self) -> ClerkCliOAuthSetting:
        required = (
            self.issuer,
            self.client_id,
            self.application_id,
            self.redirect_uri,
        )
        has_any_config = any(required) or bool(self.audience) or bool(self.authorized_parties)
        if self.enabled or has_any_config:
            for field_name, value in zip(
                ("issuer", "client_id", "application_id", "redirect_uri"),
                required,
                strict=True,
            ):
                _trimmed(value, field_name=field_name)
            if self.audience:
                _trimmed(self.audience, field_name="audience")
        return self


CLERK_CLI_OAUTH_SETTING_ADAPTER = TypeAdapter(ClerkCliOAuthSetting)
