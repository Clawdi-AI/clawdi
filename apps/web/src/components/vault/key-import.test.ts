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
				{ key: "GITHUB_TOKEN", rawKey: "GITHUB_TOKEN", value: "abc123", line: 3 },
				{ key: "SENTRY_DSN", rawKey: "SENTRY_DSN", value: "https://example.test", line: 4 },
				{ key: "EMPTY_VALUE", rawKey: "empty_value", value: "", line: 5 },
			],
			errors: [],
		});
	});

	test("keeps hash characters inside env values", () => {
		expect(
			parseVaultKeyImport(`
				PASSWORD="hash#123"
				UNQUOTED=hash#123
				WITH_COMMENT=value # comment
				QUOTED_WITH_COMMENT="hash#123" # comment
			`),
		).toEqual({
			entries: [
				{ key: "PASSWORD", rawKey: "PASSWORD", value: "hash#123", line: 2 },
				{ key: "UNQUOTED", rawKey: "UNQUOTED", value: "hash#123", line: 3 },
				{ key: "WITH_COMMENT", rawKey: "WITH_COMMENT", value: "value", line: 4 },
				{
					key: "QUOTED_WITH_COMMENT",
					rawKey: "QUOTED_WITH_COMMENT",
					value: "hash#123",
					line: 5,
				},
			],
			errors: [],
		});
	});

	test("parses flat JSON objects", () => {
		expect(parseVaultKeyImport('{"api_key":"secret","RETRY_COUNT":3,"ENABLED":true}')).toEqual({
			entries: [
				{ key: "API_KEY", rawKey: "api_key", value: "secret" },
				{ key: "RETRY_COUNT", rawKey: "RETRY_COUNT", value: "3" },
				{ key: "ENABLED", rawKey: "ENABLED", value: "true" },
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
			'Line 3: invalid key "API-KEY". Key names can use only letters, numbers, and underscores (_). Hyphens, spaces, and other characters aren\'t allowed.',
			'Line 4: duplicate key "api_key" (same as "API_KEY" after normalization to "API_KEY").',
		]);
	});

	test("explains JSON duplicates after uppercase normalization", () => {
		const result = parseVaultKeyImport('{"api_key":"one","API_KEY":"two"}');

		expect(result.entries).toEqual([]);
		expect(result.errors).toEqual([
			'JSON import: duplicate key "API_KEY" (same as "api_key" after normalization to "API_KEY").',
		]);
	});

	test("rejects nested JSON values", () => {
		expect(parseVaultKeyImport('{"API_KEY":{"nested":true}}')).toEqual({
			entries: [],
			errors: ['Key "API_KEY" has a nested value. Use a string, number, or boolean.'],
		});
	});
});
