import { describe, expect, test } from "bun:test";
import { parseVaultKeyImport } from "./key-import-parse";

describe("parseVaultKeyImport", () => {
	test("parses dotenv key-value lines", () => {
		expect(
			parseVaultKeyImport(`
				# comment
				GITHUB_TOKEN=abc123
				export SENTRY_DSN="https://example.test"
				empty_value=
			`),
		).toEqual({
			entries: [
				{ key: "GITHUB_TOKEN", value: "abc123", line: 3 },
				{ key: "SENTRY_DSN", value: "https://example.test", line: 4 },
				{ key: "EMPTY_VALUE", value: "", line: 5 },
			],
			errors: [],
		});
	});

	test("parses flat JSON objects", () => {
		expect(parseVaultKeyImport('{"api_key":"secret","RETRY_COUNT":3,"ENABLED":true}')).toEqual({
			entries: [
				{ key: "API_KEY", value: "secret" },
				{ key: "RETRY_COUNT", value: "3" },
				{ key: "ENABLED", value: "true" },
			],
			errors: [],
		});
	});

	test("rejects duplicate and invalid keys", () => {
		const result = parseVaultKeyImport(`
			API_KEY=one
			API-KEY=bad
			api_key=two
		`);

		expect(result.entries).toEqual([]);
		expect(result.errors).toEqual([
			'Line 3: invalid key "API-KEY".',
			'Line 4: duplicate key "API_KEY".',
		]);
	});

	test("rejects nested JSON values", () => {
		expect(parseVaultKeyImport('{"API_KEY":{"nested":true}}')).toEqual({
			entries: [],
			errors: ['Key "API_KEY" has a nested value. Use a string, number, or boolean.'],
		});
	});
});
