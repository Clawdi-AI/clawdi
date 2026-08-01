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
		expect(source).toContain('isProjectOwner(project) ? "Owner" : "Viewer"');
		expect(source).toContain("description={projectAlias(project)}");
		expect(source).toContain('to: "/projects/$id"');
		expect(source).toContain("ariaLabel={");
		expect(source).toContain("Open ");
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
		expect(source).toContain('invalidateQueries({ queryKey: ["projects"] })');
	});
});
