import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { extractTarGz } from "../lib/tar";
import type { AgentAdapter, RawSession, RawSkill, SessionMessage } from "./base";
import { getOpenClawHome, SKIP_DIRS } from "./paths";

function openclawDir() {
	return getOpenClawHome();
}
function agentId() {
	return process.env.OPENCLAW_AGENT_ID || "main";
}
function agentDir() {
	return join(openclawDir(), "agents", agentId());
}
function sessionsDir() {
	return join(agentDir(), "sessions");
}
function sessionsIndexPath() {
	return join(sessionsDir(), "sessions.json");
}
function skillsDir() {
	return join(agentDir(), "skills");
}

interface SessionEntry {
	sessionId: string;
	updatedAt?: number;
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

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(b): b is { type: string; text: string } =>
					typeof b === "object" &&
					b !== null &&
					"type" in b &&
					b.type === "text" &&
					typeof (b as { text?: unknown }).text === "string",
			)
			.map((b) => b.text)
			.join("\n");
	}
	return "";
}

export class OpenClawAdapter implements AgentAdapter {
	readonly agentType = "openclaw" as const;

	async detect(): Promise<boolean> {
		return existsSync(openclawDir());
	}

	async getVersion(): Promise<string | null> {
		const { execSync } = await import("node:child_process");
		try {
			return (
				execSync("openclaw --version", { encoding: "utf-8", stdio: "pipe" })
					.trim()
					.split("\n")[0] || null
			);
		} catch {
			try {
				return (
					execSync("openclaw --help", { encoding: "utf-8", stdio: "pipe" }).trim().split("\n")[0] ||
					null
				);
			} catch {
				return null;
			}
		}
	}

	async collectSessions(since?: Date, projectFilter?: string): Promise<RawSession[]> {
		if (!existsSync(sessionsIndexPath())) return [];

		let index: Record<string, SessionEntry>;
		try {
			index = JSON.parse(readFileSync(sessionsIndexPath(), "utf-8"));
		} catch {
			return [];
		}

		const sinceMs = since?.getTime() ?? 0;
		let absFilter: string | null = null;
		if (projectFilter) {
			const { resolve } = await import("node:path");
			absFilter = resolve(projectFilter);
		}

		const sessions: RawSession[] = [];
		for (const [sessionId, entry] of Object.entries(index)) {
			const updatedAt = entry.updatedAt ?? entry.acp?.lastActivityAt;
			if (!updatedAt) continue;
			if (updatedAt < sinceMs) continue;

			const projectPath = entry.acp?.cwd ?? null;
			if (absFilter) {
				if (!projectPath) continue;
				if (projectPath !== absFilter && !projectPath.startsWith(`${absFilter}/`)) continue;
			}

			const transcriptPath = entry.sessionFile
				? join(sessionsDir(), entry.sessionFile)
				: join(sessionsDir(), `${sessionId}.jsonl`);

			const messages: SessionMessage[] = [];
			let startedAt: Date | null = null;
			let endedAt: Date | null = null;
			const modelsUsed = new Set<string>();
			if (entry.model) modelsUsed.add(entry.model);
			let currentModel = entry.model ?? null;

			if (existsSync(transcriptPath)) {
				try {
					const lines = readFileSync(transcriptPath, "utf-8").split("\n").filter(Boolean);
					for (const line of lines) {
						let parsed: TranscriptLine;
						try {
							parsed = JSON.parse(line);
						} catch {
							continue;
						}

						const ts = parsed.timestamp
							? new Date(typeof parsed.timestamp === "number" ? parsed.timestamp : parsed.timestamp)
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
							continue;
						}

						if (parsed.type !== "message") continue;
						const role = parsed.message?.role;
						if (role !== "user" && role !== "assistant") continue;
						const text = extractText(parsed.message?.content);
						if (!text) continue;
						messages.push({
							role,
							content: text,
							model: role === "assistant" ? (currentModel ?? undefined) : undefined,
							timestamp: ts?.toISOString(),
						});
					}
				} catch {
					// Unreadable transcript — fall through with whatever we have.
				}
			}

			if (messages.length === 0) continue;

			// Defensive fallback: a transcript with messages but no timestamps at all
			// shouldn't happen in practice, but keep the session recoverable via the
			// index's updatedAt rather than throwing.
			startedAt ??= new Date(updatedAt);
			endedAt ??= new Date(updatedAt);

			const durationSeconds = Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000);

			const summary =
				entry.displayName ??
				entry.subject ??
				entry.label ??
				messages.find((m) => m.role === "user")?.content.slice(0, 200) ??
				null;

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
				rawFilePath: existsSync(transcriptPath) ? transcriptPath : sessionsIndexPath(),
			});
		}

		return sessions;
	}

	async collectSkills(): Promise<RawSkill[]> {
		if (!existsSync(skillsDir())) return [];

		const skills: RawSkill[] = [];
		for (const entry of readdirSync(skillsDir(), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
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
		return ["openclaw", ...args];
	}
}
