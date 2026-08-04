import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const projectDetailSource = readFileSync(new URL("./[id]/page.tsx", import.meta.url), "utf8");
const agentProjectsSource = readFileSync(
	new URL("../../../components/dashboard/agent-projects-tab.tsx", import.meta.url),
	"utf8",
);

describe("resource action dialogs", () => {
	test("keeps Vault create and attach actions in separate dialogs", () => {
		expect(projectDetailSource).toContain("<DialogTitle>Create vault</DialogTitle>");
		expect(projectDetailSource).toContain("<DialogTitle>Attach vault</DialogTitle>");
		expect(projectDetailSource).toContain("Create an account-owned Vault and attach it");
		expect(projectDetailSource).not.toContain("Create a new Vault");
		expect(projectDetailSource).not.toContain("Create and attach");
	});

	test("keeps Project create and link as distinct actions", () => {
		expect(agentProjectsSource).toContain("<DialogTitle>Create new Project</DialogTitle>");
		expect(agentProjectsSource).toContain("<DialogTitle>Link existing Project</DialogTitle>");
		expect(agentProjectsSource).toContain("Create new");
		expect(agentProjectsSource).toContain("Link existing");
	});
});
