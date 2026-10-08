import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteStatement {
	all(...params: SqliteValue[]): unknown[];
	get(...params: SqliteValue[]): unknown;
	iterate(...params: SqliteValue[]): IterableIterator<unknown>;
}

export interface ReadonlySqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

export interface SessionIndexDatabase extends ReadonlySqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement & { run(...params: SqliteValue[]): void };
}

/** Disk-backed indexes keep resume deduplication and branch traversal bounded. */
export async function openSessionIndex(): Promise<SessionIndexDatabase> {
	const directory = mkdtempSync(join(tmpdir(), "clawdi-session-index-"));
	let close: (() => void) | undefined;
	try {
		const path = join(directory, "index.db");
		const db =
			typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
				? new (await import("bun:sqlite")).Database(path, { create: true })
				: new (await import("node:sqlite")).DatabaseSync(path);
		const statements: ReturnType<typeof db.prepare>[] = [];
		close = () => {
			try {
				for (const statement of statements.splice(0)) {
					// Node 24 StatementSync has no public finalizer; DatabaseSync.close() finalizes it.
					if ("finalize" in statement) statement.finalize();
				}
			} finally {
				db.close();
			}
		};
		db.exec("PRAGMA cache_size=-4096; PRAGMA temp_store=FILE; PRAGMA journal_mode=OFF;");
		return {
			exec: (sql) => db.exec(sql),
			prepare: (sql) => {
				const statement = db.prepare(sql);
				statements.push(statement);
				return {
					all: (...params) => statement.all(...params),
					get: (...params) => statement.get(...params),
					iterate: (...params) => statement.iterate(...params),
					run: (...params) => {
						statement.run(...params);
					},
				};
			},
			close: () => {
				try {
					close?.();
				} finally {
					close = undefined;
					rmSync(directory, { recursive: true, force: true });
				}
			},
		};
	} catch (error) {
		try {
			close?.();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
		throw error;
	}
}

export async function withSessionIndex<T>(
	use: (database: SessionIndexDatabase) => Promise<T>,
): Promise<T> {
	const database = await openSessionIndex();
	try {
		return await use(database);
	} finally {
		database.close();
	}
}

/** Use the runtime's built-in SQLite binding without shipping native addons. */
export async function openReadonlySqlite(path: string): Promise<ReadonlySqliteDatabase> {
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
		const { Database } = await import("bun:sqlite");
		const db = new Database(path, { readonly: true });
		const statements: ReturnType<typeof db.prepare>[] = [];
		return {
			exec: (sql) => db.exec(sql),
			prepare: (sql) => {
				const statement = db.prepare(sql);
				statements.push(statement);
				return {
					all: (...params) => statement.all(...params),
					get: (...params) => statement.get(...params),
					iterate: (...params) => statement.iterate(...params),
				};
			},
			close: () => {
				try {
					for (const statement of statements.splice(0)) statement.finalize();
				} finally {
					db.close();
				}
			},
		};
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(path, { readOnly: true });
	return {
		exec: (sql) => db.exec(sql),
		prepare: (sql) => {
			const statement = db.prepare(sql);
			return {
				all: (...params) => statement.all(...params),
				get: (...params) => statement.get(...params),
				iterate: (...params) => statement.iterate(...params),
			};
		},
		close: () => db.close(),
	};
}
