from __future__ import annotations

import hashlib
import hmac
import mimetypes
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives import hashes, padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import settings
from app.models.channel import ChannelAccount
from app.services.channels import decrypt_provider_token
from app.services.whatsapp_baileys import (
    WhatsAppCloudOutboundPayload,
    WhatsAppMediaReuploadCandidate,
)

WHATSAPP_MEDIA_REUPLOAD_MAX_BYTES = 25 * 1024 * 1024

_MEDIA_KEY_INFO = {
    "image": b"WhatsApp Image Keys",
    "audio": b"WhatsApp Audio Keys",
}


@dataclass(frozen=True)
class WhatsAppMediaReuploadError(Exception):
    reason: str

    def __str__(self) -> str:
        return self.reason


async def reupload_whatsapp_media(
    *,
    account: ChannelAccount,
    candidate: WhatsAppMediaReuploadCandidate,
) -> WhatsAppCloudOutboundPayload:
    encrypted_media = await download_whatsapp_encrypted_media(candidate.source_url)
    plaintext = decrypt_whatsapp_media(candidate, encrypted_media)
    media_id = await upload_whatsapp_media(
        account=account,
        media=plaintext,
        mimetype=candidate.mimetype,
        media_kind=candidate.kind,
    )
    provider_payload: dict[str, Any] = {
        "type": candidate.kind,
        candidate.kind: {"id": media_id},
    }
    if candidate.kind == "image" and candidate.text:
        provider_payload["image"]["caption"] = candidate.text
    return WhatsAppCloudOutboundPayload(
        outcome="sendable",
        kind=candidate.kind,
        text=candidate.text,
        provider_payload=provider_payload,
    )


async def download_whatsapp_encrypted_media(source_url: str) -> bytes:
    _validate_whatsapp_media_url(source_url)
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        try:
            async with client.stream("GET", source_url) as response:
                if response.status_code >= 400:
                    raise WhatsAppMediaReuploadError("media-download-rejected")
                content_length = response.headers.get("content-length")
                if content_length is not None:
                    parsed_content_length = _safe_int(content_length)
                    if (
                        parsed_content_length is not None
                        and parsed_content_length > WHATSAPP_MEDIA_REUPLOAD_MAX_BYTES
                    ):
                        raise WhatsAppMediaReuploadError("media-too-large")

                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > WHATSAPP_MEDIA_REUPLOAD_MAX_BYTES:
                        raise WhatsAppMediaReuploadError("media-too-large")
                    chunks.append(chunk)
        except httpx.HTTPError as exc:
            raise WhatsAppMediaReuploadError("media-download-unreachable") from exc
    return b"".join(chunks)


def decrypt_whatsapp_media(
    candidate: WhatsAppMediaReuploadCandidate,
    encrypted_media: bytes,
) -> bytes:
    if len(encrypted_media) <= 10:
        raise WhatsAppMediaReuploadError("media-encrypted-payload-too-short")
    if candidate.file_enc_sha256 is not None:
        enc_digest = hashlib.sha256(encrypted_media).digest()
        if not hmac.compare_digest(enc_digest, candidate.file_enc_sha256):
            raise WhatsAppMediaReuploadError("media-encrypted-sha256-mismatch")

    iv, cipher_key, mac_key = _derive_whatsapp_media_keys(candidate)
    ciphertext = encrypted_media[:-10]
    expected_mac = encrypted_media[-10:]
    actual_mac = hmac.new(mac_key, iv + ciphertext, hashlib.sha256).digest()[:10]
    if not hmac.compare_digest(actual_mac, expected_mac):
        raise WhatsAppMediaReuploadError("media-hmac-mismatch")

    decryptor = Cipher(algorithms.AES(cipher_key), modes.CBC(iv)).decryptor()
    padded_plaintext = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    try:
        plaintext = unpadder.update(padded_plaintext) + unpadder.finalize()
    except ValueError as exc:
        raise WhatsAppMediaReuploadError("media-padding-invalid") from exc

    if candidate.file_sha256 is not None:
        digest = hashlib.sha256(plaintext).digest()
        if not hmac.compare_digest(digest, candidate.file_sha256):
            raise WhatsAppMediaReuploadError("media-sha256-mismatch")
    return plaintext


async def upload_whatsapp_media(
    *,
    account: ChannelAccount,
    media: bytes,
    mimetype: str,
    media_kind: str,
) -> str:
    token = decrypt_provider_token(account)
    phone_number_id = _account_config_str(account, "phone_number_id")
    if phone_number_id is None:
        raise WhatsAppMediaReuploadError("media-upload-phone-number-id-missing")
    base_url = (
        _account_config_str(account, "graph_api_base_url")
        or settings.channel_whatsapp_graph_api_base_url
    )
    upload_mimetype = _upload_mimetype(mimetype)
    filename = _upload_filename(media_kind=media_kind, mimetype=upload_mimetype)
    url = f"{base_url.rstrip('/')}/{phone_number_id}/media"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                url,
                headers={"Authorization": f"Bearer {token}"},
                data={"messaging_product": "whatsapp", "type": upload_mimetype},
                files={"file": (filename, media, upload_mimetype)},
            )
    except httpx.HTTPError as exc:
        raise WhatsAppMediaReuploadError("media-upload-unreachable") from exc
    if response.status_code >= 400:
        raise WhatsAppMediaReuploadError("media-upload-rejected")
    try:
        payload = response.json()
    except ValueError as exc:
        raise WhatsAppMediaReuploadError("media-upload-response-invalid") from exc
    media_id = payload.get("id") if isinstance(payload, dict) else None
    if not isinstance(media_id, str) or not media_id:
        raise WhatsAppMediaReuploadError("media-upload-response-invalid")
    return media_id


def _derive_whatsapp_media_keys(
    candidate: WhatsAppMediaReuploadCandidate,
) -> tuple[bytes, bytes, bytes]:
    info = _MEDIA_KEY_INFO.get(candidate.kind)
    if info is None:
        raise WhatsAppMediaReuploadError("media-kind-unsupported")
    if len(candidate.media_key) != 32:
        raise WhatsAppMediaReuploadError("media-key-invalid")
    expanded = HKDF(
        algorithm=hashes.SHA256(),
        length=112,
        salt=None,
        info=info,
    ).derive(candidate.media_key)
    return expanded[:16], expanded[16:48], expanded[48:80]


def _validate_whatsapp_media_url(source_url: str) -> None:
    parsed = urlparse(source_url)
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or not hostname:
        raise WhatsAppMediaReuploadError("media-source-url-invalid")
    if hostname != "whatsapp.net" and not hostname.endswith(".whatsapp.net"):
        raise WhatsAppMediaReuploadError("media-source-host-not-whatsapp")


def _upload_filename(*, media_kind: str, mimetype: str) -> str:
    extension = mimetypes.guess_extension(mimetype.split(";", 1)[0].strip()) or ""
    return f"whatsapp-{media_kind}{extension}"


def _upload_mimetype(mimetype: str) -> str:
    return mimetype.split(";", 1)[0].strip() or "application/octet-stream"


def _safe_int(value: str) -> int | None:
    try:
        return int(value)
    except ValueError:
        return None


def _account_config_str(account: ChannelAccount, key: str) -> str | None:
    config = account.config if isinstance(account.config, dict) else {}
    value = config.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None
