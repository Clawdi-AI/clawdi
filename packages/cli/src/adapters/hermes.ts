import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { extractTarGz } from "../lib/tar";
import type {
	AgentAdapter,
	CollectSessionsOptions,
	RawSession,
	RawSkill,
	SessionMessage,
} from "./base";
import { getHermesHome, SKIP_DIRS } from "./paths";

/**
 * Minimal SQLite shape that both `bun:sqlite` and Node's built-in
 * `node:sqlite` implement. Enough for our read-only Hermes access pattern.
 */
interface SqliteStatement {
	all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
	prepare(sql: string): SqliteStatement;
	close(): void;
}

/**
 * Open a Hermes SQLite db using the runtime's built-in binding:
 * - Under Bun: `bun:sqlite` (built-in, the dev/test default).
 * - Under Node 22.5+: `node:sqlite` (built-in; Node 22.x still emits an
 *   ExperimentalWarning at first import, harmless and one-shot).
 *
 * Neither cross-loads — Bun has no `node:sqlite` (oven-sh/bun#15561) and
 * Node has no `bun:sqlite`. Importing lazily means users who never touch
 * Hermes don't pay the load cost or hear the experimental warning.
 *
 * Both expose a `prepare(sql).all(args)` surface, so call sites stay
 * runtime-agnostic.
 */
async function openHermesDb(path: string): Promise<SqliteDatabase> {
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
		const { Database } = await import("bun:sqlite");
		return new Database(path, { readonly: true }) as unknown as SqliteDatabase;
	}
	const { DatabaseSync } = await import("node:sqlite");
	return new DatabaseSync(path, { readOnly: true }) as unknown as SqliteDatabase;
}

function hermesDir() {
	return getHermesHome();
}
function stateDbPath() {
	return join(hermesDir(), "state.db");
}
function skillsDir() {
	return join(hermesDir(), "skills");
}

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
		// Hermes stores state in a SQLite db. The dir alone may exist as a
		// leftover; the db is the only file every Hermes install creates.
		return existsSync(stateDbPath());
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

	async collectSessions(_opts: CollectSessionsOptions = {}): Promise<RawSession[]> {
		// Hermes' SQLite is a single file with no per-row stat info, so we
		// always scan the whole `sessions` table. Cost is negligible
		// (dozens to hundreds of rows). `projectFilter` has no analogue
		// in Hermes' data model and is silently ignored.
		if (!existsSync(stateDbPath())) return [];

		const db = await openHermesDb(stateDbPath());
		try {
			interface SessionRow {
				id: string;
				source: string | null;
				model: string | null;
				title: string | null;
				started_at: number;
				ended_at: number | null;
				message_count: number | null;
				input_tokens: number | null;
				output_tokens: number | null;
				cache_read_tokens: number | null;
			}
			interface MessageRow {
				role: string;
				content: string;
				timestamp: number;
			}

			const rows = db
				.prepare(`
					SELECT id, source, model, title, started_at, ended_at,
					       message_count, input_tokens, output_tokens, cache_read_tokens
					FROM sessions
					ORDER BY started_at DESC
				`)
				.all() as SessionRow[];

			const msgStmt = db.prepare(`
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

				const msgRows = msgStmt.all(row.id) as MessageRow[];
				const messages: SessionMessage[] = msgRows.map((m) => ({
					role: m.role as "user" | "assistant",
					content: m.content,
					model: m.role === "assistant" ? (model ?? undefined) : undefined,
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
					rawFilePath: `${stateDbPath()}#${row.id}`,
				});
			}

			return sessions;
		} finally {
			db.close();
		}
	}

	async collectSkills(): Promise<RawSkill[]> {
		if (!existsSync(skillsDir())) return [];

		const skills: RawSkill[] = [];
		this._scanSkillsDir(skillsDir(), skills);
		return skills;
	}

	/**
	 * Recursively scan for directories containing SKILL.md.
	 * Hermes skills can be nested: skills/category/skill-name/SKILL.md
	 */
	private _scanSkillsDir(dir: string, results: RawSkill[]): void {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			// Bundled by `clawdi setup`, not user-authored. See claude-code.ts
			// for the full reasoning. Hermes only filters at the top level
			// — nested skills with the literal name "clawdi" deeper in the
			// tree are an unlikely edge case not worth handling.
			if (dir === skillsDir() && entry.name === "clawdi") continue;
			const fullPath = join(dir, entry.name);
			const skillMd = join(fullPath, "SKILL.md");

			if (existsSync(skillMd)) {
				const content = readFileSync(skillMd, "utf-8");
				const skillKey = relative(skillsDir(), fullPath);
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
		return ["hermes", ...args];
	}
}
