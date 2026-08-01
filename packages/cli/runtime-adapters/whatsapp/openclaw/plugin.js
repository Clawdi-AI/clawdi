import { buildAgentMediaPayload } from "openclaw/plugin-sdk/agent-media-payload";
import {
	jsonResult,
	readStringParam,
	resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import {
	buildChannelOutboundSessionRoute,
	createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
	createDurableInboundReceiveJournalFromQueue,
	defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import {
	createComputedAccountStatusAdapter,
	createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { getWhatsAppRuntime } from "./api.js";
import {
	buildActionOperation,
	buildMarkReadOperation,
	buildRelayTarget,
	buildSendOperation,
	buildTypingOperation,
	createRelayClient,
	MAX_MEDIA_BYTES,
	MAX_OPERATION_ID_LENGTH,
	OPERATION_ID_PATTERN,
	parseRelayTarget,
	processDurableInboxEvent,
	replayDurableInboxEvent,
	runInboxLoop,
} from "./relay-client.js";

const CHANNEL_ID = "whatsapp";
const PLUGIN_ID = "clawdi-whatsapp";
const DEFAULT_ACCOUNT_ID = "default";
const MESSAGE_ACTIONS = new Set(["reply", "react", "edit", "delete", "unsend"]);
const MESSAGE_ACTION_LIST = [...MESSAGE_ACTIONS];
export const unsupportedMessageActions = Object.freeze({
	read: "OpenClaw read action fetches message history; automatic inbound mark_read uses the processing-completion seam instead",
	"set-presence": "OpenClaw set-presence is targetless and cannot carry binding and chat identity",
});
export const arbitraryOutboundBlocker =
	"OpenClaw 2026.7.1 has no public stable identity for an initial arbitrary outbound provider operation";
const configSchema = buildJsonChannelConfigSchema(
	{
		type: "object",
		additionalProperties: false,
		properties: {
			enabled: { type: "boolean" },
			defaultAccount: { type: "string", minLength: 1 },
			accounts: {
				type: "object",
				maxProperties: 1,
				additionalProperties: {
					type: "object",
					additionalProperties: false,
					properties: { enabled: { type: "boolean" } },
				},
			},
		},
	},
	{ cacheKey: `${PLUGIN_ID}:channel-config` },
);

function accountIds(cfg) {
	const accounts = cfg.channels?.[CHANNEL_ID]?.accounts;
	const ids = accounts && typeof accounts === "object" ? Object.keys(accounts) : [];
	return ids.length > 0 ? [ids.sort()[0]] : [DEFAULT_ACCOUNT_ID];
}

function defaultAccountId(cfg) {
	return cfg.channels?.[CHANNEL_ID]?.defaultAccount ?? accountIds(cfg)[0];
}

function resolveAccount(cfg, accountId) {
	const id = accountId?.trim() || defaultAccountId(cfg);
	const channel = cfg.channels?.[CHANNEL_ID] ?? {};
	const entry = channel.accounts?.[id] ?? {};
	const relayUrl = process.env.CLAWDI_WHATSAPP_RELAY_URL?.trim() ?? "";
	const relayAccountId = process.env.CLAWDI_WHATSAPP_ACCOUNT_ID?.trim() ?? "";
	const linkToken = process.env.CLAWDI_WHATSAPP_LINK_TOKEN?.trim() ?? "";
	return {
		accountId: id,
		enabled: channel.enabled !== false && entry.enabled !== false,
		configured: Boolean(relayUrl && relayAccountId && linkToken),
		relayUrl,
		relayAccountId,
		linkToken,
	};
}

function targetForEvent(event) {
	return buildRelayTarget({
		bindingId: event.bindingId,
		chatType: event.chat.type,
		chatId: event.chat.id,
	});
}

export function bodyForEvent(event) {
	if (event.message.reaction) {
		return event.message.reaction.remove
			? `[Reaction removed from ${event.message.reaction.messageId}]`
			: `[Reaction ${event.message.reaction.emoji} to ${event.message.reaction.messageId}]`;
	}
	if (event.message.unsupported) {
		return `[Unsupported WhatsApp content: ${event.message.unsupported.providerContentType}]`;
	}
	if (event.message.text) return event.message.text;
	if (event.message.media.some((item) => item.ptt)) return "[Voice message]";
	return event.message.media.length > 0 ? "[Media]" : "";
}

export function assertInboundMediaSupported(event) {
	if (event.message.media.some((item) => item.ptt)) {
		throw new Error(
			"OpenClaw 2026.7.1 src/plugin-sdk/agent-media-payload.ts:5-28 has no public PTT field for inbound agent media; refusing to map a WhatsApp voice note to ordinary audio",
		);
	}
}

async function mediaPayload(account, event) {
	assertInboundMediaSupported(event);
	const client = createRelayClient({
		relayUrl: account.relayUrl,
		accountId: account.relayAccountId,
		linkToken: account.linkToken,
	});
	const media = [];
	for (const item of event.message.media) {
		const downloaded = await client.downloadMedia(item.url);
		const saved = await saveMediaBuffer(
			downloaded.buffer,
			downloaded.contentType ?? item.mimeType,
			"inbound",
			MAX_MEDIA_BYTES,
			item.fileName,
		);
		media.push({ path: saved.path, contentType: saved.contentType });
	}
	return media.length > 0 ? buildAgentMediaPayload(media) : {};
}

function replyMediaUrls(payload) {
	if (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0) {
		return payload.mediaUrls.map((value) => String(value).trim()).filter(Boolean);
	}
	return typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()
		? [payload.mediaUrl.trim()]
		: [];
}

export async function deliverInboundReplyPayload({
	client,
	event,
	target,
	payload,
	relayUrl,
	accountId,
	nextOperationId,
	mediaLoader,
	signal,
}) {
	if (!payload || typeof payload !== "object") return [];
	if (typeof nextOperationId !== "function") {
		throw new Error("Clawdi WhatsApp inbound reply operation identity is unavailable");
	}
	const text = typeof payload.text === "string" ? payload.text : "";
	const mediaUrls = replyMediaUrls(payload);
	const parts = mediaUrls.length > 0 ? mediaUrls : [undefined];
	const results = [];
	for (const [index, mediaUrl] of parts.entries()) {
		if (!mediaUrl && !text.trim()) continue;
		const operation = await buildSendOperation({
			target,
			text: index === 0 ? text : "",
			replyTo: event.message.id,
			mediaUrl,
			mediaReadFile: mediaUrl
				? async (value) =>
						await (mediaLoader ?? loadOutboundMediaFromUrl)(value, {
							maxBytes: MAX_MEDIA_BYTES,
						})
				: undefined,
			audioAsVoice: payload.audioAsVoice === true,
			relayUrl,
			accountId,
			operationId: nextOperationId(),
		});
		const result = await client.submitOperation(operation, signal);
		if (!result.messageId) {
			throw new Error("Clawdi WhatsApp relay omitted the reply message ID");
		}
		results.push(result);
	}
	return results;
}

async function dispatchInbound({ account, cfg, event }) {
	const runtime = getWhatsAppRuntime();
	const target = targetForEvent(event);
	const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
		cfg,
		channel: CHANNEL_ID,
		accountId: account.accountId,
		peer: { kind: event.chat.type, id: target },
		runtime: runtime.channel,
		sessionStore: cfg.session?.store,
	});
	const access = await resolveStableChannelMessageIngress({
		channelId: CHANNEL_ID,
		accountId: account.accountId,
		identity: { key: "sender", entryIdPrefix: "clawdi-wa" },
		groupAllowFromFallbackToAllowFrom: true,
		subject: { stableId: event.sender.id },
		conversation: {
			kind: event.chat.type,
			id: target,
			title: event.chat.name,
		},
		dmPolicy: "open",
		groupPolicy: "open",
		allowFrom: ["*"],
		groupAllowFrom: ["*"],
		mentionFacts:
			event.chat.type === "group" ? { canDetectMention: false, wasMentioned: false } : undefined,
		policy: {
			activation:
				event.chat.type === "group"
					? { requireMention: false, allowTextCommands: true }
					: undefined,
		},
	});
	if (access.ingress.admission !== "dispatch") {
		throw new Error("Clawdi WhatsApp inbound event was not accepted for agent dispatch");
	}
	const body = bodyForEvent(event);
	const envelope = buildEnvelope({
		channel: "WhatsApp",
		from: event.sender.name || event.sender.id,
		timestamp: event.message.timestamp,
		body,
	});
	const ctxPayload = runtime.channel.reply.finalizeInboundContext({
		Body: envelope.body,
		BodyForAgent: body,
		RawBody: body,
		CommandBody: body,
		From: target,
		To: target,
		SessionKey: route.sessionKey,
		AccountId: route.accountId ?? account.accountId,
		ChatType: event.chat.type,
		ConversationLabel: event.chat.name || event.chat.id,
		GroupSubject: event.chat.type === "group" ? event.chat.name || event.chat.id : undefined,
		NativeChannelId: event.chat.id,
		SenderName: event.sender.name,
		SenderId: event.sender.id,
		Provider: CHANNEL_ID,
		Surface: CHANNEL_ID,
		MessageSid: event.message.id,
		MessageSidFull: event.message.id,
		ReplyToId: event.message.replyTo ?? event.message.reaction?.messageId,
		Timestamp: event.message.timestamp,
		OriginatingChannel: CHANNEL_ID,
		OriginatingTo: target,
		CommandAuthorized: true,
		...(await mediaPayload(account, event)),
	});
	let replySequence = 0;
	await runtime.channel.inbound.dispatchReply({
		cfg,
		channel: CHANNEL_ID,
		accountId: account.accountId,
		agentId: route.agentId,
		routeSessionKey: route.sessionKey,
		storePath: envelope.storePath,
		ctxPayload,
		recordInboundSession: runtime.channel.session.recordInboundSession,
		dispatchReplyWithBufferedBlockDispatcher:
			runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
		delivery: {
			deliver: async (payload) =>
				await deliverInboundReplyPayload({
					client: createRelayClient({
						relayUrl: account.relayUrl,
						accountId: account.relayAccountId,
						linkToken: account.linkToken,
					}),
					event,
					target,
					payload,
					relayUrl: account.relayUrl,
					accountId: account.relayAccountId,
					nextOperationId: () => `inbound:${event.id}:reply:${++replySequence}`,
				}),
			onError: (error) => {
				throw error instanceof Error ? error : new Error(String(error));
			},
		},
		replyOptions: {},
		replyPipeline: {},
		record: {
			onRecordError: (error) => {
				throw error instanceof Error ? error : new Error(String(error));
			},
		},
	});
}

function durableJournal(account) {
	const runtime = getWhatsAppRuntime();
	const queue = runtime.state.openChannelIngressQueue({
		accountId: account.accountId,
		stateDir: runtime.state.resolveStateDir(),
	});
	return createDurableInboundReceiveJournalFromQueue({
		queue,
		retention: {
			pendingTtlMs: 30 * 24 * 60 * 60 * 1000,
			completedTtlMs: 7 * 24 * 60 * 60 * 1000,
			failedTtlMs: 30 * 24 * 60 * 60 * 1000,
			pendingMaxEntries: 500,
			completedMaxEntries: 500,
			failedMaxEntries: 500,
		},
	});
}

async function processDurableEvent({ account, cfg, client, journal, event, signal }) {
	await processDurableInboxEvent({
		journal,
		client,
		event,
		signal,
		dispatch: async (durableEvent) => await dispatchInbound({ account, cfg, event: durableEvent }),
		finalize: async (durableEvent) =>
			await markInboundRead({ client, event: durableEvent, signal }),
	});
}

async function markInboundRead({ client, event, signal }) {
	await client.submitOperation(
		buildMarkReadOperation({
			target: targetForEvent(event),
			messageId: event.message.id,
			eventId: event.id,
		}),
		signal,
	);
}

async function startAccount(ctx) {
	const account = ctx.account;
	if (!account.configured) throw new Error("Clawdi WhatsApp relay environment is incomplete");
	const client = createRelayClient({
		relayUrl: account.relayUrl,
		accountId: account.relayAccountId,
		linkToken: account.linkToken,
	});
	const journal = durableJournal(account);
	ctx.setStatus({
		accountId: account.accountId,
		running: true,
		enabled: account.enabled,
		configured: true,
	});
	try {
		for (const pending of await journal.pending()) {
			await replayDurableInboxEvent({
				journal,
				client,
				event: pending.payload,
				signal: ctx.abortSignal,
				dispatch: async (event) => await dispatchInbound({ account, cfg: ctx.cfg, event }),
				finalize: async (event) =>
					await markInboundRead({ client, event, signal: ctx.abortSignal }),
			});
		}
		await runInboxLoop({
			client,
			signal: ctx.abortSignal,
			dispatch: (event, signal) =>
				processDurableEvent({ account, cfg: ctx.cfg, client, journal, event, signal }),
		});
	} finally {
		ctx.setStatus({ accountId: account.accountId, running: false });
	}
}

async function sendFromContext(ctx) {
	void ctx;
	throw new Error(arbitraryOutboundBlocker);
}

function resolveActionAccount(ctx) {
	const account = resolveAccount(ctx.cfg, ctx.accountId ?? undefined);
	if (!account.configured) throw new Error("Clawdi WhatsApp relay environment is incomplete");
	return account;
}

function actionText(params, label) {
	return (
		readStringParam(params, "text") ??
		readStringParam(params, "message") ??
		readStringParam(params, "content", { required: true, label })
	);
}

async function handleMessageAction(ctx) {
	if (!MESSAGE_ACTIONS.has(ctx.action)) {
		throw new Error(`Unsupported Clawdi WhatsApp action: ${ctx.action}`);
	}
	const account = resolveActionAccount(ctx);
	const target = readStringParam(ctx.params, "to", {
		required: true,
		label: "WhatsApp target with binding and chat identity",
	});
	const operationId = readStringParam(ctx.params, "idempotencyKey", {
		required: true,
		label: "OpenClaw action idempotency key",
	});
	const explicitMessageId = readStringParam(ctx.params, "messageId");
	const messageId =
		ctx.action === "react"
			? String(resolveReactionMessageId({ args: ctx.params, toolContext: ctx.toolContext }) ?? "")
			: explicitMessageId;
	const operation = buildActionOperation({
		action: ctx.action,
		target,
		messageId,
		text:
			ctx.action === "reply" || ctx.action === "edit"
				? actionText(ctx.params, `${ctx.action} text`)
				: undefined,
		emoji:
			ctx.action === "react"
				? ctx.params.remove === true
					? ""
					: readStringParam(ctx.params, "emoji", {
							required: true,
							label: "reaction emoji",
						})
				: undefined,
		remove: ctx.params.remove === true,
		operationId,
	});
	const client = createRelayClient({
		relayUrl: account.relayUrl,
		accountId: account.relayAccountId,
		linkToken: account.linkToken,
	});
	const result = await client.submitOperation(operation);
	if (ctx.action === "reply" && !result.messageId) {
		throw new Error("Clawdi WhatsApp relay omitted the reply message ID");
	}
	return jsonResult({
		ok: true,
		action: ctx.action,
		operationId: result.operationId,
		...(result.messageId ? { messageId: result.messageId } : {}),
	});
}

async function setTyping({ cfg, to, accountId }, active) {
	const account = resolveAccount(cfg, accountId ?? undefined);
	if (!account.configured) throw new Error("Clawdi WhatsApp relay environment is incomplete");
	const client = createRelayClient({
		relayUrl: account.relayUrl,
		accountId: account.relayAccountId,
		linkToken: account.linkToken,
	});
	await client.submitOperation(
		buildTypingOperation({
			target: to,
			active,
			operationId: `ephemeral-typing:${crypto.randomUUID()}`,
		}),
	);
}

const messageActions = {
	describeMessageTool: ({ cfg, accountId }) => {
		const account = resolveAccount(cfg, accountId ?? undefined);
		return account.enabled && account.configured
			? {
					actions: MESSAGE_ACTION_LIST,
					capabilities: [],
					schema: {
						properties: {
							idempotencyKey: {
								type: "string",
								minLength: 1,
								maxLength: MAX_OPERATION_ID_LENGTH,
								pattern: OPERATION_ID_PATTERN,
								description:
									"Stable relay operation identity. Reuse the same value when retrying the same tool invocation.",
							},
						},
						actions: MESSAGE_ACTION_LIST,
						visibility: "all-configured",
					},
				}
			: null;
	},
	supportsAction: ({ action }) => MESSAGE_ACTIONS.has(action),
	handleAction: handleMessageAction,
};

const messageAdapter = defineChannelMessageAdapter({
	id: CHANNEL_ID,
	receive: {
		defaultAckPolicy: "after_agent_dispatch",
		supportedAckPolicies: ["after_agent_dispatch"],
	},
});

const meta = {
	...getChatChannelMeta(CHANNEL_ID),
	id: CHANNEL_ID,
	label: "WhatsApp",
	selectionLabel: "WhatsApp (Clawdi managed)",
	blurb: "WhatsApp through the Clawdi application relay.",
};

export const whatsappPlugin = createChatChannelPlugin({
	base: {
		id: CHANNEL_ID,
		meta,
		capabilities: {
			chatTypes: ["direct", "group"],
			reply: true,
			reactions: true,
			edit: true,
			unsend: true,
		},
		reload: { configPrefixes: ["channels.whatsapp"] },
		configSchema,
		config: {
			listAccountIds: accountIds,
			defaultAccountId,
			resolveAccount,
			isConfigured: (account) => account.configured,
			resolveAllowFrom: () => ["*"],
		},
		messaging: {
			targetPrefixes: ["whatsapp"],
			normalizeTarget: (value) => {
				try {
					return buildRelayTarget(parseRelayTarget(value));
				} catch {
					return undefined;
				}
			},
			inferTargetChatType: ({ to }) => parseRelayTarget(to).chatType,
			targetResolver: {
				looksLikeId: (value) => /^(direct|group):[^/]+\/.+$/u.test(value.trim()),
				hint: "<direct|group>:<binding>/<chat>",
			},
			resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
				const parsed = parseRelayTarget(target);
				return buildChannelOutboundSessionRoute({
					cfg,
					agentId,
					channel: CHANNEL_ID,
					accountId,
					recipientSessionExact: true,
					peer: { kind: parsed.chatType, id: target },
					chatType: parsed.chatType,
					from: `${CHANNEL_ID}:${accountId ?? DEFAULT_ACCOUNT_ID}`,
					to: target,
				});
			},
		},
		status: createComputedAccountStatusAdapter({
			defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
			resolveAccountSnapshot: ({ account }) => ({
				accountId: account.accountId,
				enabled: account.enabled,
				configured: account.configured,
			}),
		}),
		gateway: { startAccount },
		message: messageAdapter,
		actions: messageActions,
		heartbeat: {
			sendTyping: async (ctx) => await setTyping(ctx, true),
			clearTyping: async (ctx) => await setTyping(ctx, false),
		},
	},
	outbound: {
		base: { deliveryMode: "direct" },
		attachedResults: {
			channel: CHANNEL_ID,
			sendText: async (ctx) => await sendFromContext(ctx),
			sendMedia: async (ctx) => await sendFromContext(ctx),
		},
	},
});
