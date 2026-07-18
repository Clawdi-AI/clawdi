import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("shared export routes", () => {
	it("preserves extension-style public export URLs", () => {
		const generatedRouteTree = readFileSync(
			new URL("../routeTree.gen.ts", import.meta.url),
			"utf8",
		);
		const paths = [...generatedRouteTree.matchAll(/\bpath:\s*'([^']+)'/g)].map((match) => match[1]);

		expect(paths).toContain("/s/{$id}.md");
		expect(paths).toContain("/s/{$id}.json");
		expect(paths).not.toContain("/s/{$}/md");
		expect(paths).not.toContain("/s/{$}/json");
	});
});
