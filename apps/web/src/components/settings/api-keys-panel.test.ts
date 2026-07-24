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

describe("API key creation safeguards", () => {
	test("trims labels and rejects whitespace-only input", () => {
		expect(source).toContain("const normalizedNewLabel = newLabel.trim()");
		expect(source).toContain("createKey.mutate(normalizedNewLabel)");
		expect(source).toContain("disabled={!normalizedNewLabel || createKey.isPending");
	});

	test("does not replace an unacknowledged one-time key", () => {
		expect(source).toContain("normalizedNewLabel && createdKey === null");
		expect(source).toContain("createKey.isPending || createdKey !== null");
		expect(source).toContain("onClick={() => setCreatedKey(null)}");
		expect(source).toContain("I&apos;ve saved it");
	});

	test("normalizes create and revoke mutation errors", () => {
		expect(source).toContain('onError: toastApiError("Couldn\'t create key")');
		expect(source).toContain('onError: toastApiError("Couldn\'t turn off key")');
		expect(source).not.toMatch(/onError:.*\.detail/);
	});
});
