import { describe, expect, test } from "bun:test";
import { resolveAgentOverviewProjectNames } from "@/components/dashboard/agent-project-bindings-query";

const bindings = [
	{
		id: "binding-primary",
		agent_id: "agent-1",
		project_id: "project-1",
		binding_type: "primary" as const,
		priority: 0,
		default_write_enabled: true,
		created_at: "2026-08-02T00:00:00Z",
	},
	{
		id: "binding-context",
		agent_id: "agent-1",
		project_id: "project-2",
		binding_type: "context" as const,
		priority: 1,
		default_write_enabled: false,
		created_at: "2026-08-02T00:01:00Z",
	},
];

describe("resolveAgentOverviewProjectNames", () => {
	test("preserves binding order and reports unresolved names", () => {
		const result = resolveAgentOverviewProjectNames(bindings, [
			{
				id: "project-1",
				name: "Primary Project",
				slug: "primary-project",
				kind: "environment",
				origin_environment_id: "agent-1",
				archived_at: null,
				created_at: "2026-08-02T00:00:00Z",
				is_owner: true,
				owner_display: "Owner",
				owner_handle: "owner",
			},
		]);

		expect(result).toEqual({ names: ["Primary Project"], unresolvedCount: 1 });
	});

	test("keeps true zero bindings distinct from missing names", () => {
		expect(resolveAgentOverviewProjectNames([], [])).toEqual({ names: [], unresolvedCount: 0 });
		expect(resolveAgentOverviewProjectNames(bindings, [])).toEqual({
			names: [],
			unresolvedCount: 2,
		});
	});
});
