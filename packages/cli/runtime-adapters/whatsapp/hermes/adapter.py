"""Hermes adapter for the Clawdi WhatsApp application relay."""

import asyncio
import base64
import contextvars
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

import httpx

from gateway.config import Platform
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    ProcessingOutcome,
    SendResult,
    cache_media_bytes,
)

_MAX_MEDIA_BYTES = 8 * 1024 * 1024
_POLL_SECONDS = 25
_REPLAY_RETRY_BASE_SECONDS = 0.25
_REPLAY_RETRY_MAX_SECONDS = 10.0
_JOURNAL_STATE_LIMIT = 500
_OUTBOUND_BLOCKER = (
    "durable_outbound_unavailable: Hermes 0.19.1 gateway/platforms/base.py:3476-3495 "
    "and 5023-5080 expose no public stable obligation identity for retry-safe arbitrary outbound"
)
_TARGET_RE = re.compile(r"^(direct|group):([^/]+)/(.+)$")
_REPLY_CONTEXT = contextvars.ContextVar("clawdi_whatsapp_reply_context", default=None)


def _required_string(value, label):
    normalized = str(value or "").strip()
    if not normalized:
        raise ValueError(f"Clawdi WhatsApp relay returned an invalid {label}")
    return normalized


def _record(value, label):
    if not isinstance(value, dict):
        raise ValueError(f"Clawdi WhatsApp relay returned an invalid {label}")
    return value


def _unsupported_provider_content_type(value):
    if value is None:
        return None
    unsupported = _record(value, "unsupported content")
    if set(unsupported) != {"providerContentType"}:
        raise ValueError("Clawdi WhatsApp relay returned invalid unsupported content")
    provider_content_type = _required_string(
        unsupported.get("providerContentType"), "unsupported provider content type"
    )
    if len(provider_content_type) > 80:
        raise ValueError(
            "Clawdi WhatsApp relay returned an oversized unsupported provider content type"
        )
    return provider_content_type


class DurableInboxJournal:
    """Atomic restart journal for relay events and completed ACK tombstones."""

    def __init__(self, path):
        self.path = Path(path)
        self.records = {}
        self._load()

    def _load(self):
        if not self.path.exists():
            return
        value = json.loads(self.path.read_text(encoding="utf-8"))
        if value.get("schemaVersion") != "clawdi.hermesWhatsAppInboxJournal.v1":
            raise ValueError("Clawdi WhatsApp inbox journal schema is invalid")
        records = value.get("records")
        if not isinstance(records, dict):
            raise ValueError("Clawdi WhatsApp inbox journal records are invalid")
        self.records = records

    def _write(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        payload = {
            "schemaVersion": "clawdi.hermesWhatsAppInboxJournal.v1",
            "records": self.records,
        }
        temporary = self.path.with_name(f".{self.path.name}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            os.chmod(self.path, 0o600)
            directory_descriptor = os.open(self.path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        finally:
            if temporary.exists():
                temporary.unlink()

    def accept(self, event):
        event_id = _required_string(event.get("id"), "event ID")
        existing = self.records.get(event_id)
        if existing is not None:
            return existing.get("status"), existing
        self._assert_capacity("pending")
        record = {
            "status": "pending",
            "receivedAt": int(time.time() * 1000),
            "payload": event,
        }
        self.records[event_id] = record
        self._write()
        return "accepted", record

    def complete(self, event_id):
        record = self.records[event_id]
        self._assert_capacity("completed", event_id)
        record["status"] = "completed"
        record["completedAt"] = int(time.time() * 1000)
        record.pop("lastOutcome", None)
        record.pop("releasedAt", None)
        record.pop("retryAfter", None)
        record.pop("retryCount", None)
        self._write()

    def release(self, event_id, outcome):
        record = self.records[event_id]
        now = int(time.time() * 1000)
        previous_retry_count = record.get("retryCount")
        retry_count = previous_retry_count + 1 if isinstance(previous_retry_count, int) else 1
        exponent = min(retry_count - 1, 16)
        retry_delay = min(
            _REPLAY_RETRY_BASE_SECONDS * (2**exponent), _REPLAY_RETRY_MAX_SECONDS
        )
        record["status"] = "pending"
        record["lastOutcome"] = str(outcome)
        record["releasedAt"] = now
        record["retryCount"] = retry_count
        record["retryAfter"] = now + int(retry_delay * 1000)
        self._write()

    def acknowledge(self, event_id):
        record = self.records[event_id]
        acknowledged = sorted(
            (
                (record_id, candidate)
                for record_id, candidate in self.records.items()
                if record_id != event_id and candidate.get("status") == "acknowledged"
            ),
            key=lambda item: (
                item[1].get("acknowledgedAt", 0),
                item[1].get("receivedAt", 0),
                item[0],
            ),
        )
        while len(acknowledged) >= _JOURNAL_STATE_LIMIT:
            oldest_event_id, _ = acknowledged.pop(0)
            self.records.pop(oldest_event_id, None)
        record["status"] = "acknowledged"
        record["acknowledgedAt"] = int(time.time() * 1000)
        self._write()

    def replay_records(self):
        return sorted(
            ((event_id, dict(record)) for event_id, record in self.records.items()),
            key=lambda item: (item[1].get("receivedAt", 0), item[0]),
        )

    def _assert_capacity(self, status, current_event_id=None):
        count = sum(
            1
            for event_id, record in self.records.items()
            if event_id != current_event_id and record.get("status") == status
        )
        if count >= _JOURNAL_STATE_LIMIT:
            raise RuntimeError(f"Clawdi WhatsApp inbox journal {status} capacity is exhausted")


class ClawdiWhatsAppAdapter(BasePlatformAdapter):
    """Default-profile platform plugin with completion-hook relay ACK."""

    def __init__(self, config, **kwargs):
        del kwargs
        super().__init__(config=config, platform=Platform.WHATSAPP)
        self.relay_url = os.getenv("CLAWDI_WHATSAPP_RELAY_URL", "").rstrip("/")
        self.account_id = os.getenv("CLAWDI_WHATSAPP_ACCOUNT_ID", "").strip()
        self.link_token = os.getenv("CLAWDI_WHATSAPP_LINK_TOKEN", "").strip()
        hermes_home = Path(os.getenv("HERMES_HOME", Path.home() / ".hermes"))
        self.journal = DurableInboxJournal(
            hermes_home / "state" / "clawdi-whatsapp-inbox-journal.json"
        )
        self._journal_lock = asyncio.Lock()
        self._inflight = set()
        self._stop_event = asyncio.Event()
        self._poll_task = None
        self._client = None

    @property
    def name(self):
        return "WhatsApp (Clawdi managed)"

    def _configured(self):
        if not self.relay_url or not self.account_id or not self.link_token:
            return False
        relay = urlsplit(self.relay_url)
        return (
            relay.scheme in {"http", "https"}
            and not relay.username
            and not relay.password
            and not relay.query
            and not relay.fragment
        )

    async def connect(self, *, is_reconnect=False):
        del is_reconnect
        if not self._configured():
            return False
        if self._poll_task is not None and not self._poll_task.done():
            return True
        self._stop_event.clear()
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(35.0),
            follow_redirects=False,
            headers={"Authorization": f"Bearer {self.link_token}", "Accept": "application/json"},
        )
        self._poll_task = asyncio.create_task(self._poll_loop())
        return True

    async def disconnect(self):
        self._stop_event.set()
        task = self._poll_task
        self._poll_task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        client = self._client
        self._client = None
        if client is not None:
            await client.aclose()

    def _application_url(self, suffix):
        account = quote(self.account_id, safe="")
        return f"{self.relay_url}/v1/channels/whatsapp/application/{account}/{suffix}"

    async def _request_json(self, method, suffix, **kwargs):
        if self._client is None:
            raise RuntimeError("Clawdi WhatsApp relay client is disconnected")
        response = await self._client.request(method, self._application_url(suffix), **kwargs)
        response.raise_for_status()
        value = response.json()
        return _record(value, "response")

    async def _list_inbox(self, cursor=None):
        params = {"wait_seconds": _POLL_SECONDS, "limit": 50}
        if cursor:
            params["cursor"] = cursor
        value = await self._request_json("GET", "inbox", params=params, timeout=32.0)
        events = value.get("events")
        if not isinstance(events, list):
            raise ValueError("Clawdi WhatsApp relay returned an invalid inbox event list")
        return events, value.get("cursor") if isinstance(value.get("cursor"), str) else cursor

    async def _acknowledge(self, event_id):
        await self._request_json(
            "POST", f"inbox/{quote(_required_string(event_id, 'event ID'), safe='')}/ack", json={}
        )

    async def _wait_backoff(self, delay):
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass

    async def _poll_loop(self):
        cursor = None
        retry_delay = 0.25
        sweep_retry_delay = 0.25
        while not self._stop_event.is_set():
            sweep_failed = await self._replay_journal()
            try:
                events, cursor = await self._list_inbox(cursor)
                for event in events:
                    await self._accept_and_dispatch(event)
                retry_delay = 0.25
                if sweep_failed:
                    await self._wait_backoff(sweep_retry_delay)
                    sweep_retry_delay = min(sweep_retry_delay * 2, 10.0)
                else:
                    sweep_retry_delay = 0.25
                    await self._wait_backoff(_REPLAY_RETRY_BASE_SECONDS)
            except asyncio.CancelledError:
                raise
            except Exception:
                cursor = None
                await self._wait_backoff(retry_delay)
                retry_delay = min(retry_delay * 2, 10.0)

    async def _replay_journal(self):
        failed = False
        async with self._journal_lock:
            records = self.journal.replay_records()
        for event_id, record in records:
            status = record.get("status")
            if status == "completed":
                try:
                    await self._finalize_completed(event_id, record.get("payload"))
                except Exception:
                    failed = True
                    continue
            elif status == "pending":
                try:
                    await self._dispatch_pending(event_id, record.get("payload"))
                except Exception:
                    failed = True
        return failed

    async def _accept_and_dispatch(self, raw_event):
        event = _record(raw_event, "inbox event")
        event_id = _required_string(event.get("id"), "event ID")
        async with self._journal_lock:
            status, record = self.journal.accept(event)
        if status == "acknowledged":
            await self._acknowledge(event_id)
            return status
        if status == "completed":
            await self._finalize_completed(event_id, record.get("payload"))
            return status
        return await self._dispatch_pending(event_id, record.get("payload"))

    async def _dispatch_pending(self, event_id, raw_event=None):
        del raw_event
        async with self._journal_lock:
            record = self.journal.records.get(event_id)
            if not isinstance(record, dict):
                raise ValueError("Clawdi WhatsApp inbox journal event is missing")
            status = record.get("status")
            if status != "pending":
                return status
            retry_after = record.get("retryAfter")
            if isinstance(retry_after, (int, float)) and retry_after > int(time.time() * 1000):
                return "backoff"
            if event_id in self._inflight:
                return "pending"
            self._inflight.add(event_id)
            payload = record.get("payload")
        try:
            event = await self._message_event(_record(payload, "journal event"))
            await self.handle_message(event)
        except Exception:
            try:
                async with self._journal_lock:
                    record = self.journal.records.get(event_id)
                    if isinstance(record, dict) and record.get("status") == "pending":
                        self.journal.release(event_id, "dispatch_error")
                    self._inflight.discard(event_id)
            except Exception:
                # Persistence failure is fail-stop: retain the in-flight fence so
                # this process cannot redispatch an event whose state is uncertain.
                raise
            raise
        return "dispatched"

    async def _finalize_completed(self, event_id, raw_event):
        event = _record(raw_event, "completed journal event")
        binding = _record(event.get("binding"), "binding")
        chat = _record(event.get("chat"), "chat")
        message = _record(event.get("message"), "message")
        binding_id = _required_string(binding.get("id"), "binding ID")
        chat_id = _required_string(chat.get("id"), "chat ID")
        chat_type = chat.get("type")
        if chat_type not in {"direct", "group"}:
            raise ValueError("Clawdi WhatsApp relay returned an invalid chat type")
        target = self._target(self._relay_target(binding_id, chat_type, chat_id))
        result = await self._request_json(
            "POST",
            "operations",
            json={
                "operationId": f"inbound:{_required_string(event_id, 'event ID')}:mark-read",
                "type": "mark_read",
                "target": target,
                "messageId": _required_string(message.get("id"), "message ID"),
            },
        )
        if result.get("status") != "completed":
            raise RuntimeError("Clawdi WhatsApp relay mark_read outcome is not completed")
        await self._acknowledge(event_id)
        async with self._journal_lock:
            self.journal.acknowledge(event_id)

    def _relay_target(self, binding_id, chat_type, chat_id):
        kind = "group" if chat_type == "group" else "direct"
        return f"{kind}:{quote(binding_id, safe='')}/{quote(chat_id, safe='')}"

    async def _message_event(self, raw_event):
        binding = _record(raw_event.get("binding"), "binding")
        chat = _record(raw_event.get("chat"), "chat")
        sender = _record(raw_event.get("sender"), "sender")
        message = _record(raw_event.get("message"), "message")
        event_id = _required_string(raw_event.get("id"), "event ID")
        binding_id = _required_string(binding.get("id"), "binding ID")
        chat_id = _required_string(chat.get("id"), "chat ID")
        chat_type = chat.get("type")
        if chat_type not in {"direct", "group"}:
            raise ValueError("Clawdi WhatsApp relay returned an invalid chat type")
        message_id = _required_string(message.get("id"), "message ID")
        target = self._relay_target(binding_id, chat_type, chat_id)
        source = self.build_source(
            chat_id=target,
            chat_name=chat.get("name") if isinstance(chat.get("name"), str) else None,
            chat_type="group" if chat_type == "group" else "dm",
            user_id=_required_string(sender.get("id"), "sender ID"),
            user_name=sender.get("name") if isinstance(sender.get("name"), str) else None,
            message_id=message_id,
        )
        media_urls, media_types, has_voice_note = await self._cache_inbound_media(
            message.get("media", [])
        )
        reaction = message.get("reaction")
        unsupported_provider_content_type = _unsupported_provider_content_type(
            message.get("unsupported")
        )
        text = ""
        if isinstance(reaction, dict):
            raw_emoji = reaction.get("emoji")
            if not isinstance(raw_emoji, str):
                raise ValueError("Clawdi WhatsApp relay returned an invalid reaction emoji")
            emoji = raw_emoji.strip()
            reaction_message_id = _required_string(reaction.get("messageId"), "reaction message ID")
            text = (
                f"[Reaction {emoji} to {reaction_message_id}]"
                if emoji
                else f"[Reaction removed from {reaction_message_id}]"
            )
        elif unsupported_provider_content_type is not None:
            text = f"[Unsupported WhatsApp content: {unsupported_provider_content_type}]"
        elif isinstance(message.get("text"), str):
            text = message.get("text")
        if not text and media_urls:
            text = "[Media]"
        timestamp_value = message.get("timestamp")
        timestamp = datetime.now(timezone.utc)
        if isinstance(timestamp_value, (int, float)):
            seconds = timestamp_value / 1000 if timestamp_value > 100_000_000_000 else timestamp_value
            timestamp = datetime.fromtimestamp(seconds, timezone.utc)
        return MessageEvent(
            text=text,
            message_type=MessageType.VOICE if has_voice_note else MessageType.TEXT,
            source=source,
            raw_message={
                "clawdiRelayEventId": event_id,
                "media": message.get("media", []),
            },
            message_id=message_id,
            media_urls=media_urls,
            media_types=media_types,
            reply_to_message_id=(
                message.get("replyTo") if isinstance(message.get("replyTo"), str) else None
            ),
            metadata={
                "clawdi_relay_event_id": event_id,
                "clawdi_binding_id": binding_id,
                "clawdi_chat_id": chat_id,
            },
            timestamp=timestamp,
        )

    def _authorized_media_url(self, value):
        candidate = urlsplit(_required_string(value, "media URL"))
        relay = urlsplit(self.relay_url)
        relay_path = relay.path.rstrip("/")
        prefix = (
            f"{relay_path}/v1/channels/whatsapp/application/"
            f"{quote(self.account_id, safe='')}/media/"
        )
        if (
            candidate.scheme != relay.scheme
            or candidate.netloc != relay.netloc
            or candidate.username
            or candidate.password
            or candidate.query
            or candidate.fragment
            or not candidate.path.startswith(prefix)
            or len(candidate.path) <= len(prefix)
        ):
            raise ValueError("WhatsApp media URL is outside the authorized Clawdi relay path")
        return candidate.geturl()

    async def _download_media(self, value):
        if self._client is None:
            raise RuntimeError("Clawdi WhatsApp relay client is disconnected")
        url = self._authorized_media_url(value)
        async with self._client.stream("GET", url, headers={"Accept": "*/*"}, timeout=35.0) as response:
            if 300 <= response.status_code < 400:
                raise ValueError("Clawdi WhatsApp relay media download refused a redirect")
            response.raise_for_status()
            declared = response.headers.get("content-length")
            if declared and int(declared) > _MAX_MEDIA_BYTES:
                raise ValueError("WhatsApp media payload exceeds 8 MiB")
            chunks = []
            size = 0
            async for chunk in response.aiter_bytes():
                size += len(chunk)
                if size > _MAX_MEDIA_BYTES:
                    raise ValueError("WhatsApp media payload exceeds 8 MiB")
                chunks.append(chunk)
            if size == 0:
                raise ValueError("WhatsApp media payload is empty")
            return b"".join(chunks), response.headers.get("content-type")

    async def _cache_inbound_media(self, raw_media):
        if not isinstance(raw_media, list):
            raise ValueError("Clawdi WhatsApp relay returned invalid media")
        media_urls = []
        media_types = []
        has_voice_note = False
        for raw_item in raw_media:
            item = _record(raw_item, "media item")
            mime_type = _required_string(item.get("mimeType"), "media MIME type")
            if item.get("ptt") is True:
                if not mime_type.lower().startswith("audio/"):
                    raise ValueError("Clawdi WhatsApp relay returned PTT for non-audio media")
                has_voice_note = True
            content, response_type = await self._download_media(item.get("url"))
            cached = await asyncio.to_thread(
                cache_media_bytes,
                content,
                filename=item.get("fileName") if isinstance(item.get("fileName"), str) else "",
                mime_type=response_type or mime_type,
            )
            if cached is None:
                raise ValueError("Hermes rejected the inbound WhatsApp media payload")
            media_urls.append(cached.path)
            media_types.append(cached.media_type)
        return media_urls, media_types, has_voice_note

    async def on_processing_start(self, event):
        event_id = _required_string(event.metadata.get("clawdi_relay_event_id"), "event ID")
        _REPLY_CONTEXT.set({"event_id": event_id, "next_sequence": 0, "pending": {}})
        await super().on_processing_start(event)

    async def on_processing_complete(self, event, outcome):
        event_id = _required_string(event.metadata.get("clawdi_relay_event_id"), "event ID")
        try:
            if outcome == ProcessingOutcome.SUCCESS:
                async with self._journal_lock:
                    self.journal.complete(event_id)
                    self._inflight.discard(event_id)
                try:
                    async with self._journal_lock:
                        raw_event = self.journal.records[event_id].get("payload")
                    await self._finalize_completed(event_id, raw_event)
                except Exception:
                    pass
            else:
                async with self._journal_lock:
                    self.journal.release(event_id, getattr(outcome, "value", str(outcome)))
                    self._inflight.discard(event_id)
            await super().on_processing_complete(event, outcome)
        finally:
            _REPLY_CONTEXT.set(None)

    def _target(self, chat_id):
        value = str(chat_id or "").strip()
        match = _TARGET_RE.fullmatch(value)
        if not match:
            raise ValueError("WhatsApp target must include chat type, binding, and chat identity")
        binding_id = unquote(match.group(2)).strip()
        native_chat_id = unquote(match.group(3)).strip()
        if not binding_id or not native_chat_id:
            raise ValueError("WhatsApp target identities must not be empty")
        return {"bindingId": binding_id, "chatId": native_chat_id, "chatType": match.group(1)}

    def _operation_identity(self, operation_type, target, payload):
        context = _REPLY_CONTEXT.get()
        if not isinstance(context, dict):
            return None, None
        fingerprint = json.dumps(
            {"type": operation_type, "target": target, "payload": payload},
            sort_keys=True,
            separators=(",", ":"),
        )
        pending = context["pending"]
        operation_id = pending.get(fingerprint)
        if operation_id is None:
            context["next_sequence"] += 1
            operation_id = f"inbound:{context['event_id']}:send:{context['next_sequence']}"
            pending[fingerprint] = operation_id
        return operation_id, fingerprint

    async def _operation(self, operation_type, chat_id, require_message_id=True, **payload):
        try:
            target = self._target(chat_id)
        except ValueError as exc:
            return SendResult(success=False, error=str(exc))
        operation_id, fingerprint = self._operation_identity(operation_type, target, payload)
        if operation_id is None:
            return SendResult(success=False, error=_OUTBOUND_BLOCKER)
        try:
            result = await self._request_json(
                "POST",
                "operations",
                json={
                    "operationId": operation_id,
                    "type": operation_type,
                    "target": target,
                    **payload,
                },
            )
        except Exception as exc:
            return SendResult(
                success=False,
                error=f"Clawdi relay operation failed: {exc}",
                retryable=True,
            )
        if result.get("status") != "completed":
            return SendResult(
                success=False,
                error="Clawdi WhatsApp relay operation outcome is not completed",
                retryable=True,
            )
        message_id = result.get("messageId")
        if require_message_id and (not isinstance(message_id, str) or not message_id):
            return SendResult(success=False, error="Clawdi relay omitted the message ID")
        context = _REPLY_CONTEXT.get()
        if isinstance(context, dict) and fingerprint is not None:
            context["pending"].pop(fingerprint, None)
        return SendResult(
            success=True,
            message_id=message_id if isinstance(message_id, str) else None,
            raw_response=result,
        )

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        del metadata
        return await self._operation(
            "send_text", chat_id, text=str(content), **({"replyTo": reply_to} if reply_to else {})
        )

    async def send_typing(self, chat_id, metadata=None):
        del metadata
        result = await self._operation("typing", chat_id, require_message_id=False, active=True)
        if not result.success:
            raise RuntimeError(result.error or _OUTBOUND_BLOCKER)

    async def edit_message(self, chat_id, message_id, content, *, finalize=False):
        del finalize
        return await self._operation(
            "edit_message", chat_id, messageId=str(message_id), text=str(content)
        )

    async def delete_message(self, chat_id, message_id):
        result = await self._operation(
            "delete_message", chat_id, require_message_id=False, messageId=str(message_id)
        )
        return result.success

    def _validated_local_media(self, value, kind, file_name=None):
        safe_path = self.validate_media_delivery_path(str(value))
        if not safe_path:
            raise ValueError("Hermes rejected the local media delivery path")
        path = Path(safe_path)
        size = path.stat().st_size
        if size <= 0 or size > _MAX_MEDIA_BYTES:
            raise ValueError("WhatsApp media payload is empty or exceeds 8 MiB")
        return {
            "contentBase64": base64.b64encode(path.read_bytes()).decode("ascii"),
            "kind": kind,
            **({"fileName": str(file_name)} if file_name else {}),
        }

    async def send_image(self, chat_id, image_url, caption=None, reply_to=None, metadata=None):
        del metadata
        try:
            try:
                media = {"relayUrl": self._authorized_media_url(image_url)}
            except ValueError:
                media = self._validated_local_media(image_url, "image")
        except (OSError, ValueError) as exc:
            return SendResult(success=False, error=str(exc))
        return await self._operation(
            "send_media",
            chat_id,
            media=media,
            **({"text": caption} if caption else {}),
            **({"replyTo": reply_to} if reply_to else {}),
        )

    async def send_document(
        self, chat_id, file_path, caption=None, file_name=None, reply_to=None, metadata=None, **kwargs
    ):
        del metadata, kwargs
        return await self._send_local_media(
            chat_id, file_path, "document", caption, reply_to, file_name=file_name
        )

    async def send_voice(self, chat_id, audio_path, caption=None, reply_to=None, metadata=None, **kwargs):
        del metadata, kwargs
        try:
            media = {"relayUrl": self._authorized_media_url(audio_path)}
        except ValueError:
            return SendResult(
                success=False,
                error=(
                    "WhatsApp inline voice is unavailable because the relay media contract has no "
                    "inline PTT marker; use an authorized relay media URL"
                ),
            )
        return await self._operation(
            "send_media",
            chat_id,
            media=media,
            **({"text": caption} if caption else {}),
            **({"replyTo": reply_to} if reply_to else {}),
        )

    async def send_video(self, chat_id, video_path, caption=None, reply_to=None, metadata=None, **kwargs):
        del metadata, kwargs
        return await self._send_local_media(chat_id, video_path, "video", caption, reply_to)

    async def _send_local_media(self, chat_id, path, kind, caption, reply_to, file_name=None):
        try:
            media = self._validated_local_media(path, kind, file_name=file_name)
        except (OSError, ValueError) as exc:
            return SendResult(success=False, error=str(exc))
        return await self._operation(
            "send_media",
            chat_id,
            media=media,
            **({"text": caption} if caption else {}),
            **({"replyTo": reply_to} if reply_to else {}),
        )

    async def get_chat_info(self, chat_id):
        target = self._target(chat_id)
        return {
            "name": target["chatId"],
            "type": "group" if target["chatType"] == "group" else "dm",
            "chat_id": str(chat_id),
        }


def check_requirements():
    return True


def _env_enablement():
    required = (
        os.getenv("CLAWDI_WHATSAPP_RELAY_URL"),
        os.getenv("CLAWDI_WHATSAPP_ACCOUNT_ID"),
        os.getenv("CLAWDI_WHATSAPP_LINK_TOKEN"),
    )
    if not all(required):
        return None
    return {"enabled": True, "extra": {"managed_by": "clawdi"}}


def register(ctx):
    ctx.register_platform(
        name="whatsapp",
        label="WhatsApp (Clawdi managed)",
        adapter_factory=lambda cfg: ClawdiWhatsAppAdapter(cfg),
        check_fn=check_requirements,
        required_env=[
            "CLAWDI_WHATSAPP_RELAY_URL",
            "CLAWDI_WHATSAPP_ACCOUNT_ID",
            "CLAWDI_WHATSAPP_LINK_TOKEN",
        ],
        env_enablement_fn=_env_enablement,
        install_hint=_OUTBOUND_BLOCKER,
        emoji="💬",
        pii_safe=False,
        platform_hint="You are chatting through WhatsApp via the Clawdi application relay.",
    )
