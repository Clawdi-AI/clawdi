import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./api-keys-panel.tsx", import.meta.url), "utf8");

describe("API keys query states", () => {
	test("renders a retryable error instead of passing failed data to empty lists", () => {
		expect(source).toMatch(/data: keys,\s+error,\s+isLoading,\s+refetch,/);
		expect(source).toContain('title="Couldn’t load API keys"');
		expect(source).toContain("onRetry={() => refetch()}");
		expect(source.indexOf("{error ? (")).toBeLessThan(source.indexOf("<ApiKeysMobileList"));
		expect(source.indexOf("{error ? (")).toBeLessThan(source.indexOf("<DataTable"));
	});
});
