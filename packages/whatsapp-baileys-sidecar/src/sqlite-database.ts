import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type Statement<TRow, TParams extends SQLInputValue[]> = {
	all: (...params: TParams) => TRow[];
	get: (...params: TParams) => TRow | null;
	run: (...params: TParams) => void;
};

export class Database {
	private readonly database: DatabaseSync;

	constructor(path: string) {
		this.database = new DatabaseSync(path, {
			allowExtension: false,
			enableDoubleQuotedStringLiterals: false,
			timeout: 0,
		});
	}

	query<TRow = Record<string, unknown>, TParams extends SQLInputValue[] = SQLInputValue[]>(
		sql: string,
	): Statement<TRow, TParams> {
		const statement = this.database.prepare(sql);
		return {
			all: (...params) => statement.all(...params) as TRow[],
			get: (...params) => (statement.get(...params) as TRow | undefined) ?? null,
			run: (...params) => {
				statement.run(...params);
			},
		};
	}

	run(sql: string, params: readonly SQLInputValue[] = []): void {
		this.database.prepare(sql).run(...params);
	}

	exec(sql: string): void {
		this.database.exec(sql);
	}

	transaction<T>(operation: () => T): () => T {
		return () => {
			this.database.exec("BEGIN");
			try {
				const result = operation();
				this.database.exec("COMMIT");
				return result;
			} catch (error: unknown) {
				this.database.exec("ROLLBACK");
				throw error;
			}
		};
	}

	close(): void {
		this.database.close();
	}
}
