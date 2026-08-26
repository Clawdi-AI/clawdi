import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
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
import { getClaudeHome, isPathWithinRoots, SKIP_DIRS } from "./paths";
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

function claudeDir() {
	return getClaudeHome();
}
function projectsDir() {
	return join(claudeDir(), "projects");
}

interface SessionJsonlEntry {
	type?: string;
	message?: {
		role?: string;
		model?: string;
		content?: string | Array<{ type: string; text?: string }>;
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
		};
	};
	timestamp?: string;
	sessionId?: string;
	cwd?: string;
	version?: string;
	uuid?: string;
}

function claudeEventDrafts(
	raw: JsonObject,
	sessionKey: string,
	recordSeq: number,
): SessionEventDraft[] {
	const message = jsonObject(raw.message);
	if (!message) return [];
	const role = jsonString(message.role);
	const timestamp = jsonString(raw.timestamp) ?? undefined;
	const model = jsonString(message.model) ?? undefined;
	const recordId = stableRecordId(raw, recordSeq);
	const eventSource = (partIndex?: number) => ({
		adapter: "claude_code" as const,
		session_key: sessionKey,
		record_id: recordId,
		record_seq: recordSeq,
		...(partIndex === undefined ? {} : { part_index: partIndex }),
	});
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
		if (role === "assistant" && block.type === "tool_use") {
			const callId = jsonString(block.id);
			const name = jsonString(block.name);
			if (!callId || !name) continue;
			drafts.push({
				type: "tool_call",
				call_id: callId,
				name,
				arguments_json: canonicalStructuredString(block.input),
				source: eventSource(index + 1),
				...(timestamp ? { timestamp } : {}),
				...(model ? { model } : {}),
			});
		}
		if (role === "user" && block.type === "tool_result") {
			const callId = jsonString(block.tool_use_id);
			if (!callId) continue;
			const result = toolResultContent(block.content);
			drafts.push({
				type: "tool_result",
				call_id: callId,
				status: block.is_error === true ? "error" : "completed",
				...result,
				source: eventSource(index + 1),
				...(timestamp ? { timestamp } : {}),
			});
		}
		// `thinking` and `redacted_thinking` blocks never produce events.
	}
	return drafts;
}

/**
 * Internal-only intermediate shape produced by `parseSessionJsonl`. The
 * `uuidSet` lives in a sibling `Map<RawSession, Set<string>>` for the dedupe
 * pass and never leaves this module — it does NOT become part of `RawSession`.
 */
type ParsedSession = Omit<RawSession, "localSessionId" | "rawFilePath"> & {
	uuidSet: Set<string>;
};

export class ClaudeCodeAdapter implements AgentAdapterCore {
	readonly agentType = "claude_code" as const;
	readonly sessions = {
		contentProtocol: "events-v1" as const,
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
		// Bare `~/.claude/` may exist from gstack/other tools or be a stale
		// leftover. Require at least one artifact that a real Claude Code
		// install creates: the projects dir (after first run), settings.json
		// (configured via the IDE), or a top-level CLAUDE.md.
		// Last resort: `claude --version` succeeding — covers a brand-new
		// install where the binary is in PATH but the user hasn't started a
		// session yet (none of the artifacts exist).
		if (
			existsSync(claudeDir()) &&
			(existsSync(projectsDir()) ||
				existsSync(join(claudeDir(), "settings.json")) ||
				existsSync(join(claudeDir(), "CLAUDE.md")))
		) {
			return true;
		}
		return (await this.getVersion()) !== null;
	}

	async getVersion(): Promise<string | null> {
		return readCommandVersion("claude", ["--version"]);
	}

	/**
	 * Convert absolute path to Claude Code project dir name.
	 * /Users/paco/workspace/clawdi → -Users-paco-workspace-clawdi
	 */
	private pathToProjectDir(absPath: string): string {
		return absPath.replace(/\//g, "-");
	}

	private async collectSessions(request: SessionScanRequest): Promise<SessionScanResult> {
		if (!existsSync(projectsDir())) {
			return { sessions: [], dedupedCount: 0, coverage: "complete" };
		}

		const { projectFilter } = request;
		const absFilter = projectFilter ? resolve(projectFilter) : null;
		if (request.kind === "paths") {
			const root = resolve(projectsDir());
			const projectDirNames = new Set<string>();
			for (const candidate of request.paths) {
				const path = resolve(candidate);
				const parts = relative(root, path).split(/[\\/]/);
				if (
					!isPathWithinRoots(path, [root]) ||
					parts.length !== 2 ||
					!parts[1].endsWith(".jsonl")
				) {
					return this.collectSessions({ kind: "complete", projectFilter });
				}
				projectDirNames.add(parts[0]);
			}
			if (projectDirNames.size > 0) {
				return this.collectProjectSessions([...projectDirNames], absFilter, "partial");
			}
		}

		let projectDirs = readdirSync(projectsDir(), { withFileTypes: true }).filter((d) =>
			d.isDirectory(),
		);

		if (absFilter) {
			const targetDir = this.pathToProjectDir(absFilter);
			// Coarse pre-filter on the encoded dir name: keep the target and any
			// dir whose name starts with "target-". Because "/" and in-segment "-"
			// both encode as "-", this superset may include sibling repos like
			// "clawdi-web" when the target is "clawdi" — those false positives
			// are dropped below using each session's real cwd.
			projectDirs = projectDirs.filter(
				(d) => d.name === targetDir || d.name.startsWith(`${targetDir}-`),
			);
		}

		return this.collectProjectSessions(
			projectDirs.map((projectDir) => projectDir.name),
			absFilter,
			"complete",
		);
	}

	private async resolveSession(localSessionId: string): Promise<RawSession | null> {
		if (!existsSync(projectsDir()) || basename(localSessionId) !== localSessionId) return null;
		const matches: Array<{ filePath: string; projectDirName: string }> = [];
		for (const projectDir of readdirSync(projectsDir(), { withFileTypes: true })) {
			if (!projectDir.isDirectory()) continue;
			const filePath = join(projectsDir(), projectDir.name, `${localSessionId}.jsonl`);
			if (existsSync(filePath)) matches.push({ filePath, projectDirName: projectDir.name });
		}
		if (matches.length !== 1) {
			if (matches.length === 0) return null;
			return (
				(await this.collectSessions({ kind: "complete" })).sessions.find(
					(session) => session.localSessionId === localSessionId,
				) ?? null
			);
		}
		return (
			this.collectProjectSessions([matches[0].projectDirName], null, "partial").sessions.find(
				(session) => session.localSessionId === localSessionId,
			) ?? null
		);
	}

	private collectProjectSessions(
		projectDirNames: readonly string[],
		absFilter: string | null,
		coverage: SessionScanResult["coverage"],
	): SessionScanResult {
		const sessions: RawSession[] = [];
		const uuidsBySession = new Map<RawSession, Set<string>>();
		for (const projectDirName of projectDirNames) {
			const projectPath = join(projectsDir(), projectDirName);
			if (!existsSync(projectPath)) continue;
			for (const file of readdirSync(projectPath).filter((name) => name.endsWith(".jsonl"))) {
				try {
					const parsed = this.parseRawSession(join(projectPath, file), projectDirName);
					if (!parsed) continue;
					const cwd = parsed.session.projectPath;
					if (absFilter && (!cwd || (cwd !== absFilter && !cwd.startsWith(`${absFilter}/`)))) {
						continue;
					}
					sessions.push(parsed.session);
					uuidsBySession.set(parsed.session, parsed.uuidSet);
				} catch {
					// Skip files that disappear or become unreadable during collection.
				}
			}
		}
		return dedupeResumeChains(sessions, uuidsBySession, coverage);
	}

	private parseRawSession(
		filePath: string,
		projectDirName: string,
	): { session: RawSession; uuidSet: Set<string> } | null {
		const parsed = this.parseSessionJsonl(filePath, projectDirName);
		if (!parsed) return null;
		const { uuidSet, ...sessionFields } = parsed;
		return {
			session: {
				...sessionFields,
				localSessionId: basename(filePath, ".jsonl"),
				rawFilePath: filePath,
			},
			uuidSet,
		};
	}

	private parseSessionJsonl(filePath: string, _projectDirName: string): ParsedSession | null {
		const content = readFileSync(filePath, "utf-8");
		const records = completeJsonlRecords(content);
		if (records.length < 3) return null;

		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let startedAt: Date | null = null;
		let endedAt: Date | null = null;
		let model: string | null = null;
		const modelsUsed = new Set<string>();
		let projectPath: string | null = null;
		let firstUserMessage: string | null = null;
		const rawEntries: Array<{ raw: JsonObject; recordSeq: number }> = [];
		const uuidSet = new Set<string>();

		for (const { data: raw, recordSeq } of records) {
			try {
				const entry = raw as SessionJsonlEntry;
				rawEntries.push({ raw, recordSeq });
				const msg = entry.message;
				const role = msg?.role;

				if (entry.uuid) uuidSet.add(entry.uuid);

				if (entry.timestamp) {
					const ts = new Date(entry.timestamp);
					if (!startedAt) startedAt = ts;
					endedAt = ts;
				}

				if (entry.cwd && !projectPath) {
					projectPath = entry.cwd;
				}

				if (role === "user" && !firstUserMessage) {
					const c = msg?.content;
					if (typeof c === "string") {
						firstUserMessage = safeTruncate(c, 200);
					} else if (Array.isArray(c)) {
						const textBlock = c.find((b) => b.type === "text" && b.text);
						if (textBlock?.text) {
							firstUserMessage = safeTruncate(textBlock.text, 200);
						}
					}
				}

				if (role === "assistant" && msg?.model) {
					modelsUsed.add(msg.model);
					model = msg.model;
				}

				if (msg?.usage) {
					inputTokens += msg.usage.input_tokens ?? 0;
					outputTokens += msg.usage.output_tokens ?? 0;
					cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
				}
			} catch {
				// Skip unparseable lines
			}
		}
		const sourceSessionKey = basename(filePath, ".jsonl");
		const events = sequenceSessionEvents(
			rawEntries.flatMap(({ raw, recordSeq }) =>
				claudeEventDrafts(raw, sourceSessionKey, recordSeq),
			),
		);
		const messages = projectEventsToMessages(events);

		if (!startedAt || messages.length === 0) return null;

		const durationSeconds = durationSecondsBetween(startedAt, endedAt);

		return {
			projectPath,
			startedAt,
			endedAt,
			messageCount: messages.length,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			model,
			modelsUsed: [...modelsUsed],
			summary: firstUserMessage,
			messages,
			events,
			durationSeconds,
			uuidSet,
		};
	}

	private async collectSkills(): Promise<RawSkill[]> {
		const skillsDir = join(claudeDir(), "skills");
		migrateLegacyLocalSetupSkill({
			targetDir: join(skillsDir, "clawdi"),
			id: "clawdi",
			version: 1,
			digest: managedSkillDirectoryDigest,
		});
		if (!existsSync(skillsDir)) return [];

		const skills: RawSkill[] = [];

		for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".")) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			const dirPath = join(skillsDir, entry.name);
			if (shouldIgnoreUserSkill(dirPath, entry.name)) continue;
			const skillMd = join(dirPath, "SKILL.md");
			if (!existsSync(skillMd)) continue;

			const content = readFileSync(skillMd, "utf-8");
			// Check if directory has more than just SKILL.md
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
		return join(claudeDir(), "skills", key, "SKILL.md");
	}

	private getSkillsRootDir(): string {
		return join(claudeDir(), "skills");
	}

	private getSharedSkillPath(skillKey: string, ownerHandle: string): string {
		return join(claudeDir(), "skills", `${skillKey}__${ownerHandle}`);
	}

	private async listSkillKeys(): Promise<string[]> {
		// Flat layout: top-level dirs under skills/. Mirrors the
		// filtering of `collectSkills` so the daemon's hot-path
		// rescan returns the same set the bulk push would consider
		// — otherwise nested or skip-listed dirs would diverge.
		const skillsDir = join(claudeDir(), "skills");
		migrateLegacyLocalSetupSkill({
			targetDir: join(skillsDir, "clawdi"),
			id: "clawdi",
			version: 1,
			digest: managedSkillDirectoryDigest,
		});
		if (!existsSync(skillsDir)) return [];
		const out: string[] = [];
		for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".")) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			if (shouldIgnoreUserSkill(join(skillsDir, entry.name), entry.name)) continue;
			const skillMd = join(skillsDir, entry.name, "SKILL.md");
			if (!existsSync(skillMd)) continue;
			out.push(entry.name);
		}
		return out;
	}

	private getSessionsWatchPaths(): string[] {
		// Claude Code dumps each conversation as a JSONL file under
		// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. New
		// projects appear as new subdirs; the watcher attaches
		// recursively from the projects root.
		return [projectsDir()];
	}

	private async removeLocalSkill(key: string): Promise<void> {
		const dir = join(claudeDir(), "skills", key);
		mutateUserSkillTarget(dir, key, () => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		});
	}

	private async writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void> {
		const skillsDir = join(claudeDir(), "skills");
		const targetDir = join(skillsDir, key);
		await replaceSkillArchiveTarGz(key, skillsDir, targetDir, tarGzBytes, undefined, (mutation) =>
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

/**
 * Dedupe resume chains: when `claude --resume` produces a new sessionId file
 * whose message-uuid set strictly contains an older file's, the older one is
 * a redundant predecessor (its content is fully embedded in the newer file
 * via Claude Code's file-history-snapshot replay). We drop the predecessor
 * from the upload set and keep the longest leaf.
 *
 * Multi-link chains (A ⊂ B ⊂ C) collapse in a single pass by always linking
 * each predecessor to the LARGEST proper superset in its project group.
 *
 * Sessions with fewer than 10 uuids are excluded from the predecessor side
 * of the comparison — too short to reliably tell "real subset" from
 * "happens to share a few system uuids".
 */
function dedupeResumeChains(
	sessions: RawSession[],
	uuids: Map<RawSession, Set<string>>,
	coverage: SessionScanResult["coverage"],
): SessionScanResult {
	// Group by projectPath — resume chains are always within a single cwd.
	const byProject = new Map<string, RawSession[]>();
	for (const s of sessions) {
		const key = s.projectPath ?? "<no-project>";
		const arr = byProject.get(key);
		if (arr) arr.push(s);
		else byProject.set(key, [s]);
	}

	const dedupedIds = new Set<string>();

	for (const group of byProject.values()) {
		if (group.length < 2) continue;
		// Sort by uuid count ascending so we scan smaller candidates first.
		const candidates = group
			.filter((s) => (uuids.get(s)?.size ?? 0) >= 10)
			.sort((a, b) => (uuids.get(a)?.size ?? 0) - (uuids.get(b)?.size ?? 0));

		for (let i = 0; i < candidates.length; i++) {
			const a = candidates[i];
			const aSet = uuids.get(a);
			if (!aSet) continue;
			// Find the LARGEST b that strictly contains a — handles A⊂B⊂C
			// by deduping both A and B into C in a single pass.
			let bestJ = -1;
			for (let j = i + 1; j < candidates.length; j++) {
				const b = candidates[j];
				const bSet = uuids.get(b);
				if (!bSet || bSet.size <= aSet.size) continue;
				let isSubset = true;
				for (const u of aSet) {
					if (!bSet.has(u)) {
						isSubset = false;
						break;
					}
				}
				if (isSubset) bestJ = j;
			}
			if (bestJ >= 0) dedupedIds.add(a.localSessionId);
		}
	}

	return {
		sessions: sessions.filter((s) => !dedupedIds.has(s.localSessionId)),
		dedupedCount: dedupedIds.size,
		coverage,
	};
}
