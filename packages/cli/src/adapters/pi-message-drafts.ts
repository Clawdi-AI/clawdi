import type { SessionEventDraft } from "../lib/session-events";
import type { SessionEventSource } from "./base";
import {
	canonicalStructuredString,
	type JsonObject,
	jsonObject,
	jsonString,
	reasoningContent,
	toolResultContent,
	visibleContentParts,
} from "./rich-event-mapping";

interface PiMessageContext {
	source: (partIndex?: number) => SessionEventSource;
	recordId: string;
	timestamp?: string;
	model?: string | null;
}

function validTimestamp(value: string | number): string | undefined {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

// OpenClaw-authored transcript bookkeeping is content, not provider model output.
const OPENCLAW_BOOKKEEPING_MODELS = new Set([
	"delivery-mirror", "gateway-injected", "acp-runtime", "automation-result",
]);

export function isOpenClawBookkeepingMessage(message: JsonObject): boolean {
	return message.role === "assistant" && message.provider === "openclaw" &&
		typeof message.model === "string" && OPENCLAW_BOOKKEEPING_MODELS.has(message.model);
}

/** Shared Pi-format message projection, with adapter-owned source identities. */
export function piMessageDrafts(
	message: JsonObject,
	{ source, recordId, timestamp, model: fallbackModel }: PiMessageContext,
): SessionEventDraft[] {
	const role = jsonString(message.role);
	const value = message.timestamp;
	const messageTimestamp =
		typeof value === "number" && Number.isFinite(value)
			? validTimestamp(value)
			: timestamp
				? validTimestamp(timestamp)
				: undefined;
	if (role === "user" || role === "system" || role === "developer") {
		const parts = visibleContentParts(message.content);
		const drafts: SessionEventDraft[] =
			parts.length > 0
				? [
						{
							type: "message",
							role,
							parts,
							source: source(),
							...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
						},
					]
				: [];
		if (role === "user" && Array.isArray(message.content)) {
			for (let index = 0; index < message.content.length; index++) {
				const block = jsonObject(message.content[index]);
				if (block?.type !== "tool_result") continue;
				const callId = jsonString(block.tool_use_id);
				if (!callId) continue;
				drafts.push({
					type: "tool_result",
					call_id: callId,
					status: block.is_error === true ? "error" : "completed",
					...toolResultContent(block.content, block.details),
					source: source(index + 1),
					...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
				});
			}
		}
		return drafts;
	}
	if (role === "assistant") {
		if (message.stopReason === "deferred") return [];
		const content = Array.isArray(message.content) ? message.content : [];
		const model = isOpenClawBookkeepingMessage(message)
			? undefined
			: jsonString(message.model) ?? fallbackModel ?? undefined;
		const drafts: SessionEventDraft[] = [];
		const parts = visibleContentParts(message.content);
		if (parts.length > 0) {
			drafts.push({
				type: "message",
				role: "assistant",
				parts,
				source: source(0),
				...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
				...(model ? { model } : {}),
			});
		}
		for (let index = 0; index < content.length; index++) {
			const part = jsonObject(content[index]);
			if (!part) continue;
			const reasoning = reasoningContent(part);
			if (reasoning) {
				drafts.push({
					type: "reasoning",
					...reasoning,
					source: source(index + 1),
					...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
					...(model ? { model } : {}),
				});
			}
			if (part.type !== "toolCall" && part.type !== "tool_use") continue;
			const callId = jsonString(part.id);
			const name = jsonString(part.name);
			if (!callId || !name) continue;
			drafts.push({
				type: "tool_call",
				call_id: callId,
				name,
				arguments_json: canonicalStructuredString(part.arguments ?? part.input),
				source: source(index + 1),
				...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
				...(model ? { model } : {}),
			});
			const toolThought = reasoningContent({
				type: "redacted_thinking",
				signature: part.thoughtSignature,
			});
			if (toolThought) {
				drafts.push({
					type: "reasoning",
					...toolThought,
					source: source(index + 1),
					...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
					...(model ? { model } : {}),
				});
			}
		}
		return drafts;
	}
	if (role === "toolResult") {
		const callId = jsonString(message.toolCallId);
		if (!callId) return [];
		const result = toolResultContent(message.content, message.details);
		const toolName = jsonString(message.toolName);
		const drafts: SessionEventDraft[] = [
			{
				type: "tool_result",
				call_id: callId,
				...(toolName ? { name: toolName } : {}),
				status: message.isError === true ? "error" : "completed",
				...result,
				source: source(),
				...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
			},
		];
		const details = jsonObject(message.details);
		const privateState = reasoningContent({
			type: "redacted_thinking",
			signature: details?.thinkingSignature ?? details?.thoughtSignature,
		});
		if (privateState) {
			drafts.push({
				type: "reasoning",
				...privateState,
				source: source(1),
				...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
			});
		}
		return drafts;
	}
	if (role === "bashExecution") {
		const command = jsonString(message.command);
		if (!command) return [];
		const callId = `pi-shell-${recordId}`;
		const output = typeof message.output === "string" ? message.output : "";
		return [
			{
				type: "tool_call",
				call_id: callId,
				name: "shell",
				arguments_json: canonicalStructuredString({ command }),
				source: source(0),
				...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
			},
			{
				type: "tool_result",
				call_id: callId,
				name: "shell",
				status:
					message.cancelled === true ||
					(typeof message.exitCode === "number" && Number.isFinite(message.exitCode)
						? message.exitCode
						: 0) !== 0
						? "error"
						: "completed",
				parts: output ? [{ type: "text", text: output }] : [],
				source: source(1),
				...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
			},
		];
	}
	if (role === "custom" && message.display === true) {
		const parts = visibleContentParts(message.content);
		return parts.length > 0
			? [
					{
						type: "message",
						role: "system",
						parts,
						source: source(),
						...(messageTimestamp ? { timestamp: messageTimestamp } : {}),
					},
				]
			: [];
	}
	return [];
}
