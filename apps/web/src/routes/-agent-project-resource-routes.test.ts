import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const routeSource = (resource: "skills" | "vaults") =>
	readFileSync(
		new URL(
			`./_protected/_dashboard/agents/$id/project-access/$projectId/${resource}.tsx`,
			import.meta.url,
		),
		"utf8",
	);

describe("Agent Project resource routes", () => {
	test("keep the shared Agent and Project access gate above both focused pages", () => {
		const parent = readFileSync(
			new URL("./_protected/_dashboard/agents/$id/project-access/$projectId.tsx", import.meta.url),
			"utf8",
		);
		expect(parent).toContain("<AgentResourceRouteGate");
		expect(parent).toContain("projectAccess={{ projectId }}");
		expect(parent).toContain("<Outlet />");
	});

	test("render one canonical Project detail collection in focused mode", () => {
		for (const resource of ["skills", "vaults"] as const) {
			const source = routeSource(resource);
			expect(source).toContain(`routeHeadTitle("${resource === "skills" ? "Skills" : "Vaults"}")`);
			expect(source).toContain("<ProjectDetailPage");
			expect(source).toContain(`focus="${resource}"`);
			expect(source).toContain("agentResourceScope(id, search, projectId)");
		}
	});
});
