import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("agent Projects presentation", () => {
	test("uses the shared resource-card grid with concise order and access signals", () => {
		const source = readFileSync(new URL("./agent-projects-tab.tsx", import.meta.url), "utf8");

		expect(source).toContain('aria-label="Effective Project read order"');
		expect(source).toContain('data-testid="agent-project-grid"');
		expect(source).toContain('data-testid="agent-project-card"');
		expect(source).toContain("className={HERO_GRID_CLASS}");
		expect(source).toContain("<ProjectResourceCard");
		expect(source).toContain("<ProjectResourceCardSkeleton");
		expect(source).toContain("<UnavailableProjectResourceCard");
		expect(source).toContain("Default write destination");
		expect(source).toMatch(/Read order \$\{position \+ 1\}/);
		expect(source).not.toContain("ProjectKindBadge");
		expect(source).not.toContain('variant="outline">Viewer');
		expect(source).toMatch(/aria-label=\{`Move \$\{projectName\} up`\}/);
		expect(source).toMatch(/aria-label=\{`Move \$\{projectName\} down`\}/);
		expect(source).toMatch(/aria-label=\{`Remove \$\{projectName\}`\}/);
		expect(source).toContain("sm:group-focus-within:opacity-100");
		expect(source).toContain("sm:group-hover:opacity-100");
		expect(source).not.toContain(">Fixed<");
		expect(source).not.toContain("Default writes");
		expect(source).not.toContain("Read access");
		expect(source).not.toContain("Reads Skills and Vaults");
	});

	test("delegates canonical identity, access language, and navigation to the shared Project card", () => {
		const source = readFileSync(
			new URL("../projects/project-resource-card.tsx", import.meta.url),
			"utf8",
		);

		expect(source).toContain("<ProjectKindBadge");
		expect(source).toContain("const showViewer = !isProjectOwner(project)");
		expect(source).toContain('showViewer ? <Badge variant="outline">Viewer</Badge> : null');
		expect(source).toContain("showKind ? <ProjectKindBadge");
		expect(source).toContain("description={projectAlias(project)}");
		expect(source).toContain("projectDetailLink(navigationScope, project.id)");
		expect(source).toContain("ariaLabel={");
		expect(source).toContain("Open ");
	});

	test("routes Agent cards through nested detail scope instead of the library", () => {
		const tabSource = readFileSync(new URL("./agent-projects-tab.tsx", import.meta.url), "utf8");
		const cardSource = readFileSync(
			new URL("../projects/project-resource-card.tsx", import.meta.url),
			"utf8",
		);

		expect(tabSource).toContain("agentResourceScope(agentId, routeSearch)");
		expect(tabSource).toContain("navigationScope={navigationScope}");
		expect(cardSource).toContain("projectDetailLink(navigationScope, project.id)");
		expect(tabSource).not.toContain('from: "agent-projects"');
	});

	test("keeps Project selection behind the compact toolbar dialog", () => {
		const source = readFileSync(new URL("./agent-projects-tab.tsx", import.meta.url), "utf8");

		expect(source).toContain("<ListToolbar");
		expect(source).toContain("<DialogTitle>Add Project</DialogTitle>");
		expect(source).toContain('data-testid="agent-project-add-dialog"');
		expect(source).toContain("<ProjectCompactPicker");
		expect(source).toContain('ariaLabel="Project to add"');
		expect(source).toContain("No Custom or shared Projects are available to add.");
		expect(source).not.toContain("<ProjectScopePicker");
		expect(source).not.toContain('data-testid="agent-project-add"');
	});

	test("preserves binding mutations, confirmation, and query invalidation", () => {
		const source = readFileSync(new URL("./agent-projects-tab.tsx", import.meta.url), "utf8");

		expect(source).toContain('api.POST("/v1/agents/{agent_id}/project-bindings/context"');
		expect(source).toContain('api.PATCH("/v1/agents/{agent_id}/project-bindings/context/reorder"');
		expect(source).toContain('api.DELETE("/v1/agents/{agent_id}/project-bindings/{binding_id}"');
		expect(source).toContain("<ConfirmAction");
		expect(source).toContain('title="Remove this Project?"');
		expect(source).toContain("agentProjectBindingsQueryKey(agentId)");
		expect(source).toContain('invalidateQueries({ queryKey: ["get", "/v1/projects"] })');
	});

	test("adds a fail-closed primary Project group without changing Overview cards", () => {
		const sidebar = readFileSync(new URL("../app-sidebar.tsx", import.meta.url), "utf8");
		const overview = readFileSync(
			new URL("./agent-overview-capabilities.tsx", import.meta.url),
			"utf8",
		);

		expect(sidebar).toContain("resolveAgentDefaultProject(");
		expect(sidebar).toContain("label={primaryProject.name}");
		expect(sidebar).toContain('className="min-w-0 truncate" title={label}');
		expect(sidebar).toContain('["skills", "vaults"] as const');
		expect(sidebar).toMatch(
			/agentProjectDetailHref\(agentId, primaryProject\.id, routeQuery\)\}#\$\{section\}/,
		);
		expect(sidebar).toContain("defaultProjectBindings.isLoading ||");
		expect(sidebar).toContain("defaultProjectBindings.error ||");
		expect(sidebar).toContain("navigableProjects.isLoading ||");
		expect(sidebar).toContain("navigableProjects.error");
		expect(sidebar).not.toContain('label: "Default Project"');
		expect(overview).not.toContain('title="Default Project"');
		expect(overview).not.toContain("agentProjectDetailLink(");
		expect(overview).toContain("<OverviewNavigationCard");
		expect(overview).not.toContain("ProjectResourceCard");
	});

	test("uses canonical resource entities and removes account relationship UI in Agent scope", () => {
		const projectPage = readFileSync(
			new URL("../../pages/dashboard/projects/[id]/page.tsx", import.meta.url),
			"utf8",
		);
		const vaultCards = readFileSync(
			new URL("../vault/vaults-surface.tsx", import.meta.url),
			"utf8",
		);

		expect(projectPage).toContain("<PageHeader");
		expect(projectPage).toContain("<SkillCardGrid");
		expect(projectPage).toContain("<VaultCard");
		expect(projectPage).not.toContain("function VaultRow");
		expect(vaultCards).toContain("export function VaultCard(");
		expect(vaultCards).toContain("actions={actions}");
		expect(projectPage).toContain("!isAgentScope && isOwner && isShareableProject");
		expect(projectPage).toContain("!isAgentScope && !isOwner");
		expect(projectPage).toContain("!isAgentScope && isOwner && isManaged");
	});
});
