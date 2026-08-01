import { describe, expect, test } from "bun:test";
import type { components } from "@/lib/api-schemas";
import { effectiveAgentProjectIds, vaultsForProjectIds } from "./vault-scope";

type Binding = components["schemas"]["AgentProjectBindingResponse"];
type Vault = components["schemas"]["VaultResponse"];

function binding(
	id: string,
	projectId: string,
	bindingType: "primary" | "context",
	priority: number,
): Binding {
	return {
		id,
		agent_id: "agent_1",
		project_id: projectId,
		binding_type: bindingType,
		priority,
		default_write_enabled: bindingType === "primary",
		created_at: "2026-08-01T00:00:00Z",
	};
}

function vault(id: string, projectIds: string[]): Vault {
	return {
		id,
		slug: id,
		name: id,
		project_ids: projectIds,
		is_owner: true,
		item_count: 1,
		created_at: "2026-08-01T00:00:00Z",
	};
}

describe("agent Vault scope", () => {
	test("orders the primary Project before ordered context bindings and deduplicates ids", () => {
		expect(
			effectiveAgentProjectIds([
				binding("context-2", "project_context_2", "context", 2),
				binding("primary", "project_primary", "primary", 0),
				binding("context-1", "project_context_1", "context", 1),
				binding("duplicate", "project_context_1", "context", 3),
			]),
		).toEqual(["project_primary", "project_context_1", "project_context_2"]);
	});

	test("returns only Vaults attached to the agent's effective Project set", () => {
		const visible = vaultsForProjectIds(
			[
				vault("primary-vault", ["project_primary"]),
				vault("context-vault", ["project_other", "project_context"]),
				vault("unrelated-vault", ["project_other"]),
				vault("unattached-vault", []),
			],
			["project_primary", "project_context"],
		);

		expect(visible.map((item) => item.id)).toEqual(["primary-vault", "context-vault"]);
		expect(vaultsForProjectIds([vault("private", ["project_other"])], [])).toEqual([]);
	});
});
