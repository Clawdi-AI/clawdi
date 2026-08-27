import { type Dirent, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { safeTruncate } from "../lib/sanitize";
import { durationSecondsBetween } from "../lib/session-duration";
import {
	projectEventsToMessages,
	type SessionEventDraft,
	sequenceSessionEvents,
} from "../lib/session-events";
import { replaceSkillArchiveTarGz } from "../lib/tar";
import { managedSkillDirectoryDigest } from "../runtime/hosted-bundled-skill";
import {
	migrateLegacyLocalSetupSkill,
	mutateUserSkillTarget,
	shouldIgnoreUserSkill,
} from "../runtime/managed-skill-reservation";
import type {
	AgentAdapterCore,
	RawSession,
	RawSkill,
	SessionScanRequest,
	SessionScanResult,
} from "./base";
import { getCodexHome, isPathWithinRoots, SKIP_DIRS } from "./paths";
import {
	canonicalStructuredString,
	completeJsonlRecords,
	type JsonObject,
	jsonObject,
	jsonString,
	reasoningContent,
	stableRecordId,
	toolResultContent,
	visibleContentParts,
} from "./rich-event-mapping";
import { readCommandVersion } from "./version";

function codexDir() {
	return getCodexHome();
}
function sessionsDir() {
	return join(codexDir(), "sessions");
}
function archivedSessionsDir() {
	return join(codexDir(), "archived_sessions");
}
function sessionRoots() {
	return [sessionsDir(), archivedSessionsDir()];
}
function skillsDir() {
	return join(codexDir(), "skills");
}

interface SessionLine {
	timestamp?: string;
	type?: string;
	payload?: {
		type?: string;
		id?: string;
		timestamp?: string;
		cwd?: string;
		role?: string;
		content?: Array<{ type: string; text?: string }> | string;
		model?: string;
		info?: {
			total_token_usage?: {
				input_tokens?: number;
				output_tokens?: number;
				cached_input_tokens?: number;
			};
		};
	};
}

function codexEventDrafts(
	raw: JsonObject,
	sessionKey: string,
	recordSeq: number,
): SessionEventDraft[] {
	if (raw.type !== "response_item") return [];
	const payload = jsonObject(raw.payload);
	if (!payload) return [];
	const payloadType = jsonString(payload.type);
	const timestamp = jsonString(raw.timestamp) ?? undefined;
	const recordId =
		jsonString(payload.id) ?? jsonString(payload.call_id) ?? stableRecordId(raw, recordSeq);
	const eventSource = (partIndex?: number) => ({
		adapter: "codex" as const,
		session_key: sessionKey,
		record_id: recordId,
		record_seq: recordSeq,
		...(partIndex === undefined ? {} : { part_index: partIndex }),
	});
	if (payloadType === "message") {
		const role = jsonString(payload.role);
		if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer") {
			return [];
		}
		const parts = visibleContentParts(payload.content);
		return parts.length > 0
			? [
					{
						type: "message",
						role,
						parts,
						source: eventSource(),
						...(timestamp ? { timestamp } : {}),
					},
				]
			: [];
	}
	if (payloadType === "reasoning") {
		const reasoning = reasoningContent(payload);
		return reasoning
			? [
					{
						type: "reasoning",
						...reasoning,
						source: eventSource(),
						...(timestamp ? { timestamp } : {}),
					},
				]
			: [];
	}
	if (payloadType === "function_call" || payloadType === "custom_tool_call") {
		const callId = jsonString(payload.call_id) ?? jsonString(payload.id);
		const name = jsonString(payload.name);
		if (!callId || !name) return [];
		return [
			{
				type: "tool_call",
				call_id: callId,
				name,
				arguments_json: canonicalStructuredString(
					payloadType === "function_call" ? payload.arguments : payload.input,
				),
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
		const callId = jsonString(payload.call_id) ?? jsonString(payload.id);
		if (!callId) return [];
		const result = toolResultContent(payload.output);
		return [
			{
				type: "tool_result",
				call_id: callId,
				status: payload.status === "failed" ? "error" : "completed",
				...result,
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (payloadType === "tool_search_call") {
		const callId = jsonString(payload.call_id) ?? jsonString(payload.id);
		if (!callId) return [];
		return [
			{
				type: "tool_call",
				call_id: callId,
				name: "tool_search",
				arguments_json: canonicalStructuredString({
					execution: payload.execution,
					arguments: payload.arguments,
				}),
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (payloadType === "tool_search_output") {
		const callId = jsonString(payload.call_id) ?? jsonString(payload.id);
		if (!callId) return [];
		return [
			{
				type: "tool_result",
				call_id: callId,
				name: "tool_search",
				status: payload.status === "failed" ? "error" : "completed",
				...toolResultContent(undefined, {
					execution: payload.execution,
					tools: payload.tools,
				}),
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (payloadType === "image_generation_call") {
		const callId = jsonString(payload.id) ?? recordId;
		const result = toolResultContent([
			{
				type: "image",
				data: payload.result,
				media_type: "image/png",
				name: "generated-image.png",
			},
		]);
		return [
			{
				type: "tool_call",
				call_id: callId,
				name: "image_generation",
				arguments_json: canonicalStructuredString({ revised_prompt: payload.revised_prompt }),
				source: eventSource(0),
				...(timestamp ? { timestamp } : {}),
			},
			{
				type: "tool_result",
				call_id: callId,
				name: "image_generation",
				status: payload.status === "failed" ? "error" : "completed",
				...result,
				source: eventSource(1),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (payloadType === "agent_message") {
		const content = Array.isArray(payload.content) ? payload.content : [];
		const text = content
			.map((item) => jsonObject(item))
			.filter((item): item is JsonObject => item?.type === "input_text")
			.map((item) => jsonString(item.text))
			.filter((item): item is string => item !== null)
			.join("\n");
		const author = jsonString(payload.author);
		const recipient = jsonString(payload.recipient);
		const drafts: SessionEventDraft[] = [];
		if (text && author && recipient) {
			drafts.push({
				type: "message",
				role: "developer",
				parts: [{ type: "text", text: `[Agent message from ${author} to ${recipient}]\n${text}` }],
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			});
		}
		for (let index = 0; index < content.length; index++) {
			const reasoning = reasoningContent(content[index]);
			if (!reasoning) continue;
			drafts.push({
				type: "reasoning",
				...reasoning,
				source: eventSource(index + 1),
				...(timestamp ? { timestamp } : {}),
			});
		}
		return drafts;
	}
	if (payloadType === "local_shell_call") {
		const callId = jsonString(payload.call_id) ?? jsonString(payload.id);
		if (!callId) return [];
		return [
			{
				type: "tool_call",
				call_id: callId,
				name: "shell",
				arguments_json: canonicalStructuredString(payload.action),
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	if (payloadType === "web_search_call") {
		const callId = jsonString(payload.id);
		if (!callId) return [];
		return [
			{
				type: "tool_call",
				call_id: callId,
				name: "web_search",
				arguments_json: canonicalStructuredString(payload.action),
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			},
		];
	}
	return [];
}

function bindAssistantModel(draft: SessionEventDraft, model: string | null): SessionEventDraft {
	if (
		!model ||
		draft.type === "tool_result" ||
		(draft.type === "message" && draft.role !== "assistant")
	) {
		return draft;
	}
	return { ...draft, model };
}

function collectJsonlFiles(root: string): string[] {
	const results: string[] = [];
	if (!existsSync(root)) return results;

	// Directory layout: YYYY/MM/DD/rollout-*.jsonl. Complete inventory
	// collection walks every file; watcher and queue paths use the bounded
	// collectors below.
	const walk = (dir: string) => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				results.push(full);
			}
		}
	};

	walk(root);
	return results;
}

function resolveProjectFilter(projectFilter?: string): string | null {
	return projectFilter ? resolve(projectFilter) : null;
}

function parseSessionFile(filePath: string, absFilter: string | null): RawSession | null {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
	const records = completeJsonlRecords(content);
	if (records.length === 0) return null;

	let sessionId: string | null = null;
	let projectPath: string | null = null;
	let startedAt: Date | null = null;
	let endedAt: Date | null = null;
	let lastModel: string | null = null;
	const modelsUsed = new Set<string>();
	const rawEntries: Array<{ raw: JsonObject; recordSeq: number; model: string | null }> = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;

	for (const { data: raw, recordSeq } of records) {
		const parsed = raw as SessionLine;

		const ts = parsed.timestamp ? new Date(parsed.timestamp) : null;
		if (ts && !Number.isNaN(ts.getTime())) {
			if (!startedAt) startedAt = ts;
			endedAt = ts;
		}

		if (parsed.type === "session_meta") {
			sessionId = parsed.payload?.id ?? sessionId;
			projectPath = parsed.payload?.cwd ?? projectPath;
			if (parsed.payload?.timestamp) {
				const headerTs = new Date(parsed.payload.timestamp);
				if (!Number.isNaN(headerTs.getTime())) startedAt = headerTs;
			}
			continue;
		}

		if (parsed.type === "turn_context") {
			const model = parsed.payload?.model;
			if (model) {
				lastModel = model;
				modelsUsed.add(model);
			}
			continue;
		}

		if (parsed.type === "event_msg" && parsed.payload?.type === "token_count") {
			const total = parsed.payload.info?.total_token_usage;
			if (total) {
				inputTokens = total.input_tokens ?? inputTokens;
				outputTokens = total.output_tokens ?? outputTokens;
				cacheReadTokens = total.cached_input_tokens ?? cacheReadTokens;
			}
		}
		rawEntries.push({ raw, recordSeq, model: lastModel });
	}
	if (!sessionId) return null;
	const events = sequenceSessionEvents(
		rawEntries.flatMap(({ raw, recordSeq, model }) =>
			codexEventDrafts(raw, sessionId as string, recordSeq).map((draft) =>
				bindAssistantModel(draft, model),
			),
		),
	);
	const messages = projectEventsToMessages(events);

	if (messages.length === 0 || !startedAt) return null;
	if (absFilter) {
		if (!projectPath) return null;
		if (projectPath !== absFilter && !projectPath.startsWith(`${absFilter}/`)) return null;
	}

	endedAt ??= startedAt;
	const firstRealUser = messages.find(
		(message) => message.role === "user" && !message.content.startsWith("<environment_context>"),
	);

	return {
		localSessionId: sessionId,
		projectPath,
		startedAt,
		endedAt,
		messageCount: messages.length,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		model: lastModel,
		modelsUsed: [...modelsUsed],
		durationSeconds: durationSecondsBetween(startedAt, endedAt),
		summary: firstRealUser ? safeTruncate(firstRealUser.content, 200) : null,
		messages,
		events,
		rawFilePath: filePath,
	};
}

export class CodexAdapter implements AgentAdapterCore {
	readonly agentType = "codex" as const;
	private sessionPaths = new Map<string, string>();
	readonly sessions = {
		contentProtocol: async () => "events-v1" as const,
		collect: (request: SessionScanRequest) => this.collectSessions(request),
		resolve: (localSessionId: string) => this.resolveSession(localSessionId),
		watchPaths: () => this.getSessionsWatchPaths(),
	};
	readonly skills = {
		collect: () => this.collectSkills(),
		listKeys: () => this.listSkillKeys(),
		path: (key: string) => this.getSkillPath(key),
		rootDir: () => this.getSkillsRootDir(),
		sharedPath: (skillKey: string, ownerHandle: string) =>
			this.getSharedSkillPath(skillKey, ownerHandle),
		writeArchive: (key: string, tarGzBytes: Buffer) => this.writeSkillArchive(key, tarGzBytes),
		writeSharedArchive: (key: string, ownerHandle: string, tarGzBytes: Buffer) =>
			this.writeSharedSkillArchive(key, ownerHandle, tarGzBytes),
		remove: (key: string) => this.removeLocalSkill(key),
	};

	async detect(): Promise<boolean> {
		// Bare `~/.codex/` could be a leftover. Require either the sessions
		// dir (created on first `codex` run) or `config.toml` (created when
		// the user edits codex config).
		if (!existsSync(codexDir())) return false;
		return (
			existsSync(sessionsDir()) ||
			existsSync(archivedSessionsDir()) ||
			existsSync(join(codexDir(), "config.toml"))
		);
	}

	async getVersion(): Promise<string | null> {
		return readCommandVersion("codex", ["--version"]);
	}

	private async collectSessions(request: SessionScanRequest): Promise<SessionScanResult> {
		const absFilter = resolveProjectFilter(request.projectFilter);
		if (request.kind === "paths") {
			if (request.paths.length === 0) {
				return this.collectSessions({ kind: "complete", projectFilter: request.projectFilter });
			}
			const roots = sessionRoots().map((root) => resolve(root));
			const files = new Set<string>();
			for (const path of request.paths.map((candidate) => resolve(candidate))) {
				if (!isPathWithinRoots(path, roots) || !path.endsWith(".jsonl")) {
					return this.collectSessions({ kind: "complete", projectFilter: request.projectFilter });
				}
				for (const [sessionId, knownPath] of this.sessionPaths) {
					if (knownPath === path && !existsSync(path)) this.sessionPaths.delete(sessionId);
				}
				if (existsSync(path)) files.add(path);
			}
			const sessionsById = new Map<string, RawSession>();
			for (const filePath of files) {
				const session = parseSessionFile(filePath, absFilter);
				if (session) {
					sessionsById.set(session.localSessionId, session);
					this.sessionPaths.set(session.localSessionId, filePath);
				}
			}
			return { sessions: [...sessionsById.values()], dedupedCount: 0, coverage: "partial" };
		}

		const sessionsById = new Map<string, RawSession>();
		const pathsById = new Map<string, string>();
		for (const root of sessionRoots()) {
			for (const filePath of collectJsonlFiles(root)) {
				const session = parseSessionFile(filePath, absFilter);
				if (session && !sessionsById.has(session.localSessionId)) {
					sessionsById.set(session.localSessionId, session);
					pathsById.set(session.localSessionId, filePath);
				}
			}
		}
		if (request.projectFilter) {
			for (const [sessionId, path] of pathsById) this.sessionPaths.set(sessionId, path);
		} else {
			this.sessionPaths = pathsById;
		}

		// Codex stores long-conversation history via in-file `compacted`
		// entries rather than spawning new sessionId files, so it cannot
		// produce the resume-chain duplication that ClaudeCodeAdapter dedupes.
		return { sessions: [...sessionsById.values()], dedupedCount: 0, coverage: "complete" };
	}

	private async resolveSession(localSessionId: string): Promise<RawSession | null> {
		const knownPath = this.sessionPaths.get(localSessionId);
		if (knownPath) {
			const current = parseSessionFile(knownPath, null);
			if (current?.localSessionId === localSessionId) return current;
			this.sessionPaths.delete(localSessionId);
		}
		return (
			(await this.collectSessions({ kind: "complete" })).sessions.find(
				(session) => session.localSessionId === localSessionId,
			) ?? null
		);
	}

	private async collectSkills(): Promise<RawSkill[]> {
		migrateLegacyLocalSetupSkill({
			targetDir: join(skillsDir(), "clawdi"),
			id: "clawdi",
			version: 1,
			digest: managedSkillDirectoryDigest,
		});
		if (!existsSync(skillsDir())) return [];

		const skills: RawSkill[] = [];
		for (const entry of readdirSync(skillsDir(), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			// Skip dot-dirs (e.g. `.system/` holds Codex's built-in skills, not user-authored ones).
			if (entry.name.startsWith(".")) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			const dirPath = join(skillsDir(), entry.name);
			if (shouldIgnoreUserSkill(dirPath, entry.name)) continue;
			const skillMd = join(dirPath, "SKILL.md");
			if (!existsSync(skillMd)) continue;

			const content = readFileSync(skillMd, "utf-8");
			const fileCount = readdirSync(dirPath, { recursive: true }).length;

			skills.push({
				skillKey: entry.name,
				name: entry.name,
				content,
				filePath: skillMd,
				directoryPath: dirPath,
				isDirectory: fileCount > 1,
			});
		}
		return skills;
	}

	private getSkillPath(key: string): string {
		return join(skillsDir(), key, "SKILL.md");
	}

	private async listSkillKeys(): Promise<string[]> {
		// Flat layout. Mirrors `collectSkills` filtering so the
		// daemon's rescan and the bulk push see the same set.
		migrateLegacyLocalSetupSkill({
			targetDir: join(skillsDir(), "clawdi"),
			id: "clawdi",
			version: 1,
			digest: managedSkillDirectoryDigest,
		});
		if (!existsSync(skillsDir())) return [];
		const out: string[] = [];
		for (const entry of readdirSync(skillsDir(), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".")) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			if (shouldIgnoreUserSkill(join(skillsDir(), entry.name), entry.name)) continue;
			const skillMd = join(skillsDir(), entry.name, "SKILL.md");
			if (!existsSync(skillMd)) continue;
			out.push(entry.name);
		}
		return out;
	}

	private getSkillsRootDir(): string {
		return skillsDir();
	}

	private getSharedSkillPath(skillKey: string, ownerHandle: string): string {
		return join(skillsDir(), `${skillKey}__${ownerHandle}`);
	}

	private getSessionsWatchPaths(): string[] {
		const existingRoots = sessionRoots().filter((root) => existsSync(root));
		return existingRoots.length > 0 ? existingRoots : [sessionsDir()];
	}

	private async removeLocalSkill(key: string): Promise<void> {
		const dir = join(skillsDir(), key);
		mutateUserSkillTarget(dir, key, () => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		});
	}

	private async writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void> {
		const root = skillsDir();
		const targetDir = join(root, key);
		await replaceSkillArchiveTarGz(key, root, targetDir, tarGzBytes, undefined, (mutation) =>
			mutateUserSkillTarget(targetDir, key, mutation),
		);
	}

	private async writeSharedSkillArchive(
		key: string,
		ownerHandle: string,
		tarGzBytes: Buffer,
	): Promise<void> {
		await replaceSkillArchiveTarGz(
			key,
			this.getSkillsRootDir(),
			this.getSharedSkillPath(key, ownerHandle),
			tarGzBytes,
		);
	}
}
