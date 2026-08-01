const DEFAULT_POLL_SECONDS = 25;
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export const OPERATION_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$";
export const MAX_OPERATION_ID_LENGTH = 200;
const OPERATION_ID_RE = new RegExp(OPERATION_ID_PATTERN, "u");

function requiredString(value, label) {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Clawdi WhatsApp relay returned an invalid ${label}`);
	}
	return value.trim();
}

function requiredOperationId(value) {
	if (typeof value !== "string" || !OPERATION_ID_RE.test(value)) {
		throw new Error("Clawdi WhatsApp relay returned an invalid operation ID");
	}
	return value;
}

function requiredMediaKind(value) {
	if (!["image", "video", "audio", "document"].includes(value)) {
		throw new Error("Clawdi WhatsApp relay returned an invalid media kind");
	}
	return value;
}

function record(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Clawdi WhatsApp relay returned an invalid ${label}`);
	}
	return value;
}

function abortError() {
	return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function combinedSignal(signal, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function relayAccountUrl(relayUrl, accountId, suffix) {
	const base = relayUrl.endsWith("/") ? relayUrl : `${relayUrl}/`;
	return new URL(
		`v1/channels/whatsapp/application/${encodeURIComponent(accountId)}/${suffix}`,
		base,
	);
}

async function responseJson(response) {
	const text = await response.text();
	let value;
	try {
		value = text ? JSON.parse(text) : {};
	} catch {
		throw new Error(`Clawdi WhatsApp relay returned non-JSON HTTP ${response.status}`);
	}
	if (!response.ok) {
		const detail =
			value && typeof value === "object" && typeof value.detail === "string"
				? `: ${value.detail.slice(0, 200)}`
				: "";
		throw new Error(`Clawdi WhatsApp relay request failed with HTTP ${response.status}${detail}`);
	}
	return value;
}

export function createRelayClient({ relayUrl, accountId, linkToken, fetchImpl = fetch }) {
	const relay = new URL(requiredString(relayUrl, "relay URL"));
	if (
		(relay.protocol !== "https:" && relay.protocol !== "http:") ||
		relay.username ||
		relay.password
	) {
		throw new Error("Clawdi WhatsApp relay URL must be an HTTP URL without credentials");
	}
	const normalizedRelayUrl = relay.toString();
	const normalizedAccountId = requiredString(accountId, "account ID");
	const normalizedToken = requiredString(linkToken, "link token");
	const request = async (suffix, options = {}) => {
		const url = relayAccountUrl(normalizedRelayUrl, normalizedAccountId, suffix);
		if (options.query) {
			for (const [key, value] of Object.entries(options.query)) {
				if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
			}
		}
		const response = await fetchImpl(url, {
			method: options.method ?? "GET",
			headers: {
				authorization: `Bearer ${normalizedToken}`,
				accept: "application/json",
				...(options.body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: combinedSignal(options.signal, options.timeoutMs ?? 35_000),
		});
		return await responseJson(response);
	};
	return {
		relayUrl: normalizedRelayUrl,
		accountId: normalizedAccountId,
		async listInbox({ cursor, signal } = {}) {
			const value = record(
				await request("inbox", {
					query: { cursor, wait_seconds: DEFAULT_POLL_SECONDS, limit: 50 },
					signal,
					timeoutMs: 32_000,
				}),
				"inbox response",
			);
			if (!Array.isArray(value.events)) {
				throw new Error("Clawdi WhatsApp relay returned an invalid inbox event list");
			}
			return {
				events: value.events.map(normalizeInboxEvent),
				cursor: typeof value.cursor === "string" ? value.cursor : cursor,
			};
		},
		async acknowledge(eventId, signal) {
			await request(`inbox/${encodeURIComponent(requiredString(eventId, "event ID"))}/ack`, {
				method: "POST",
				body: {},
				signal,
			});
		},
		async submitOperation(operation, signal) {
			const value = record(
				await request("operations", { method: "POST", body: operation, signal }),
				"operation response",
			);
			if (value.status !== "completed") {
				throw new Error("Clawdi WhatsApp relay operation outcome is not completed");
			}
			return {
				operationId: requiredOperationId(value.operationId ?? operation.operationId),
				messageId:
					typeof value.messageId === "string" && value.messageId.trim()
						? value.messageId.trim()
						: undefined,
			};
		},
		async downloadMedia(mediaUrl, signal) {
			if (!isAuthorizedRelayMediaUrl(mediaUrl, normalizedRelayUrl, normalizedAccountId)) {
				throw new Error("WhatsApp media URL is outside the authorized Clawdi relay path");
			}
			const response = await fetchImpl(new URL(mediaUrl), {
				method: "GET",
				headers: { authorization: `Bearer ${normalizedToken}`, accept: "*/*" },
				redirect: "manual",
				signal: combinedSignal(signal, 35_000),
			});
			if (response.status >= 300 && response.status < 400) {
				throw new Error("Clawdi WhatsApp relay media download refused a redirect");
			}
			if (!response.ok) {
				throw new Error(`Clawdi WhatsApp relay media download failed with HTTP ${response.status}`);
			}
			const declaredLength = Number(response.headers.get("content-length"));
			if (Number.isFinite(declaredLength) && declaredLength > MAX_MEDIA_BYTES) {
				throw new Error("WhatsApp media payload exceeds 8 MiB");
			}
			const buffer = await readBoundedResponseBody(response, MAX_MEDIA_BYTES);
			if (buffer.length === 0) throw new Error("WhatsApp media payload is empty");
			return {
				buffer,
				contentType: response.headers.get("content-type")?.trim() || undefined,
			};
		},
	};
}

async function readBoundedResponseBody(response, maxBytes) {
	if (!response.body) return Buffer.from(await response.arrayBuffer());
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = Buffer.from(value);
			total += chunk.length;
			if (total > maxBytes) {
				await reader.cancel("media size limit exceeded");
				throw new Error("WhatsApp media payload exceeds 8 MiB");
			}
			chunks.push(chunk);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
}

export function normalizeInboxEvent(value) {
	const event = record(value, "inbox event");
	const binding = record(event.binding, "binding");
	const chat = record(event.chat, "chat");
	const sender = record(event.sender, "sender");
	const message = record(event.message, "message");
	const chatType = chat.type === "group" ? "group" : chat.type === "direct" ? "direct" : null;
	if (!chatType) throw new Error("Clawdi WhatsApp relay returned an invalid chat type");
	const media = Array.isArray(message.media)
		? message.media.map((item) => {
				const entry = record(item, "media item");
				const mimeType = requiredString(entry.mimeType, "media MIME type");
				const ptt = entry.ptt === true;
				if (ptt && !mimeType.toLowerCase().startsWith("audio/")) {
					throw new Error("Clawdi WhatsApp relay returned PTT for non-audio media");
				}
				return {
					url: requiredString(entry.url, "media URL"),
					mimeType,
					fileName: typeof entry.fileName === "string" ? entry.fileName : undefined,
					ptt,
				};
			})
		: [];
	return {
		id: requiredString(event.id, "event ID"),
		bindingId: requiredString(binding.id, "binding ID"),
		chat: {
			id: requiredString(chat.id, "chat ID"),
			type: chatType,
			name: typeof chat.name === "string" ? chat.name : undefined,
		},
		sender: {
			id: requiredString(sender.id, "sender ID"),
			name: typeof sender.name === "string" ? sender.name : undefined,
		},
		message: {
			id: requiredString(message.id, "message ID"),
			text: typeof message.text === "string" ? message.text : "",
			timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
			replyTo: typeof message.replyTo === "string" ? message.replyTo : undefined,
			reaction: normalizeInboundReaction(message.reaction),
			unsupported: normalizeUnsupportedContent(message.unsupported),
			media,
		},
	};
}

function normalizeUnsupportedContent(value) {
	if (value === undefined || value === null) return undefined;
	const unsupported = record(value, "unsupported content");
	if (Object.keys(unsupported).length !== 1 || !Object.hasOwn(unsupported, "providerContentType")) {
		throw new Error("Clawdi WhatsApp relay returned invalid unsupported content");
	}
	const providerContentType = requiredString(
		unsupported.providerContentType,
		"unsupported provider content type",
	);
	if (providerContentType.length > 80) {
		throw new Error(
			"Clawdi WhatsApp relay returned an oversized unsupported provider content type",
		);
	}
	return { providerContentType };
}

function normalizeInboundReaction(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	if (typeof value.emoji !== "string") {
		throw new Error("Clawdi WhatsApp relay returned an invalid reaction emoji");
	}
	const emoji = value.emoji.trim();
	return {
		emoji,
		messageId: requiredString(value.messageId, "reaction message ID"),
		remove: emoji.length === 0,
	};
}

export function buildRelayTarget({ bindingId, chatType, chatId }) {
	const kind = chatType === "group" ? "group" : "direct";
	return `${kind}:${encodeURIComponent(requiredString(bindingId, "binding ID"))}/${encodeURIComponent(requiredString(chatId, "chat ID"))}`;
}

export function parseRelayTarget(value) {
	const match = /^(direct|group):([^/]+)\/(.+)$/u.exec(requiredString(value, "target"));
	if (!match) throw new Error("Invalid Clawdi WhatsApp target");
	return {
		chatType: match[1],
		bindingId: decodeURIComponent(match[2]),
		chatId: decodeURIComponent(match[3]),
	};
}

export function isAuthorizedRelayMediaUrl(value, relayUrl, accountId) {
	try {
		const candidate = new URL(value);
		const allowed = relayAccountUrl(relayUrl, accountId, "media/");
		return (
			candidate.protocol === allowed.protocol &&
			candidate.host === allowed.host &&
			!candidate.username &&
			!candidate.password &&
			!candidate.search &&
			!candidate.hash &&
			candidate.pathname.startsWith(allowed.pathname) &&
			candidate.pathname.length > allowed.pathname.length
		);
	} catch {
		return false;
	}
}

function isClawdiRelayMediaPath(value, relayUrl, accountId) {
	try {
		const candidate = new URL(value);
		const allowed = relayAccountUrl(relayUrl, accountId, "media/");
		return (
			candidate.protocol === allowed.protocol &&
			candidate.host === allowed.host &&
			candidate.pathname.startsWith(allowed.pathname)
		);
	} catch {
		return false;
	}
}

async function outboundMedia(mediaUrl, mediaReadFile, relayUrl, accountId, audioAsVoice) {
	if (isAuthorizedRelayMediaUrl(mediaUrl, relayUrl, accountId)) {
		return { relayUrl: mediaUrl };
	}
	if (isClawdiRelayMediaPath(mediaUrl, relayUrl, accountId)) {
		throw new Error("WhatsApp media URL is outside the authorized Clawdi relay path");
	}
	if (audioAsVoice === true) {
		throw new Error(
			"WhatsApp inline voice is unavailable because the relay media contract has no inline PTT marker; use an authorized relay media URL",
		);
	}
	if (typeof mediaReadFile !== "function") {
		throw new Error("WhatsApp media requires OpenClaw's validated outbound media loader");
	}
	const loaded = await mediaReadFile(mediaUrl);
	const bytes = Buffer.isBuffer(loaded) ? loaded : loaded?.buffer;
	if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
		throw new Error("WhatsApp media payload is empty or exceeds 8 MiB");
	}
	const kind = Buffer.isBuffer(loaded) ? undefined : loaded?.kind;
	return {
		contentBase64: bytes.toString("base64"),
		kind: requiredMediaKind(kind),
		...(typeof loaded?.fileName === "string" ? { fileName: loaded.fileName } : {}),
	};
}

export async function buildSendOperation({
	target,
	text,
	replyTo,
	mediaUrl,
	mediaReadFile,
	audioAsVoice,
	relayUrl,
	accountId,
	operationId,
}) {
	const parsed = parseRelayTarget(target);
	return {
		operationId: requiredOperationId(operationId),
		type: mediaUrl ? "send_media" : "send_text",
		target: {
			bindingId: parsed.bindingId,
			chatId: parsed.chatId,
			chatType: parsed.chatType,
		},
		...(typeof text === "string" && text.length > 0 ? { text } : {}),
		...(replyTo ? { replyTo } : {}),
		...(mediaUrl
			? {
					media: await outboundMedia(mediaUrl, mediaReadFile, relayUrl, accountId, audioAsVoice),
				}
			: {}),
	};
}

export function buildActionOperation({
	action,
	target,
	messageId,
	text,
	emoji,
	remove,
	operationId,
}) {
	const parsed = parseRelayTarget(target);
	const operation = {
		operationId: requiredOperationId(operationId),
		target: {
			bindingId: parsed.bindingId,
			chatId: parsed.chatId,
			chatType: parsed.chatType,
		},
	};
	if (action === "reply") {
		return {
			...operation,
			type: "send_text",
			text: requiredString(text, "reply text"),
			replyTo: requiredString(messageId, "message ID"),
		};
	}
	if (action === "react") {
		return {
			...operation,
			type: "reaction",
			messageId: requiredString(messageId, "message ID"),
			emoji: remove === true ? "" : requiredString(emoji, "reaction emoji"),
		};
	}
	if (action === "edit") {
		return {
			...operation,
			type: "edit_message",
			messageId: requiredString(messageId, "message ID"),
			text: requiredString(text, "edited text"),
		};
	}
	if (action === "delete" || action === "unsend") {
		return {
			...operation,
			type: "delete_message",
			messageId: requiredString(messageId, "message ID"),
		};
	}
	throw new Error(`Unsupported Clawdi WhatsApp action: ${action}`);
}

export function buildTypingOperation({ target, active, operationId }) {
	const parsed = parseRelayTarget(target);
	return {
		operationId: requiredOperationId(operationId),
		type: "typing",
		target: {
			bindingId: parsed.bindingId,
			chatId: parsed.chatId,
			chatType: parsed.chatType,
		},
		active: active === true,
	};
}

export function buildMarkReadOperation({ target, messageId, eventId }) {
	const parsed = parseRelayTarget(target);
	return {
		operationId: requiredOperationId(`inbound:${requiredString(eventId, "event ID")}:mark-read`),
		type: "mark_read",
		target: {
			bindingId: parsed.bindingId,
			chatId: parsed.chatId,
			chatType: parsed.chatType,
		},
		messageId: requiredString(messageId, "message ID"),
	};
}

export async function waitForRetry(delayMs, signal) {
	if (signal?.aborted) throw abortError();
	await new Promise((resolve, reject) => {
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(abortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function processDurableInboxEvent({
	journal,
	client,
	event,
	signal,
	dispatch,
	finalize,
}) {
	const accepted = await journal.accept(event.id, event, { receivedAt: Date.now() });
	if (accepted.kind === "completed") {
		await finalize?.(event);
		await client.acknowledge(event.id, signal);
		return "already_completed";
	}
	if (accepted.kind === "pending") return "already_pending";
	return await replayDurableInboxEvent({
		journal,
		client,
		event: accepted.record.payload,
		signal,
		dispatch,
		finalize,
	});
}

export async function replayDurableInboxEvent({
	journal,
	client,
	event,
	signal,
	dispatch,
	finalize,
}) {
	try {
		await dispatch(event);
	} catch (error) {
		await journal.release(event.id, {
			lastError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
			releasedAt: Date.now(),
		});
		throw error;
	}
	await journal.complete(event.id, { completedAt: Date.now() });
	await finalize?.(event);
	await client.acknowledge(event.id, signal);
	return "completed";
}

export async function runInboxLoop({ client, signal, dispatch, initialRetryMs = 250 }) {
	let cursor;
	let retryMs = initialRetryMs;
	while (!signal.aborted) {
		try {
			const page = await client.listInbox({ cursor, signal });
			for (const event of page.events) await dispatch(event, signal);
			cursor = page.cursor;
			retryMs = initialRetryMs;
		} catch (error) {
			if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
			cursor = undefined;
			await waitForRetry(retryMs, signal);
			retryMs = Math.min(retryMs * 2, 10_000);
		}
	}
}
