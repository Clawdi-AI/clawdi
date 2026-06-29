import { describe, expect, it } from "bun:test";
import { routeTree } from "@/routeTree.gen";

describe("shared export routes", () => {
	it("preserves extension-style public export URLs", () => {
		const paths = Object.values(routeTree.children ?? {}).map((route) => route.options.path);

		expect(paths).toContain("/s/{$id}.md");
		expect(paths).toContain("/s/{$id}.json");
		expect(paths).not.toContain("/s/{$}/md");
		expect(paths).not.toContain("/s/{$}/json");
	});
});
