import { type Dirent, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { safeTruncate } from "../lib/sanitize";
import { durationSecondsBetween } from "../lib/session-duration";
import { replaceSkillArchiveTarGz } from "../lib/tar";
import { managedSkillDirectoryDigest } from "../runtime/hosted-bundled-skill";
import {
	migrateLegacyLocalSetupSkill,
	mutateUserSkillTarget,
	shouldIgnoreUserSkill,
} from "../runtime/managed-skill-reservation";
import type {
	AgentAdapter,
	CollectSessionsOptions,
	CollectSessionsResult,
	RawSession,
	RawSkill,
	SessionMessage,
} from "./base";
import { getCodexHome, SKIP_DIRS } from "./paths";
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

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is { type: string; text: string } =>
				typeof b === "object" && b !== null && "type" in b && typeof b.text === "string",
		)
		.filter((b) => b.type === "input_text" || b.type === "output_text" || b.type === "text")
		.map((b) => b.text)
		.join("\n");
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

function isWithinSessionRoot(path: string): boolean {
	return sessionRoots().some((root) => {
		const fromRoot = relative(root, path);
		return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
	});
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
	const lines = content.split("\n").filter(Boolean);
	if (lines.length === 0) return null;

	let sessionId: string | null = null;
	let projectPath: string | null = null;
	let startedAt: Date | null = null;
	let endedAt: Date | null = null;
	let lastModel: string | null = null;
	const modelsUsed = new Set<string>();
	const messages: SessionMessage[] = [];
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;

	for (const line of lines) {
		let parsed: SessionLine;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}

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
			continue;
		}

		if (parsed.type === "response_item" && parsed.payload?.type === "message") {
			const role = parsed.payload.role;
			if (role !== "user" && role !== "assistant") continue;
			const text = extractMessageText(parsed.payload.content);
			if (!text) continue;
			messages.push({
				role,
				content: text,
				model: role === "assistant" ? (lastModel ?? undefined) : undefined,
				timestamp: ts?.toISOString(),
			});
		}
	}

	if (!sessionId || messages.length === 0 || !startedAt) return null;
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
		rawFilePath: filePath,
	};
}

export class CodexAdapter implements AgentAdapter {
	readonly agentType = "codex" as const;
	private sessionPaths = new Map<string, string>();
	private hasCompleteSessionPathInventory = false;

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

	async collectSessions(opts: CollectSessionsOptions = {}): Promise<CollectSessionsResult> {
		const sessionsById = new Map<string, RawSession>();
		const pathsById = new Map<string, string>();
		const absFilter = resolveProjectFilter(opts.projectFilter);
		for (const root of sessionRoots()) {
			for (const filePath of collectJsonlFiles(root)) {
				const session = parseSessionFile(filePath, absFilter);
				if (session && !sessionsById.has(session.localSessionId)) {
					sessionsById.set(session.localSessionId, session);
					pathsById.set(session.localSessionId, filePath);
				}
			}
		}
		if (opts.projectFilter) {
			for (const [sessionId, path] of pathsById) this.sessionPaths.set(sessionId, path);
		} else {
			this.sessionPaths = pathsById;
			this.hasCompleteSessionPathInventory = true;
		}

		// Codex stores long-conversation history via in-file `compacted`
		// entries rather than spawning new sessionId files, so it cannot
		// produce the resume-chain duplication that ClaudeCodeAdapter dedupes.
		return { sessions: [...sessionsById.values()], dedupedCount: 0 };
	}

	async collectSession(localSessionId: string): Promise<RawSession | null> {
		const knownPath = this.sessionPaths.get(localSessionId);
		if (knownPath) {
			const current = parseSessionFile(knownPath, null);
			if (current?.localSessionId === localSessionId) return current;
			this.sessionPaths.delete(localSessionId);
		}
		if (this.hasCompleteSessionPathInventory) return null;
		return (
			(await this.collectSessions()).sessions.find(
				(session) => session.localSessionId === localSessionId,
			) ?? null
		);
	}

	async collectSessionsForPaths(
		paths: readonly string[],
		opts: CollectSessionsOptions = {},
	): Promise<CollectSessionsResult | null> {
		const files = new Set<string>();
		for (const path of paths.map((candidate) => resolve(candidate))) {
			if (!isWithinSessionRoot(path) || !path.endsWith(".jsonl")) return null;
			for (const [sessionId, knownPath] of this.sessionPaths) {
				if (knownPath === path && !existsSync(path)) this.sessionPaths.delete(sessionId);
			}
			if (existsSync(path)) files.add(path);
		}
		const sessionsById = new Map<string, RawSession>();
		const absFilter = resolveProjectFilter(opts.projectFilter);
		for (const filePath of files) {
			const session = parseSessionFile(filePath, absFilter);
			if (session) {
				sessionsById.set(session.localSessionId, session);
				this.sessionPaths.set(session.localSessionId, filePath);
			}
		}
		return { sessions: [...sessionsById.values()], dedupedCount: 0 };
	}

	async collectSkills(): Promise<RawSkill[]> {
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

	getSkillPath(key: string): string {
		return join(skillsDir(), key, "SKILL.md");
	}

	async listSkillKeys(): Promise<string[]> {
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

	getSkillsRootDir(): string {
		return skillsDir();
	}

	getSharedSkillPath(skillKey: string, ownerHandle: string): string {
		return join(skillsDir(), `${skillKey}__${ownerHandle}`);
	}

	getSessionsWatchPaths(): string[] {
		const existingRoots = sessionRoots().filter((root) => existsSync(root));
		return existingRoots.length > 0 ? existingRoots : [sessionsDir()];
	}

	async removeLocalSkill(key: string): Promise<void> {
		const dir = join(skillsDir(), key);
		mutateUserSkillTarget(dir, key, () => {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		});
	}

	async writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void> {
		const root = skillsDir();
		const targetDir = join(root, key);
		await replaceSkillArchiveTarGz(key, root, targetDir, tarGzBytes, undefined, (mutation) =>
			mutateUserSkillTarget(targetDir, key, mutation),
		);
	}

	async writeSharedSkillArchive(
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

	buildRunCommand(args: string[], _env: Record<string, string>): string[] {
		return ["codex", ...args];
	}
}
