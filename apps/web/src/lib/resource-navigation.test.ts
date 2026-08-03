import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	agentResourceReturnTarget,
	parseResourceNavigationOrigin,
	projectDetailHrefFrom,
	projectReturnTarget,
	resourceOriginSearch,
	vaultDetailHrefFrom,
	vaultReturnTarget,
} from "./resource-navigation";

describe("resource navigation", () => {
	it("round-trips Agent origins with deployment identity", () => {
		const search = resourceOriginSearch({
			type: "agent-vaults",
			agentId: "agent 1",
			agentQuery: { source: "on-clawdi", d: "deployment 1", tab: "legacy" },
		});

		expect(search).toEqual({
			from: "agent-vaults",
			agent: "agent 1",
			agentSource: "on-clawdi",
			agentDeployment: "deployment 1",
		});
		expect(parseResourceNavigationOrigin(search)).toEqual({
			type: "agent-vaults",
			agentId: "agent 1",
			agentQuery: { source: "on-clawdi", d: "deployment 1" },
		});
		expect(vaultReturnTarget(search)).toEqual({
			href: "/agents/agent%201/vaults?source=on-clawdi&d=deployment%201",
			label: "Agent Vaults",
		});
	});

	it("builds durable contextual Project and Vault detail links", () => {
		expect(
			projectDetailHrefFrom("project 1", {
				type: "agent-projects",
				agentId: "agent 1",
			}),
		).toBe("/projects/project%201?from=agent-projects&agent=agent%201");
		expect(
			vaultDetailHrefFrom("prod keys", "vault/1", {
				type: "project",
				projectId: "project 1",
			}),
		).toBe("/vaults/prod%20keys?vault=vault%2F1&from=project&originProject=project%201");
	});

	it("returns from related resources to the exact source section", () => {
		expect(
			projectReturnTarget(new URLSearchParams({ from: "agent-projects", agent: "agent 1" })),
		).toEqual({ href: "/agents/agent%201/project-access", label: "Agent Projects" });
		expect(vaultReturnTarget({ from: "project", originProject: "project 1" })).toEqual({
			href: "/projects/project%201#vaults",
			label: "Project",
		});
		expect(agentResourceReturnTarget({ from: "project", originProject: "project 1" })).toEqual({
			href: "/projects/project%201#agents",
			label: "Project",
		});
	});

	it("returns from a Project to the originating Vault by stable identity", () => {
		const search = {
			from: "vault",
			vaultSlug: "prod keys",
			originVault: "vault/1",
		};
		expect(projectReturnTarget(search)).toEqual({
			href: "/vaults/prod%20keys?vault=vault%2F1#projects",
			label: "Vault",
		});
	});

	it("falls back to canonical collections for incomplete or unsupported origins", () => {
		expect(parseResourceNavigationOrigin({ from: "agent-projects" })).toBeNull();
		expect(parseResourceNavigationOrigin({ from: "external", agent: "agent 1" })).toBeNull();
		expect(projectReturnTarget({ from: "agent-projects" })).toEqual({
			href: "/projects",
			label: "Projects",
		});
		expect(vaultReturnTarget(undefined)).toEqual({ href: "/vaults", label: "Vaults" });
		expect(agentResourceReturnTarget(undefined)).toBeNull();
	});

	it("keeps legacy singular Vault URLs as redirects to the plural routes", () => {
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
		expect(legacyListRoute).toContain("replace: true");
		expect(legacyDetailRoute).toContain('to: "/vaults/$slug"');
		expect(legacyDetailRoute).toContain("search,");
		expect(legacyDetailRoute).toContain("replace: true");
	});

	it("uses the canonical project query to drive the Vault collection filter", () => {
		const vaultsSurface = readFileSync(
			new URL("../components/vault/vaults-surface.tsx", import.meta.url),
			"utf8",
		);
		expect(vaultsSurface).toContain('useQueryState(\n\t\t"project"');
		expect(vaultsSurface).toContain(
			"const projectFilter = embedded ? embeddedProjectFilter : projectParam",
		);
		expect(vaultsSurface).toContain("void setProjectParam(projectId)");
		expect(vaultsSurface).toContain("p.id === projectFilter");
	});
});
