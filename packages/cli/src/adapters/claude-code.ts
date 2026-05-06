import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { extractTarGz } from "../lib/tar";
import type {
	AgentAdapter,
	CollectSessionsOptions,
	CollectSessionsResult,
	RawSession,
	RawSkill,
	SessionMessage,
} from "./base";
import { getClaudeHome, SKIP_DIRS } from "./paths";

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

/**
 * Internal-only intermediate shape produced by `parseSessionJsonl`. The
 * `uuidSet` lives in a sibling `Map<RawSession, Set<string>>` for the dedupe
 * pass and never leaves this module — it does NOT become part of `RawSession`.
 */
type ParsedSession = Omit<RawSession, "localSessionId" | "rawFilePath"> & {
	uuidSet: Set<string>;
};

export class ClaudeCodeAdapter implements AgentAdapter {
	readonly agentType = "claude_code" as const;

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
		try {
			const { execSync } = await import("node:child_process");
			return execSync("claude --version", { encoding: "utf-8", stdio: "pipe" }).trim();
		} catch {
			return null;
		}
	}

	/**
	 * Convert absolute path to Claude Code project dir name.
	 * /Users/paco/workspace/clawdi → -Users-paco-workspace-clawdi
	 */
	private pathToProjectDir(absPath: string): string {
		return absPath.replace(/\//g, "-");
	}

	async collectSessions(opts: CollectSessionsOptions = {}): Promise<CollectSessionsResult> {
		if (!existsSync(projectsDir())) return { sessions: [], dedupedCount: 0 };

		const { projectFilter } = opts;

		const sessions: RawSession[] = [];
		const uuidsBySession = new Map<RawSession, Set<string>>();
		let projectDirs = readdirSync(projectsDir(), { withFileTypes: true }).filter((d) =>
			d.isDirectory(),
		);

		let absFilter: string | null = null;
		if (projectFilter) {
			const { resolve } = await import("node:path");
			absFilter = resolve(projectFilter);
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

		for (const projectDir of projectDirs) {
			const projectPath = join(projectsDir(), projectDir.name);
			const jsonlFiles = readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));

			for (const file of jsonlFiles) {
				const filePath = join(projectPath, file);
				const sessionId = basename(file, ".jsonl");

				try {
					const parsed = this.parseSessionJsonl(filePath, projectDir.name);
					if (!parsed) continue;

					if (absFilter) {
						const cwd = parsed.projectPath;
						if (!cwd) continue;
						if (cwd !== absFilter && !cwd.startsWith(`${absFilter}/`)) continue;
					}

					const { uuidSet, ...sessionFields } = parsed;
					const session: RawSession = {
						...sessionFields,
						localSessionId: sessionId,
						rawFilePath: filePath,
					};
					sessions.push(session);
					uuidsBySession.set(session, uuidSet);
				} catch {
					// Skip unparseable sessions
				}
			}
		}

		// Dedupe resume chains. The Map is module-scoped only — it goes out of
		// scope when this function returns and is GC'd, so uuid data never
		// leaks into RawSession or anywhere downstream.
		return dedupeResumeChains(sessions, uuidsBySession);
	}

	private parseSessionJsonl(filePath: string, _projectDirName: string): ParsedSession | null {
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n").filter(Boolean);
		if (lines.length < 3) return null;

		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let startedAt: Date | null = null;
		let endedAt: Date | null = null;
		let model: string | null = null;
		const modelsUsed = new Set<string>();
		let projectPath: string | null = null;
		let firstUserMessage: string | null = null;
		const messages: SessionMessage[] = [];
		const uuidSet = new Set<string>();

		for (const line of lines) {
			try {
				const entry: SessionJsonlEntry = JSON.parse(line);
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

				if (role === "user" || role === "assistant") {
					// Extract text content for messages
					const c = msg?.content;
					let text = "";
					if (typeof c === "string") {
						text = c;
					} else if (Array.isArray(c)) {
						text = c
							.filter((b): b is { type: "text"; text: string } => b.type === "text" && !!b.text)
							.map((b) => b.text)
							.join("\n");
					}
					if (text) {
						messages.push({
							role: role as "user" | "assistant",
							content: text,
							model: role === "assistant" ? msg?.model : undefined,
							timestamp: entry.timestamp,
						});
					}
				}

				if (role === "user" && !firstUserMessage) {
					const c = msg?.content;
					if (typeof c === "string") {
						firstUserMessage = c.slice(0, 200);
					} else if (Array.isArray(c)) {
						const textBlock = c.find((b) => b.type === "text" && b.text);
						if (textBlock?.text) {
							firstUserMessage = textBlock.text.slice(0, 200);
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

		if (!startedAt || messages.length === 0) return null;

		const durationSeconds = endedAt
			? Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000)
			: null;

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
			durationSeconds,
			uuidSet,
		};
	}

	async collectSkills(): Promise<RawSkill[]> {
		const skillsDir = join(claudeDir(), "skills");
		if (!existsSync(skillsDir)) return [];

		const skills: RawSkill[] = [];

		for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			// Bundled by `clawdi setup` — not user-authored content. Without
			// this filter every user's `clawdi push --modules skills` would
			// upload the bundled skill to their cloud account, and pulling
			// on another machine would re-download it on top of what
			// `clawdi setup` already installs there.
			if (entry.name === "clawdi") continue;
			const dirPath = join(skillsDir, entry.name);
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

	getSkillPath(key: string): string {
		return join(claudeDir(), "skills", key, "SKILL.md");
	}

	getSkillsRootDir(): string {
		return join(claudeDir(), "skills");
	}

	async listSkillKeys(): Promise<string[]> {
		// Flat layout: top-level dirs under skills/. Mirrors the
		// filtering of `collectSkills` so the daemon's hot-path
		// rescan returns the same set the bulk push would consider
		// — otherwise nested or skip-listed dirs would diverge.
		const skillsDir = join(claudeDir(), "skills");
		if (!existsSync(skillsDir)) return [];
		const out: string[] = [];
		for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			if (entry.name === "clawdi") continue;
			const skillMd = join(skillsDir, entry.name, "SKILL.md");
			if (!existsSync(skillMd)) continue;
			out.push(entry.name);
		}
		return out;
	}

	getSessionsWatchPaths(): string[] {
		// Claude Code dumps each conversation as a JSONL file under
		// `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. New
		// projects appear as new subdirs; the watcher attaches
		// recursively from the projects root.
		return [projectsDir()];
	}

	async removeLocalSkill(key: string): Promise<void> {
		const dir = join(claudeDir(), "skills", key);
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}

	async writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void> {
		const skillsDir = join(claudeDir(), "skills");
		const targetDir = join(skillsDir, key);

		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		mkdirSync(targetDir, { recursive: true });

		await extractTarGz(skillsDir, tarGzBytes);
	}

	buildRunCommand(args: string[], _env: Record<string, string>): string[] {
		return ["claude", ...args];
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
): CollectSessionsResult {
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
	};
}
