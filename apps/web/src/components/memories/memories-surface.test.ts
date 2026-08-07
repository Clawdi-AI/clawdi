import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("shared Memories surface", () => {
	test("keeps every-agent access behavior in one reusable component", () => {
		const source = readFileSync(new URL("./memories-surface.tsx", import.meta.url), "utf8");

		expect(source).toContain('$api.useQuery(\n\t\t"get",\n\t\t"/v1/memories"');
		expect(source).toContain('api.PATCH("/v1/settings"');
		expect(source).toContain('api.useMutation("post", "/v1/memories"');
		expect(source).toContain('$api.useMutation("delete", "/v1/memories/{memory_id}"');
		expect(source).toContain("memoryDetailLink(scope, memory.id)");
		expect(source).toContain("this memory from all agents");
		expect(source).toContain("DataTablePagination");
		expect(source).toContain("Search memories…");
		expect(source).not.toMatch(/agent_id|environment_id/);
		expect(source).not.toContain("@/pages/dashboard");
	});
});
