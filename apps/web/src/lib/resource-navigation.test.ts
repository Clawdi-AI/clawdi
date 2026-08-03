import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	agentResourceScope,
	LIBRARY_RESOURCE_SCOPE,
	legacyAgentResourceScope,
	libraryManagementTarget,
	projectDetailHrefForScope,
	projectDetailLink,
	resourceCollectionTarget,
	validateResourceDetailSearch,
	vaultDetailHrefForScope,
	vaultDetailLink,
} from "./resource-navigation";

describe("resource navigation scopes", () => {
	it("keeps library detail and collection navigation global", () => {
		expect(resourceCollectionTarget(LIBRARY_RESOURCE_SCOPE, "projects")).toEqual({
			href: "/projects",
			label: "Projects",
		});
		expect(projectDetailHrefForScope(LIBRARY_RESOURCE_SCOPE, "project 1")).toBe(
			"/projects/project%201",
		);
		expect(vaultDetailHrefForScope(LIBRARY_RESOURCE_SCOPE, "prod keys", "vault/1")).toBe(
			"/vaults/prod%20keys?vault=vault%2F1",
		);
		expect(projectDetailLink(LIBRARY_RESOURCE_SCOPE, "project 1")).toMatchObject({
			to: "/projects/$id",
			params: { id: "project 1" },
		});
	});

	it("builds nested Agent details and preserves hosted deployment identity", () => {
		const scope = agentResourceScope("agent 1", {
			source: "on-clawdi",
			d: "deployment 1",
			tab: "legacy",
			project: "unrelated",
		});

		expect(resourceCollectionTarget(scope, "projects")).toEqual({
			href: "/agents/agent%201/project-access?source=on-clawdi&d=deployment%201",
			label: "Agent Projects",
		});
		expect(projectDetailHrefForScope(scope, "project 1")).toBe(
			"/agents/agent%201/project-access/project%201?source=on-clawdi&d=deployment%201",
		);
		expect(vaultDetailHrefForScope(scope, "prod keys", "vault/1")).toBe(
			"/agents/agent%201/vaults/prod%20keys?source=on-clawdi&d=deployment%201&vault=vault%2F1",
		);
		expect(projectDetailLink(scope, "project 1")).toMatchObject({
			to: "/agents/$id/project-access/$projectId",
			params: { id: "agent 1", projectId: "project 1" },
			search: { source: "on-clawdi", d: "deployment 1" },
		});
		expect(vaultDetailLink(scope, "prod keys", "vault/1")).toMatchObject({
			to: "/agents/$id/vaults/$slug",
			params: { id: "agent 1", slug: "prod keys" },
			search: { source: "on-clawdi", d: "deployment 1", vault: "vault/1" },
		});
	});

	it("makes leaving the Agent shell an explicit library-management target", () => {
		expect(libraryManagementTarget("projects", { projectId: "project 1" })).toEqual({
			href: "/projects/project%201",
			label: "Manage in resource library",
		});
		expect(
			libraryManagementTarget("vaults", { vaultSlug: "prod keys", vaultId: "vault/1" }),
		).toEqual({
			href: "/vaults/prod%20keys?vault=vault%2F1",
			label: "Manage in resource library",
		});
	});

	it("accepts old from-query Agent links only as a compatibility bridge", () => {
		expect(
			legacyAgentResourceScope(
				{
					from: "agent-vaults",
					agent: "agent 1",
					agentSource: "on-clawdi",
					agentDeployment: "deployment 1",
				},
				"vaults",
			),
		).toEqual({
			kind: "agent",
			agentId: "agent 1",
			agentQuery: { source: "on-clawdi", d: "deployment 1" },
		});
		expect(
			legacyAgentResourceScope({ from: "agent-vaults", agent: "agent 1" }, "projects"),
		).toBeNull();
		expect(legacyAgentResourceScope({ from: "agent-projects" }, "projects")).toBeNull();
	});

	it("validates resource query strings at the route boundary", () => {
		expect(
			validateResourceDetailSearch({
				vault: "vault 1",
				joined: 42,
				from: ["agent-vaults"],
				future: "kept",
			}),
		).toEqual({ vault: "vault 1", future: "kept" });
	});

	it("keeps legacy singular Vault URLs as redirects to plural routes", () => {
		const legacyListRoute = readFileSync(
			new URL("../routes/_protected/_dashboard/vault/index.tsx", import.meta.url),
			"utf8",
		);
		const legacyDetailRoute = readFileSync(
			new URL("../routes/_protected/_dashboard/vault/$slug.tsx", import.meta.url),
			"utf8",
		);
		expect(legacyListRoute).toContain('to: "/vaults"');
		expect(legacyListRoute).toContain("search");
		expect(legacyDetailRoute).toContain('to: "/vaults/$slug"');
		expect(legacyDetailRoute).toContain("search,");
	});

	it("keeps the canonical project query as the library Vault filter", () => {
		const vaultsSurface = readFileSync(
			new URL("../components/vault/vaults-surface.tsx", import.meta.url),
			"utf8",
		);
		expect(vaultsSurface).toContain('useQueryState(\n\t\t"project"');
		expect(vaultsSurface).toContain(
			"const projectFilter = embedded ? embeddedProjectFilter : projectParam",
		);
		expect(vaultsSurface).toContain("void setProjectParam(projectId)");
	});
});
