import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function source(relativePath: string) {
	return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("Agent resource management surfaces", () => {
	test("gates every nested account-resource detail behind Agent identity", () => {
		for (const route of [
			"../../routes/_protected/_dashboard/agents/$id/project-access/$projectId.tsx",
			"../../routes/_protected/_dashboard/agents/$id/skills/$.tsx",
			"../../routes/_protected/_dashboard/agents/$id/vaults/$slug.tsx",
			"../../routes/_protected/_dashboard/agents/$id/memories/$memoryId.tsx",
			"../../routes/_protected/_dashboard/agents/$id/connectors/$name.tsx",
		]) {
			expect(source(route)).toContain("<AgentResourceRouteGate");
		}
		const routeGate = source("./agent-resource-route-gate.tsx");
		expect(routeGate).toContain('"/v1/agents/{agent_id}"');
		expect(routeGate).toContain('render={<Link to="/agents" />}');
		expect(routeGate).toContain('agentMissing ? "/agents" : returnHref');
	});

	test("keeps Project, Skill, and Vault details on the shared header chassis", () => {
		for (const page of [
			"../../pages/dashboard/projects/[id]/page.tsx",
			"../../pages/dashboard/skills/[key]/page.tsx",
			"../../pages/dashboard/vault/[slug]/page.tsx",
		]) {
			expect(source(page)).toContain("<PageHeader");
			expect(source(page)).toContain('variant="ghost"');
		}
	});

	test("enables owner-authorized Agent Skill and Vault mutations without plaintext reads", () => {
		const skillDetail = source("../../pages/dashboard/skills/[key]/page.tsx");
		const vaultDetail = source("../../pages/dashboard/vault/[slug]/page.tsx");

		expect(skillDetail).not.toContain("isAgentScope || (capabilities");
		expect(skillDetail).toContain("capabilities?.canUpdate");
		expect(skillDetail).toContain("capabilities?.canDelete");
		expect(vaultDetail).toContain("global_delete: true");
		expect(vaultDetail).toContain("isOwner ? (");
		expect(vaultDetail).not.toMatch(/encrypted_value|plaintext|secret_value/);
	});

	test("keeps Project-scoped creation and detail returns on the Project hub", () => {
		const projectDetail = source("../../pages/dashboard/projects/[id]/page.tsx");
		const skillDetail = source("../../pages/dashboard/skills/[key]/page.tsx");
		const vaultDetail = source("../../pages/dashboard/vault/[slug]/page.tsx");
		const projectRoute = source(
			"../../routes/_protected/_dashboard/agents/$id/project-access/$projectId.tsx",
		);

		expect(projectRoute).toContain("agentResourceScope(id, search, projectId)");
		expect(projectDetail).toContain("<AgentSkillAddDialog");
		expect(projectDetail).toContain("projects={[project]}");
		expect(projectDetail).toContain("allowedProjectIds={[project.id]}");
		expect(projectDetail).toContain("Attached to this Project");
		expect(skillDetail).toContain("agentProjectDetailHref(");
		expect(skillDetail).toContain("}#skills`");
		expect(vaultDetail).toContain("requestedProjectId");
		expect(vaultDetail).toContain("vaultDetailHrefForScope(");
		expect(vaultDetail).toContain(
			"enabled: !isAgentScope || (scopedBindingsResolved && requestedProjectIsBound)",
		);
		expect(vaultDetail.indexOf("if (requestedProjectUnavailable)")).toBeLessThan(
			vaultDetail.lastIndexOf("if (!vault)"),
		);
	});

	test("keeps audited card actions visible on touch-sized viewports", () => {
		for (const file of [
			"../skills/skill-card.tsx",
			"../memories/memories-surface.tsx",
			"../../pages/dashboard/projects/page.tsx",
			"../../pages/dashboard/vault/[slug]/page.tsx",
		]) {
			const body = source(file);
			expect(body).toContain("opacity-100");
			expect(body).toContain("sm:opacity-0");
			expect(body).toContain("sm:group-hover:opacity-100");
		}
	});
});
