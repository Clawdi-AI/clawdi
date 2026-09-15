"""Deployment-owned signing secrets, addressed by their public key fingerprint."""

import asyncio
import json
import os
import stat
from pathlib import Path

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePrivateKey
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from jwt.algorithms import ECAlgorithm, RSAAlgorithm
from pydantic import JsonValue, TypeAdapter

from app.core.config import settings
from app.services.platform_contract import platform_request_hash
from app.services.platform_workload_auth import (
    InMemoryPlatformWorkloadKeyResolver,
    PlatformWorkloadKeyUnavailable,
)


def public_key_material(jwk: dict[str, JsonValue]) -> dict[str, JsonValue]:
    key = jwt.PyJWK.from_dict(jwk).key
    encoded = RSAAlgorithm.to_jwk(key) if jwk.get("kty") == "RSA" else ECAlgorithm.to_jwk(key)
    canonical = TypeAdapter(dict[str, JsonValue]).validate_python(json.loads(encoded))
    fields = ("kty", "n", "e") if jwk.get("kty") == "RSA" else ("kty", "crv", "x", "y")
    return {field: canonical[field] for field in fields}


def signing_key_reference(jwk: dict[str, JsonValue]) -> str:
    return "sha256:" + platform_request_hash(public_key_material(jwk))


def _read_signing_secret(path: Path) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 16384:
            raise ValueError("invalid signing secret file")
        return source.read(16385)


class SecretReferenceWorkloadKeyResolver:
    async def _resolver(
        self, reference: str, algorithm: str
    ) -> InMemoryPlatformWorkloadKeyResolver:
        try:
            source = settings.platform_workload_signing_key_refs.get(reference, "")
            if source.startswith("file://"):
                path = Path(source.removeprefix("file://"))
                if not path.is_absolute():
                    raise ValueError("absolute path required")
                pem = await asyncio.to_thread(_read_signing_secret, path)
            elif source.startswith("env://"):
                # Kamal Docker env-files escape PEM newlines as literal backslash-n.
                pem = (
                    os.environ.get(source.removeprefix("env://"), "").replace("\\n", "\n").encode()
                )
            else:
                raise ValueError("unknown secret reference")
            if not pem or len(pem) > 16384:
                raise ValueError("invalid signing secret")
            key = serialization.load_pem_private_key(pem, password=None)
            if algorithm == "RS256" and isinstance(key, RSAPrivateKey) and key.key_size >= 2048:
                encoded = RSAAlgorithm.to_jwk(key.public_key())
            elif (
                algorithm == "ES256"
                and isinstance(key, EllipticCurvePrivateKey)
                and key.curve.name == "secp256r1"
            ):
                encoded = ECAlgorithm.to_jwk(key.public_key())
            else:
                raise ValueError("unsupported signing key")
            public = TypeAdapter(dict[str, JsonValue]).validate_python(json.loads(encoded))
            if signing_key_reference(public) != reference:
                raise ValueError("signing identity changed")
            return InMemoryPlatformWorkloadKeyResolver({reference: key})
        except (OSError, ValueError, TypeError):
            raise PlatformWorkloadKeyUnavailable(
                "workload signing authority is unavailable"
            ) from None

    async def sign_jwt(
        self,
        *,
        private_key_ref: str,
        payload: dict[str, JsonValue],
        algorithm: str,
        headers: dict[str, JsonValue],
    ) -> str:
        resolver = await self._resolver(private_key_ref, algorithm)
        return await resolver.sign_jwt(
            private_key_ref=private_key_ref, payload=payload, algorithm=algorithm, headers=headers
        )

    async def resolve_verification_key(self, *, private_key_ref: str, algorithm: str):
        resolver = await self._resolver(private_key_ref, algorithm)
        return await resolver.resolve_verification_key(
            private_key_ref=private_key_ref, algorithm=algorithm
        )
