import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	agentResourceScope,
	connectorDetailHrefForScope,
	connectorDetailLink,
	LIBRARY_RESOURCE_SCOPE,
	legacyAgentResourceScope,
	libraryManagementTarget,
	memoryDetailHrefForScope,
	memoryDetailLink,
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
		expect(memoryDetailHrefForScope(LIBRARY_RESOURCE_SCOPE, "memory 1")).toBe(
			"/memories/memory%201",
		);
		expect(connectorDetailHrefForScope(LIBRARY_RESOURCE_SCOPE, "google drive")).toBe(
			"/connectors/google%20drive",
		);
		expect(resourceCollectionTarget(LIBRARY_RESOURCE_SCOPE, "memories")).toEqual({
			href: "/memories",
			label: "Memories",
		});
		expect(resourceCollectionTarget(LIBRARY_RESOURCE_SCOPE, "connectors")).toEqual({
			href: "/connectors",
			label: "Connectors",
		});
		expect(projectDetailLink(LIBRARY_RESOURCE_SCOPE, "project 1")).toMatchObject({
			to: "/projects/$id",
			params: { id: "project 1" },
		});
		expect(memoryDetailLink(LIBRARY_RESOURCE_SCOPE, "memory 1")).toMatchObject({
			to: "/memories/$id",
			params: { id: "memory 1" },
		});
		expect(connectorDetailLink(LIBRARY_RESOURCE_SCOPE, "google drive")).toMatchObject({
			to: "/connectors/$name",
			params: { name: "google drive" },
		});
	});

	it("builds clean nested Agent navigation with explicit flat Vault state", () => {
		const scope = agentResourceScope("agent 1", "project 1");

		expect(resourceCollectionTarget(scope, "projects")).toEqual({
			href: "/agents/agent%201/project-access",
			label: "Projects",
		});
		expect(projectDetailHrefForScope(scope, "project 1")).toBe(
			"/agents/agent%201/project-access/project%201",
		);
		expect(vaultDetailHrefForScope(scope, "prod keys", "vault/1")).toBe(
			"/agents/agent%201/vaults/prod%20keys?project=project%201&vault=vault%2F1",
		);
		expect(resourceCollectionTarget(scope, "vaults")).toEqual({
			href: "/agents/agent%201/project-access/project%201/vaults",
			label: "Vaults",
		});
		expect(resourceCollectionTarget(scope, "memories")).toEqual({
			href: "/agents/agent%201/memories",
			label: "Memories",
		});
		expect(resourceCollectionTarget(scope, "connectors")).toEqual({
			href: "/agents/agent%201/connectors",
			label: "Connectors",
		});
		expect(memoryDetailHrefForScope(scope, "memory 1")).toBe(
			"/agents/agent%201/memories/memory%201",
		);
		expect(connectorDetailHrefForScope(scope, "google drive")).toBe(
			"/agents/agent%201/connectors/google%20drive",
		);
		expect(projectDetailLink(scope, "project 1")).toMatchObject({
			to: "/agents/$id/project-access/$projectId",
			params: { id: "agent 1", projectId: "project 1" },
		});
		expect(projectDetailLink(scope, "project 1")).not.toHaveProperty("search");
		expect(vaultDetailLink(scope, "prod keys", "vault/1")).toMatchObject({
			to: "/agents/$id/vaults/$slug",
			params: { id: "agent 1", slug: "prod keys" },
			search: {
				project: "project 1",
				vault: "vault/1",
			},
		});
		expect(memoryDetailLink(scope, "memory 1")).toMatchObject({
			to: "/agents/$id/memories/$memoryId",
			params: { id: "agent 1", memoryId: "memory 1" },
		});
		expect(memoryDetailLink(scope, "memory 1")).not.toHaveProperty("search");
		expect(connectorDetailLink(scope, "google drive")).toMatchObject({
			to: "/agents/$id/connectors/$name",
			params: { id: "agent 1", name: "google drive" },
		});
		expect(connectorDetailLink(scope, "google drive")).not.toHaveProperty("search");
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

	it("ignores obsolete Hosted identity fields on legacy resource-return links", () => {
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
