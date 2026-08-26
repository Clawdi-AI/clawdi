import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { safeTruncate } from "../lib/sanitize";
import { durationSecondsBetween } from "../lib/session-duration";
import {
	projectEventsToMessages,
	type SessionEventDraft,
	sequenceSessionEvents,
} from "../lib/session-events";
import { extractTarGz } from "../lib/tar";
import { managedSkillDirectoryDigest } from "../runtime/hosted-bundled-skill";
import {
	collectManagedSkillTree,
	managedSkillTreesEqual,
	withManagedTargetRollback,
} from "../runtime/managed-skill-delivery";
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
import {
	listOpenClawAgentWorkspaces,
	openClawAgentId,
	resolveOpenClawAgentWorkspace,
} from "./openclaw-workspace";
import { getOpenClawHome, isPathWithinRoots, SKIP_DIRS } from "./paths";
import {
	canonicalStructuredString,
	completeJsonlRecords,
	type JsonObject,
	jsonObject,
	jsonString,
	stableRecordId,
	toolResultContent,
	visibleContentParts,
} from "./rich-event-mapping";
import { readCommandVersion } from "./version";

function openclawDir() {
	return getOpenClawHome();
}
function agentsRoot() {
	return join(openclawDir(), "agents");
}
function agentId() {
	return openClawAgentId();
}
function agentDir() {
	// Single-agent path used for *write* operations (skill install, MCP
	// command building). Reads enumerate every agent dir via `listAgentDirs`.
	return join(agentsRoot(), agentId());
}
function sessionsDir() {
	return join(agentDir(), "sessions");
}
function sessionsIndexPath() {
	return join(sessionsDir(), "sessions.json");
}
function activeAgentWorkspace() {
	return resolveOpenClawAgentWorkspace(agentId());
}

function skillsDir() {
	return join(activeAgentWorkspace(), "skills");
}

/**
 * Enumerate every `agents/<id>` subdir we should read from. OpenClaw can
 * host many agent personalities side-by-side (see issue #28: a single state
 * root with `main`, `financial`, `sales`, etc.) so we union them. Honoring
 * `OPENCLAW_AGENT_ID` as a single-agent override keeps the explicit-project
 * escape hatch from the issue's workaround.
 */
function listAgentDirs(): string[] {
	const root = agentsRoot();
	if (!existsSync(root)) return [];
	const override = process.env.OPENCLAW_AGENT_ID?.trim();
	if (override) {
		const dir = join(root, override);
		return existsSync(dir) ? [dir] : [];
	}
	try {
		return readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory() && !d.name.startsWith("."))
			.map((d) => join(root, d.name));
	} catch (e) {
		// `agents/` is present but unreadable (perm bits, encrypted-at-rest,
		// stale fuse mount, …). Silently treating that as "no agents" hides
		// the fact that we actively skipped data — surface it on stderr so
		// `clawdi push` doesn't appear to succeed with 0 sessions.
		console.warn(
			`[openclaw] could not enumerate ${root}: ${e instanceof Error ? e.message : String(e)}`,
		);
		return [];
	}
}

interface SessionEntry {
	// Real openclaw indexes key entries by composite strings like
	// `agent:main:main` or `agent:main:telegram:group:-100…:topic:1`, with
	// the actual UUID stored in this field. Treat the index key as a label
	// only and trust `sessionId` for the localSessionId we publish.
	sessionId?: string;
	updatedAt?: number;
	// May be absolute (production openclaw writes the full `/data/openclaw/…`
	// path) or relative to the agent's `sessions/` dir (older fixtures).
	sessionFile?: string;
	model?: string;
	modelProvider?: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	displayName?: string;
	subject?: string;
	label?: string;
	acp?: { cwd?: string; lastActivityAt?: number };
}

interface TranscriptLine {
	type?: string;
	timestamp?: string | number;
	message?: {
		role?: string;
		content?: string | Array<{ type: string; text?: string }>;
	};
	provider?: string;
	modelId?: string;
}

function openClawEventDrafts(
	raw: JsonObject,
	sessionKey: string,
	recordSeq: number,
	currentModel: string | null,
): SessionEventDraft[] {
	const timestampValue = raw.timestamp;
	const timestamp =
		typeof timestampValue === "number"
			? new Date(timestampValue).toISOString()
			: (jsonString(timestampValue) ?? undefined);
	const recordId = stableRecordId(raw, recordSeq);
	const eventSource = (partIndex?: number) => ({
		adapter: "openclaw" as const,
		session_key: sessionKey,
		record_id: recordId,
		record_seq: recordSeq,
		...(partIndex === undefined ? {} : { part_index: partIndex }),
	});
	if (raw.type === "model_change") {
		const model = jsonString(raw.modelId);
		return model
			? [
					{
						type: "message",
						role: "system",
						parts: [{ type: "text", text: `Model changed to ${model}.` }],
						model,
						source: eventSource(),
						...(timestamp ? { timestamp } : {}),
					},
				]
			: [];
	}
	if (raw.type !== "message") return [];
	const message = jsonObject(raw.message);
	if (!message) return [];
	const role = jsonString(message.role);
	const model = jsonString(message.model) ?? currentModel ?? undefined;
	const drafts: SessionEventDraft[] = [];
	if (role === "user" || role === "assistant" || role === "system" || role === "developer") {
		const parts = visibleContentParts(message.content);
		if (parts.length > 0) {
			drafts.push({
				type: "message",
				role,
				parts,
				source: eventSource(0),
				...(timestamp ? { timestamp } : {}),
				...(role === "assistant" && model ? { model } : {}),
			});
		}
	}
	const blocks = Array.isArray(message.content) ? message.content : [];
	for (let index = 0; index < blocks.length; index++) {
		const block = jsonObject(blocks[index]);
		if (!block) continue;
		if (role === "assistant" && (block.type === "toolCall" || block.type === "tool_use")) {
			const callId = jsonString(block.id);
			const name = jsonString(block.name);
			if (!callId || !name) continue;
			drafts.push({
				type: "tool_call",
				call_id: callId,
				name,
				arguments_json: canonicalStructuredString(block.arguments ?? block.input),
				source: eventSource(index + 1),
				...(timestamp ? { timestamp } : {}),
				...(model ? { model } : {}),
			});
		}
		if (role === "user" && block.type === "tool_result") {
			const callId = jsonString(block.tool_use_id);
			if (!callId) continue;
			drafts.push({
				type: "tool_result",
				call_id: callId,
				status: block.is_error === true ? "error" : "completed",
				...toolResultContent(block.content, block.details),
				source: eventSource(index + 1),
				...(timestamp ? { timestamp } : {}),
			});
		}
	}
	if (role === "toolResult") {
		const callId = jsonString(message.toolCallId);
		if (callId)
			drafts.push({
				type: "tool_result",
				call_id: callId,
				...(jsonString(message.toolName) ? { name: jsonString(message.toolName) as string } : {}),
				status: message.isError === true ? "error" : "completed",
				...toolResultContent(message.content, message.details),
				source: eventSource(),
				...(timestamp ? { timestamp } : {}),
			});
	}
	// OpenClaw `thinking` blocks are intentionally ignored.
	return drafts;
}

export class OpenClawAdapter implements AgentAdapterCore {
	readonly agentType = "openclaw" as const;
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
		// OpenClaw creates `agents/{id}/` per agent. Detection succeeds when
		// the state root has at least one agent dir, or the configured agent's
		// session index exists. Accepting any agent dir is what makes deployments
		// like `/data/openclaw/agents/{main,financial,sales,...}` work without
		// the user setting `OPENCLAW_AGENT_ID` per agent (issue #28).
		if (!existsSync(openclawDir())) return false;
		if (existsSync(sessionsIndexPath())) return true;
		return listAgentDirs().length > 0;
	}

	async getVersion(): Promise<string | null> {
		return (
			readCommandVersion("openclaw", ["--version"]) ?? readCommandVersion("openclaw", ["--help"])
		);
	}

	private async collectSessions(request: SessionScanRequest): Promise<SessionScanResult> {
		if (request.kind === "complete") {
			const { result } = await this.collectSessionsMatching(request);
			return { ...result, coverage: "complete" };
		}
		if (request.paths.length === 0) {
			return this.collectSessions({ kind: "complete", projectFilter: request.projectFilter });
		}
		const sessionRoots = listAgentDirs().map((dir) => resolve(dir, "sessions"));
		const transcriptPaths = new Set<string>();
		for (const path of request.paths) {
			const normalized = resolve(path);
			if (
				!isPathWithinRoots(normalized, sessionRoots) ||
				basename(normalized) === "sessions.json" ||
				!normalized.endsWith(".jsonl")
			) {
				return this.collectSessions({ kind: "complete", projectFilter: request.projectFilter });
			}
			transcriptPaths.add(normalized);
		}

		const collection = await this.collectSessionsMatching(request, transcriptPaths);
		for (const path of transcriptPaths) {
			if (existsSync(path) && !collection.matchedTranscriptPaths.has(path)) {
				return this.collectSessions({ kind: "complete", projectFilter: request.projectFilter });
			}
		}
		return { ...collection.result, coverage: "partial" };
	}

	private async resolveSession(localSessionId: string): Promise<RawSession | null> {
		return (
			(await this.collectSessionsMatching({}, undefined, localSessionId)).result.sessions[0] ?? null
		);
	}

	private async collectSessionsMatching(
		opts: { projectFilter?: string },
		transcriptPaths?: ReadonlySet<string>,
		localSessionId?: string,
	): Promise<{
		result: Pick<SessionScanResult, "sessions" | "dedupedCount">;
		matchedTranscriptPaths: Set<string>;
	}> {
		const agentDirs = listAgentDirs();
		if (agentDirs.length === 0) {
			return {
				result: { sessions: [], dedupedCount: 0 },
				matchedTranscriptPaths: new Set(),
			};
		}

		const { projectFilter } = opts;
		let absFilter: string | null = null;
		if (projectFilter) {
			const { resolve } = await import("node:path");
			absFilter = resolve(projectFilter);
		}

		const sessions: RawSession[] = [];
		const matchedTranscriptPaths = new Set<string>();

		for (const agentRoot of agentDirs) {
			const sourceAgentId = basename(agentRoot);
			const sessionsDirForAgent = join(agentRoot, "sessions");
			const indexPath = join(sessionsDirForAgent, "sessions.json");
			if (!existsSync(indexPath)) continue;

			let index: Record<string, SessionEntry>;
			try {
				index = JSON.parse(readFileSync(indexPath, "utf-8"));
			} catch {
				continue;
			}

			for (const [indexKey, entry] of Object.entries(index)) {
				// Prefer the entry's own `sessionId` (real UUID); fall back to
				// the index key only for legacy fixtures that use the UUID as
				// the key directly.
				const sessionId = entry.sessionId ?? indexKey;
				if (localSessionId !== undefined && sessionId !== localSessionId) continue;
				const updatedAt = entry.updatedAt ?? entry.acp?.lastActivityAt;
				if (!updatedAt) continue;

				const projectPath = entry.acp?.cwd ?? null;
				if (absFilter) {
					if (!projectPath) continue;
					if (projectPath !== absFilter && !projectPath.startsWith(`${absFilter}/`)) continue;
				}

				const transcriptPath = entry.sessionFile
					? isAbsolute(entry.sessionFile)
						? entry.sessionFile
						: join(sessionsDirForAgent, entry.sessionFile)
					: join(sessionsDirForAgent, `${sessionId}.jsonl`);
				const normalizedTranscriptPath = resolve(transcriptPath);
				if (transcriptPaths && !transcriptPaths.has(normalizedTranscriptPath)) continue;
				if (transcriptPaths) matchedTranscriptPaths.add(normalizedTranscriptPath);

				let events = [] as import("./base").SessionEvent[];
				let startedAt: Date | null = null;
				let endedAt: Date | null = null;
				const modelsUsed = new Set<string>();
				if (entry.model) modelsUsed.add(entry.model);
				let currentModel = entry.model ?? null;

				if (!existsSync(transcriptPath)) {
					if (entry.sessionFile) {
						// Index points at an absolute or relative transcript that we
						// can't reach from this process (different mount, stale path,
						// path-join bug regression). Surface it instead of silently
						// dropping the session.
						console.warn(`[openclaw] transcript missing for ${sessionId}: ${transcriptPath}`);
					}
				} else {
					try {
						const transcriptContent = readFileSync(transcriptPath, "utf-8");
						const drafts: SessionEventDraft[] = [];
						for (const { data: raw, recordSeq } of completeJsonlRecords(transcriptContent)) {
							const parsed = raw as TranscriptLine;
							drafts.push(
								...openClawEventDrafts(
									raw,
									`${sourceAgentId}:${sessionId}`,
									recordSeq,
									currentModel,
								),
							);

							const ts = parsed.timestamp
								? new Date(
										typeof parsed.timestamp === "number" ? parsed.timestamp : parsed.timestamp,
									)
								: null;
							if (ts && !Number.isNaN(ts.getTime())) {
								if (!startedAt) startedAt = ts;
								endedAt = ts;
							}

							// `model_change` payload shape is inferred from the pi-coding-agent
							// types; not verified against a live OpenClaw transcript. Defensive.
							if (parsed.type === "model_change" && parsed.modelId) {
								modelsUsed.add(parsed.modelId);
								currentModel = parsed.modelId;
							}
						}
						events = sequenceSessionEvents(drafts);
					} catch {
						// Unreadable transcript — fall through with whatever we have.
					}
				}

				const messages = projectEventsToMessages(events);
				if (messages.length === 0) continue;

				// Defensive fallback: a transcript with messages but no timestamps at all
				// shouldn't happen in practice, but keep the session recoverable via the
				// index's updatedAt rather than throwing.
				startedAt ??= new Date(updatedAt);
				endedAt ??= new Date(updatedAt);

				const durationSeconds = durationSecondsBetween(startedAt, endedAt);

				const firstUserContent = messages.find((m) => m.role === "user")?.content;
				const summary =
					entry.displayName ??
					entry.subject ??
					entry.label ??
					(firstUserContent === undefined ? null : safeTruncate(firstUserContent, 200));

				sessions.push({
					localSessionId: sessionId,
					projectPath,
					startedAt,
					endedAt,
					messageCount: messages.length,
					inputTokens: entry.inputTokens ?? 0,
					outputTokens: entry.outputTokens ?? 0,
					cacheReadTokens: entry.cacheRead ?? 0,
					model: currentModel,
					modelsUsed: [...modelsUsed],
					durationSeconds,
					summary,
					messages,
					events,
					rawFilePath: existsSync(transcriptPath) ? transcriptPath : indexPath,
				});
			}
		}

		// OpenClaw stores one session per ACP transcript with stable sessionIds
		// — no resume-chain duplication to dedupe.
		return {
			result: { sessions, dedupedCount: 0 },
			matchedTranscriptPaths,
		};
	}

	private async collectSkills(): Promise<RawSkill[]> {
		const skills: RawSkill[] = [];
		const seen = new Map<string, string>(); // skillKey → first-winning agentDir
		migrateLegacyLocalSetupSkill({
			targetDir: join(skillsDir(), "clawdi"),
			id: "clawdi",
			version: 1,
			digest: managedSkillDirectoryDigest,
		});

		// Skills live in each official agent workspace — iterate every
		// configured workspace so a deployment with multiple
		// personalities (issue #28) doesn't lose six of seven skill sets.
		// Dedup by `skillKey`: identical names across agents collapse to
		// the first occurrence (server-side `skill_key` is per-user, so
		// we'd 409 on the second push anyway). Warn on collision so the
		// user can rename or pick an explicit OPENCLAW_AGENT_ID.
		for (const agent of listOpenClawAgentWorkspaces()) {
			const dir = join(agent.workspace, "skills");
			migrateLegacyLocalSetupSkill({
				targetDir: join(dir, "clawdi"),
				id: "clawdi",
				version: 1,
				digest: managedSkillDirectoryDigest,
			});
			if (!existsSync(dir)) continue;

			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				if (entry.name.startsWith(".")) continue;
				if (SKIP_DIRS.has(entry.name)) continue;
				const dirPath = join(dir, entry.name);
				if (shouldIgnoreUserSkill(dirPath, entry.name)) continue;
				const skillMd = join(dirPath, "SKILL.md");
				if (!existsSync(skillMd)) continue;

				const existing = seen.get(entry.name);
				if (existing) {
					console.warn(
						`[openclaw] skipping duplicate skill "${entry.name}" at ${dirPath} ` +
							`(already collected from ${existing}). Set OPENCLAW_AGENT_ID to project explicitly.`,
					);
					continue;
				}

				const content = readFileSync(skillMd, "utf-8");
				const fileCount = readdirSync(dirPath, { recursive: true }).length;

				seen.set(entry.name, dirPath);
				skills.push({
					skillKey: entry.name,
					name: entry.name,
					content,
					filePath: skillMd,
					directoryPath: dirPath,
					isDirectory: fileCount > 1,
				});
			}
		}
		return skills;
	}

	private getSkillPath(key: string): string {
		return join(skillsDir(), key, "SKILL.md");
	}

	private getSkillsRootDir(): string {
		return skillsDir();
	}

	private getSharedSkillPath(skillKey: string, ownerHandle: string): string {
		return join(skillsDir(), `${skillKey}__${ownerHandle}`);
	}

	private async listSkillKeys(): Promise<string[]> {
		// Restricted to the CURRENT agent's `skillsDir()` —
		// `collectSkills` walks every agent dir for `clawdi push`
		// (one-shot, batch view), but the daemon's hot path is
		// strictly single-agent: it hashes/tars
		// `join(getSkillsRootDir(), key)` where rootDir is JUST
		// the current agent. Returning skills from sibling agent
		// dirs would point the daemon at paths it can't resolve,
		// silently dropping those skills. Pre-fix the cross-agent
		// enumerator silently lost OpenClaw skills under any
		// agent other than the active one.
		const root = skillsDir();
		migrateLegacyLocalSetupSkill({
			targetDir: join(root, "clawdi"),
			id: "clawdi",
			version: 1,
			digest: managedSkillDirectoryDigest,
		});
		if (!existsSync(root)) return [];
		const out: string[] = [];
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".")) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			if (shouldIgnoreUserSkill(join(root, entry.name), entry.name)) continue;
			const skillMd = join(root, entry.name, "SKILL.md");
			if (!existsSync(skillMd)) continue;
			out.push(entry.name);
		}
		return out;
	}

	private getSessionsWatchPaths(): string[] {
		const paths = listAgentDirs()
			.map((dir) => join(dir, "sessions"))
			.filter((path) => existsSync(path));
		return paths.length > 0 ? paths : [sessionsDir()];
	}

	private async removeLocalSkill(key: string): Promise<void> {
		const dir = join(skillsDir(), key);
		mutateUserSkillTarget(dir, key, () => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		});
	}

	private async writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void> {
		await this.installOfficialSkillArchive(key, key, tarGzBytes);
	}

	private async installOfficialSkillArchive(
		archiveKey: string,
		installedSlug: string,
		tarGzBytes: Buffer,
	): Promise<void> {
		const workspace = activeAgentWorkspace();
		const targetDir = join(workspace, "skills", installedSlug);
		const stagingRoot = mkdtempSync(join(tmpdir(), "clawdi-openclaw-install-"));
		try {
			await extractTarGz(stagingRoot, tarGzBytes);
			const sourceDir = join(stagingRoot, archiveKey);
			if (!existsSync(join(sourceDir, "SKILL.md")))
				throw new Error("Skill archive is missing SKILL.md");
			mutateUserSkillTarget(targetDir, installedSlug, () =>
				withManagedTargetRollback({
					target: targetDir,
					operation: () => {
						const result = spawnSync(
							"openclaw",
							[
								"skills",
								"install",
								sourceDir,
								"--agent",
								agentId(),
								"--as",
								installedSlug,
								"--force",
							],
							{
								encoding: "utf8",
								env: process.env,
								maxBuffer: 1024 * 1024,
								timeout: 120_000,
							},
						);
						if (result.status !== 0) {
							throw new Error(
								`OpenClaw official Skill install failed: ${(result.stderr || result.stdout).trim() || "unknown error"}`,
							);
						}
						if (activeAgentWorkspace() !== workspace) {
							throw new Error("OpenClaw agent workspace changed during Skill install");
						}
						const sourceTree = collectManagedSkillTree(sourceDir);
						const installedTree = collectManagedSkillTree(targetDir, {
							exclude: new Set([".openclaw/source-origin.json"]),
						});
						if (sourceTree.status !== "collected") {
							throw new Error(`OpenClaw Skill source tree is ${sourceTree.status}`);
						}
						if (installedTree.status !== "collected") {
							throw new Error(`OpenClaw installed Skill tree is ${installedTree.status}`);
						}
						if (!managedSkillTreesEqual(sourceTree.tree, installedTree.tree)) {
							throw new Error(`OpenClaw installed an unexpected Skill tree in ${workspace}`);
						}
					},
				}),
			);
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	private async writeSharedSkillArchive(
		key: string,
		ownerHandle: string,
		tarGzBytes: Buffer,
	): Promise<void> {
		await this.installOfficialSkillArchive(key, `${key}__${ownerHandle}`, tarGzBytes);
	}
}
