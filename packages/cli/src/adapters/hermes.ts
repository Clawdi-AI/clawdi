import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { Database } from "bun:sqlite";
import * as tar from "tar";
import { getExtraSkillPaths } from "../lib/config";
import { dedupeByKey, scanFlatSkillsDir } from "../lib/skill-scan";
import type { AgentAdapter, RawSession, RawSkill, SessionMessage } from "./base";

const HERMES_DIR = process.env.HERMES_HOME || join(homedir(), ".hermes");
const STATE_DB = join(HERMES_DIR, "state.db");
const SKILLS_DIR = join(HERMES_DIR, "skills");

/**
 * Extract a plain model name string from Hermes model field.
 * The field can be a plain string ("claude-opus-4.6") or a JSON object
 * ({"default": "gpt-5.3-codex", "provider": "openai-codex", ...}).
 */
function parseModelField(raw: string | null): string | null {
	if (!raw) return null;
	if (raw.startsWith("{")) {
		try {
			const obj = JSON.parse(raw);
			return obj.default || obj.model || null;
		} catch {
			return raw;
		}
	}
	return raw;
}

export class HermesAdapter implements AgentAdapter {
	readonly agentType = "hermes" as const;

	async detect(): Promise<boolean> {
		return existsSync(HERMES_DIR);
	}

	async getVersion(): Promise<string | null> {
		try {
			const { execSync } = await import("node:child_process");
			const output = execSync("hermes --version", { encoding: "utf-8", stdio: "pipe" }).trim();
			// Hermes outputs multi-line version info, take first line only
			return output.split("\n")[0] || null;
		} catch {
			return null;
		}
	}

	async collectSessions(since?: Date, _projectFilter?: string): Promise<RawSession[]> {
		if (!existsSync(STATE_DB)) return [];

		const db = new Database(STATE_DB, { readonly: true });
		try {
			const sinceEpoch = since ? since.getTime() / 1000 : 0;

			const rows = db.query(`
					SELECT id, source, model, title, started_at, ended_at,
					       message_count, input_tokens, output_tokens, cache_read_tokens
					FROM sessions
					WHERE started_at >= ?
					ORDER BY started_at DESC
				`).all(sinceEpoch) as any[];

			const msgStmt = db.query(`
				SELECT role, content, timestamp
				FROM messages
				WHERE session_id = ? AND role IN ('user', 'assistant') AND content IS NOT NULL
				ORDER BY timestamp ASC
			`);

			const sessions: RawSession[] = [];

			for (const row of rows) {
				const model = parseModelField(row.model);
				const startedAt = new Date(row.started_at * 1000);
				const endedAt = row.ended_at ? new Date(row.ended_at * 1000) : null;
				const durationSeconds = endedAt
					? Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000)
					: null;

				const msgRows = msgStmt.all(row.id) as any[];
				const messages: SessionMessage[] = msgRows.map((m) => ({
					role: m.role as "user" | "assistant",
					content: m.content,
					model: m.role === "assistant" ? model ?? undefined : undefined,
					timestamp: new Date(m.timestamp * 1000).toISOString(),
				}));

				// Summary: use title or first user message
				let summary = row.title;
				if (!summary || summary === "New Chat" || summary.startsWith("New Chat #")) {
					const firstUser = messages.find((m) => m.role === "user");
					summary = firstUser?.content.slice(0, 200) ?? null;
				}

				if (messages.length === 0) continue;

				sessions.push({
					localSessionId: row.id,
					// Hermes sessions have no filesystem cwd — `row.source` is a channel/origin
					// tag (e.g. "telegram"), not a path. Leave null so the dashboard doesn't
					// render a fake "hermes/..." project.
					projectPath: null,
					startedAt,
					endedAt,
					messageCount: row.message_count ?? messages.length,
					inputTokens: row.input_tokens ?? 0,
					outputTokens: row.output_tokens ?? 0,
					cacheReadTokens: row.cache_read_tokens ?? 0,
					model,
					modelsUsed: model ? [model] : [],
					durationSeconds,
					summary,
					messages,
					// The DB is shared across sessions — anchor to the row id so the pointer
					// identifies the specific session rather than the whole store.
					rawFilePath: `${STATE_DB}#${row.id}`,
				});
			}

			return sessions;
		} finally {
			db.close();
		}
	}

	async collectSkills(): Promise<RawSkill[]> {
		const skills: RawSkill[] = [];
		if (existsSync(SKILLS_DIR)) {
			this._scanSkillsDir(SKILLS_DIR, skills);
		}
		// Extras are scanned one level deep — nested category layouts (Hermes's
		// native form) are only assumed for the default SKILLS_DIR. Users who
		// need nesting in extras can add each category path explicitly.
		for (const extra of getExtraSkillPaths(this.agentType)) {
			skills.push(...scanFlatSkillsDir(extra));
		}
		return dedupeByKey(skills);
	}

	/**
	 * Recursively scan for directories containing SKILL.md.
	 * Hermes skills can be nested: skills/category/skill-name/SKILL.md
	 */
	private _scanSkillsDir(dir: string, results: RawSkill[]): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const fullPath = join(dir, entry.name);
			const skillMd = join(fullPath, "SKILL.md");

			if (existsSync(skillMd)) {
				const content = readFileSync(skillMd, "utf-8");
				const skillKey = relative(SKILLS_DIR, fullPath);
				const fileCount = readdirSync(fullPath, { recursive: true }).length;

				results.push({
					skillKey,
					name: entry.name,
					content,
					filePath: skillMd,
					directoryPath: fullPath,
					isDirectory: fileCount > 1,
				});
			} else {
				// Might be a category directory, recurse
				this._scanSkillsDir(fullPath, results);
			}
		}
	}

	getSkillPath(key: string): string {
		return join(SKILLS_DIR, key, "SKILL.md");
	}

	async writeSkillArchive(key: string, tarGzBytes: Buffer): Promise<void> {
		const targetDir = join(SKILLS_DIR, key);

		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		mkdirSync(targetDir, { recursive: true });

		await tar.extract({
			cwd: SKILLS_DIR,
			gzip: true,
			filter: (path) => !path.includes("..") && !path.startsWith("/"),
		}).end(tarGzBytes);
	}

	buildRunCommand(args: string[], _env: Record<string, string>): string[] {
		return ["hermes", ...args];
	}
}
