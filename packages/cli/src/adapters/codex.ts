import {
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { extractTarGz } from "../lib/tar";
import type { AgentAdapter, RawSession, RawSkill, SessionMessage } from "./base";
import { getCodexHome, SKIP_DIRS } from "./paths";

function codexDir() {
	return getCodexHome();
}
function sessionsDir() {
	return join(codexDir(), "sessions");
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

function collectJsonlFiles(root: string, since?: Date): string[] {
	const results: string[] = [];
	if (!existsSync(root)) return results;

	const sinceTime = since?.getTime() ?? 0;

	// Directory layout: YYYY/MM/DD/rollout-*.jsonl. Walk lexicographically so the
	// since cursor can prune whole day directories cheaply.
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
				if (since) {
					try {
						const stats = statSync(full);
						if (stats.mtimeMs < sinceTime) continue;
					} catch {
						// fall through — include the file
					}
				}
				results.push(full);
			}
		}
	};

	walk(root);
	return results;
}

export class CodexAdapter implements AgentAdapter {
	readonly agentType = "codex" as const;

	async detect(): Promise<boolean> {
		return existsSync(codexDir());
	}

	async getVersion(): Promise<string | null> {
		try {
			const { execSync } = await import("node:child_process");
			const out = execSync("codex --version", { encoding: "utf-8", stdio: "pipe" }).trim();
			return out.split("\n")[0] || null;
		} catch {
			return null;
		}
	}

	async collectSessions(since?: Date, projectFilter?: string): Promise<RawSession[]> {
		if (!existsSync(sessionsDir())) return [];

		let absFilter: string | null = null;
		if (projectFilter) {
			const { resolve } = await import("node:path");
			absFilter = resolve(projectFilter);
		}

		const files = collectJsonlFiles(sessionsDir(), since);
		const sessions: RawSession[] = [];

		for (const filePath of files) {
			let content: string;
			try {
				content = readFileSync(filePath, "utf-8");
			} catch {
				continue;
			}
			const lines = content.split("\n").filter(Boolean);
			if (lines.length === 0) continue;

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
					const m = parsed.payload?.model;
					if (m) {
						lastModel = m;
						modelsUsed.add(m);
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

			if (!sessionId || messages.length === 0 || !startedAt) continue;

			if (since && startedAt < since) continue;

			if (absFilter) {
				if (!projectPath) continue;
				if (projectPath !== absFilter && !projectPath.startsWith(`${absFilter}/`)) continue;
			}

			if (!endedAt) endedAt = startedAt;
			const durationSeconds = Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000);

			const firstRealUser = messages.find(
				(m) => m.role === "user" && !m.content.startsWith("<environment_context>"),
			);
			const summary = firstRealUser?.content.slice(0, 200) ?? null;

			sessions.push({
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
				durationSeconds,
				summary,
				messages,
				rawFilePath: filePath,
			});
		}

		return sessions;
	}

	async collectSkills(): Promise<RawSkill[]> {
		if (!existsSync(skillsDir())) return [];

		const skills: RawSkill[] = [];
		for (const entry of readdirSync(skillsDir(), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			// Skip dot-dirs (e.g. `.system/` holds Codex's built-in skills, not user-authored ones).
			if (entry.name.startsWith(".")) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			const dirPath = join(skillsDir(), entry.name);
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

	async writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void> {
		const targetDir = join(skillsDir(), key);
		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		mkdirSync(targetDir, { recursive: true });

		await extractTarGz(skillsDir(), tarGzBytes);
	}

	buildRunCommand(args: string[], _env: Record<string, string>): string[] {
		return ["codex", ...args];
	}
}
