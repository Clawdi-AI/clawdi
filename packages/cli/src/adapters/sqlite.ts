type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteStatement {
	all(...params: SqliteValue[]): unknown[];
	get(...params: SqliteValue[]): unknown;
}

export interface ReadonlySqliteDatabase {
	prepare(sql: string): SqliteStatement;
	close(): void;
}

/** Use the runtime's built-in SQLite binding without shipping native addons. */
export async function openReadonlySqlite(path: string): Promise<ReadonlySqliteDatabase> {
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
		const { Database } = await import("bun:sqlite");
		const db = new Database(path, { readonly: true });
		return {
			prepare: (sql) => {
				const statement = db.prepare(sql);
				return {
					all: (...params) => statement.all(...params),
					get: (...params) => statement.get(...params),
				};
			},
			close: () => db.close(),
		};
	}
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(path, { readOnly: true });
	return {
		prepare: (sql) => {
			const statement = db.prepare(sql);
			return {
				all: (...params) => statement.all(...params),
				get: (...params) => statement.get(...params),
			};
		},
		close: () => db.close(),
	};
}
