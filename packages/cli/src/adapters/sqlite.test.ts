import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openReadonlySqlite, openSessionIndex, type SqliteStatement } from "./sqlite";

describe("SQLite statement cleanup", () => {
	test("closing a session index releases prepared statements and removes its directory", async () => {
		const database = await openSessionIndex();
		let directory: string;
		let query: SqliteStatement;
		try {
			const location = database.prepare("PRAGMA database_list").get();
			if (
				!location ||
				typeof location !== "object" ||
				!("file" in location) ||
				typeof location.file !== "string"
			) {
				throw new Error("Missing session index database path");
			}
			directory = dirname(location.file);
			expect(existsSync(directory)).toBe(true);
			database.exec("CREATE TABLE entries (value INTEGER)");
			query = database.prepare("SELECT value FROM entries ORDER BY value");
			const insert = database.prepare("INSERT INTO entries VALUES (?)");
			insert.run(1);
			insert.run(2);
			expect([...query.iterate()]).toEqual([{ value: 1 }, { value: 2 }]);
			expect(query.iterate().next().value).toEqual({ value: 1 });
		} finally {
			database.close();
		}
		expect(existsSync(directory)).toBe(false);
		expect(() => query.get()).toThrow();
	});

	test("closing a read-only database releases statements before deleting the fixture", async () => {
		const directory = mkdtempSync(join(tmpdir(), "clawdi-sqlite-test-"));
		try {
			const path = join(directory, "fixture.db");
			const seed = new Database(path, { create: true });
			try {
				seed.exec("CREATE TABLE entries (value INTEGER); INSERT INTO entries VALUES (1), (2)");
			} finally {
				seed.close();
			}
			const database = await openReadonlySqlite(path);
			const query = database.prepare("SELECT value FROM entries ORDER BY value");
			try {
				expect([...query.iterate()]).toEqual([{ value: 1 }, { value: 2 }]);
				expect(query.iterate().next().value).toEqual({ value: 1 });
			} finally {
				database.close();
			}
			expect(() => query.get()).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
		expect(existsSync(directory)).toBe(false);
	});
});
