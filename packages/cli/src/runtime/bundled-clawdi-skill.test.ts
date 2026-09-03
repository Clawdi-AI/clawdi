import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cliRoot = resolve(import.meta.dir, "../..");
const genericSkill = readFileSync(resolve(cliRoot, "skills/clawdi/SKILL.md"), "utf-8");
const hostedSkill = readFileSync(
	resolve(cliRoot, "skills/hosted-versions/1/clawdi/SKILL.md"),
	"utf-8",
);

describe("bundled Clawdi skill context routing", () => {
	it("keeps the generic and hosted context policy aligned", () => {
		expect(section(hostedSkill, "Context Routing")).toBe(section(genericSkill, "Context Routing"));
	});

	it("keeps Cloud history behind current context", () => {
		for (const skill of [genericSkill, hostedSkill]) {
			const routing = section(skill, "Context Routing");
			const memory = routing.indexOf("`memory_search`");
			const sessions = routing.indexOf("`session_search`");

			expect(routing).toMatch(/current conversation/i);
			expect(memory).toBeGreaterThan(-1);
			expect(sessions).toBeGreaterThan(memory);
			expect(routing).not.toMatch(/aggressively|when unsure/i);
			expect(skill.split("---")[1]).toContain("Gmail");
		}
	});
});

function section(content: string, heading: string): string {
	const marker = `## ${heading}`;
	const start = content.indexOf(marker);
	if (start === -1) throw new Error(`missing ${marker}`);
	const bodyStart = start + marker.length;
	const nextHeading = content.indexOf("\n## ", bodyStart);
	return content.slice(start, nextHeading === -1 ? content.length : nextHeading).trim();
}

describe("bundled Clawdi skill connector contract", () => {
	const genericRouting = section(genericSkill, "Connector Routing");
	const hostedRouting = section(hostedSkill, "Connector Routing");
	const genericWorkflow = section(genericSkill, "Connector Workflow");
	const hostedWorkflow = section(hostedSkill, "Connector Workflow");

	it("keeps the connector protocol aligned across runtimes", () => {
		expect(hostedWorkflow).toBe(genericWorkflow);
	});

	it("keeps the same guarded CLI, API, then connector priority", () => {
		expect(hostedRouting).toBe(genericRouting);

		const officialCli = genericRouting.indexOf("**Official service CLI**");
		const officialApi = genericRouting.indexOf("**Official API or SDK**");
		const connector = genericRouting.indexOf("**Clawdi connector**");

		expect(officialCli).toBeGreaterThan(-1);
		expect(officialApi).toBeGreaterThan(officialCli);
		expect(connector).toBeGreaterThan(officialApi);

		const policy = genericRouting.replace(/\s+/g, " ").toLowerCase();
		expect(policy).toMatch(/if it is missing, install .* only when/);
		expect(policy).toMatch(/cannot complete non-interactively, continue to the api path/);
	});

	it("limits only Clawdi host management in Hosted", () => {
		const boundary = section(hostedSkill, "Hosted Boundary");
		expect(boundary).toMatch(/third-party .* routing .* unchanged in Hosted/is);
		for (const command of [
			"`clawdi setup`",
			"`clawdi wallet`",
			"`clawdi vault`",
			"`clawdi ai-provider`",
		]) {
			expect(boundary).toContain(command);
		}
	});

	it("uses Composio meta-tools with schema-driven discovery and execution", () => {
		for (const workflow of [genericWorkflow, hostedWorkflow]) {
			expect(workflow).toContain("`queries` and `session` schema");
			expect(workflow).toContain("reuse the returned session ID");
			expect(workflow).toContain("exact toolkit and tool slugs");
			expect(workflow).toContain("`COMPOSIO_GET_TOOL_SCHEMAS`");
			expect(workflow).toContain("never invent fields or inputs");
			expect(workflow).toContain("`COMPOSIO_MULTI_EXECUTE_TOOL`");
			expect(workflow).toContain("Batch only independent calls");
			expect(workflow).not.toMatch(
				/dynamically registered|individual tools|already authenticated/i,
			);
		}
	});

	it("documents a schema-driven auth-link handshake", () => {
		for (const workflow of [genericWorkflow, hostedWorkflow]) {
			const compact = workflow.replace(/\s+/g, " ");
			// ComposioHQ/composio@a84d05fc99f00c2d77d7f25ba6553805d7d28b92
			// exposes active|initiated|failed and a nullable redirect_url.
			expect(compact).toContain("`COMPOSIO_MANAGE_CONNECTIONS`");
			expect(compact).toContain("Continue on `active`");
			expect(compact).toContain("On `initiated`");
			expect(compact).toContain("non-empty `redirect_url` as a clickable authentication link");
			expect(compact).toContain("authorization is pending");
			expect(compact).toContain("link URL must be exactly that value");
			expect(compact).toContain("has no non-empty `redirect_url`");
			expect(compact).toContain("authorization cannot continue and stop");
			expect(compact).toContain("On `failed`, report the returned error and stop");
			expect(compact).toContain("only when `tools/list` exposes one");
			expect(compact).toContain("without inventing polling arguments");
			expect(compact).toContain("Continue only when it reports an active connection");
			expect(compact).toContain("non-terminal status its schema defines");
			expect(compact).toContain("report any terminal failure");
			expect(compact).toContain("re-run search to");
			expect(compact).toContain("Never construct a substitute link, ask for OAuth credentials");
			expect(workflow).not.toContain("COMPOSIO_WAIT_FOR_CONNECTIONS");
			expect(workflow).not.toContain("Return only the authorization link");
			expect(workflow).not.toMatch(/dashboard/i);
		}
	});

	it("requires complete targets and keeps result handling conditional", () => {
		for (const workflow of [genericWorkflow, hostedWorkflow]) {
			const compact = workflow.replace(/\s+/g, " ");
			expect(compact).toContain("`COMPOSIO_REMOTE_BASH_TOOL`");
			expect(compact).toContain("`COMPOSIO_REMOTE_WORKBENCH`");
			expect(compact).toContain("`sync_response_to_workbench`");
			expect(compact).toContain("only when a result may be large or needs later remote processing");
			expect(compact).toContain("only for large responses saved remotely or remote artifacts");
			expect(compact).toContain("complete target identity");
			expect(compact).toContain("never authorizes guessing a missing recipient");
			expect(compact).toContain("do not request redundant confirmation");
			expect(compact).toContain("signed-file metadata, pagination fields");
			expect(compact).toContain("Select an account only when the schema");
			expect(compact).toContain("additional or future meta-tools");
		}
	});

	it("keeps Hosted guidance within its exposed capability boundary", () => {
		expect(hostedSkill).toContain("## Memory");
		expect(hostedSkill).toContain("`memory_search`");
		expect(hostedSkill).toContain("`memory_add`");
		expect(hostedSkill).toContain("`memory_extract`");
		expect(hostedSkill).toContain("## Projects");
		expect(hostedSkill).toContain("`project_current`");
		expect(hostedSkill).toContain("## Vault");
		expect(hostedSkill).toContain("`vault_get`");
		expect(hostedSkill).toContain("`vault_resolve`");
		expect(section(hostedSkill, "Vault").replace(/\s+/g, " ")).toMatch(
			/not mutation.*live schemas/i,
		);
		expect(hostedSkill).not.toMatch(/dashboard/i);
		expect(genericSkill).toContain("## Memory");
		expect(genericSkill).toContain("## Vault");
		expect(genericSkill).toContain("a human operator");
		expect(genericSkill).toContain("## AI Provider Management");
		expect(genericSkill).not.toContain("## AI Provider CLI");
	});
});
