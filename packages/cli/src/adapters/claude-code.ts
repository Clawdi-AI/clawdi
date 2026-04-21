import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import * as tar from "tar";
import { getExtraSkillPaths } from "../lib/config";
import { dedupeByKey, scanFlatSkillsDir } from "../lib/skill-scan";
import type { AgentAdapter, RawSession, RawSkill, SessionMessage } from "./base";

const CLAUDE_DIR = join(homedir(), ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

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
}

export class ClaudeCodeAdapter implements AgentAdapter {
	readonly agentType = "claude_code" as const;

	async detect(): Promise<boolean> {
		return existsSync(CLAUDE_DIR);
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

	async collectSessions(since?: Date, projectFilter?: string): Promise<RawSession[]> {
		if (!existsSync(PROJECTS_DIR)) return [];

		const sessions: RawSession[] = [];
		let projectDirs = readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) =>
			d.isDirectory(),
		);

		if (projectFilter) {
			const { resolve } = await import("node:path");
			const absPath = resolve(projectFilter);
			const targetDir = this.pathToProjectDir(absPath);
			projectDirs = projectDirs.filter((d) => d.name === targetDir);
		}

		for (const projectDir of projectDirs) {
			const projectPath = join(PROJECTS_DIR, projectDir.name);
			const jsonlFiles = readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));

			for (const file of jsonlFiles) {
				const filePath = join(projectPath, file);
				const sessionId = basename(file, ".jsonl");

				try {
					const parsed = this.parseSessionJsonl(filePath, projectDir.name);
					if (!parsed) continue;

					if (since && parsed.startedAt < since) continue;

					sessions.push({ ...parsed, localSessionId: sessionId, rawFilePath: filePath });
				} catch {
					// Skip unparseable sessions
				}
			}
		}

		return sessions;
	}

	private parseSessionJsonl(
		filePath: string,
		projectDirName: string,
	): Omit<RawSession, "localSessionId" | "rawFilePath"> | null {
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

		for (const line of lines) {
			try {
				const entry: SessionJsonlEntry = JSON.parse(line);
				const msg = entry.message;
				const role = msg?.role;

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
							.filter((b) => b.type === "text" && b.text)
							.map((b) => b.text!)
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
		};
	}

	async collectSkills(): Promise<RawSkill[]> {
		const skills = scanFlatSkillsDir(join(CLAUDE_DIR, "skills"));
		for (const extra of getExtraSkillPaths(this.agentType)) {
			skills.push(...scanFlatSkillsDir(extra));
		}
		return dedupeByKey(skills);
	}

	getSkillPath(key: string): string {
		return join(CLAUDE_DIR, "skills", key, "SKILL.md");
	}

	async writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void> {
		const skillsDir = join(CLAUDE_DIR, "skills");
		const targetDir = join(skillsDir, key);

		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		mkdirSync(targetDir, { recursive: true });

		await tar.extract({
			cwd: skillsDir,
			gzip: true,
			filter: (path) => {
				// Reject path traversal
				return !path.includes("..") && !path.startsWith("/");
			},
		}).end(tarGzBytes);
	}

	buildRunCommand(args: string[], _env: Record<string, string>): string[] {
		return ["claude", ...args];
	}
}
