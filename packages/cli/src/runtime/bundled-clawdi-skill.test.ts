import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cliRoot = resolve(import.meta.dir, "../..");
const genericSkill = readFileSync(resolve(cliRoot, "skills/clawdi/SKILL.md"), "utf-8");
const hostedSkill = readFileSync(
	resolve(cliRoot, "skills/hosted-versions/1/clawdi/SKILL.md"),
	"utf-8",
);

function section(content: string, heading: string): string {
	const marker = `## ${heading}`;
	const start = content.indexOf(marker);
	if (start === -1) throw new Error(`missing ${marker}`);
	const bodyStart = start + marker.length;
	const nextHeading = content.indexOf("\n## ", bodyStart);
	return content.slice(start, nextHeading === -1 ? content.length : nextHeading).trim();
}

describe("bundled Clawdi skill connector contract", () => {
	const genericConnectors = section(genericSkill, "Connectors");
	const hostedConnectors = section(hostedSkill, "Connectors");

	it("keeps the generic and hosted connector workflows aligned", () => {
		expect(hostedConnectors).toBe(genericConnectors);
	});

	it("uses Composio meta-tools with schema-driven discovery and execution", () => {
		for (const connectors of [genericConnectors, hostedConnectors]) {
			expect(connectors).toContain("Start each external-app workflow with `COMPOSIO_SEARCH_TOOLS`");
			expect(connectors).toContain("`queries` and `session` schema");
			expect(connectors).toContain("reuse the returned session ID");
			expect(connectors).toContain("exact toolkit and tool slugs");
			expect(connectors).toContain("`COMPOSIO_GET_TOOL_SCHEMAS`");
			expect(connectors).toContain("never invent fields or inputs");
			expect(connectors).toContain("`COMPOSIO_MULTI_EXECUTE_TOOL`");
			expect(connectors).toContain("Batch only independent calls");
			expect(connectors).not.toMatch(
				/dynamically registered|individual tools|already authenticated/i,
			);
		}
	});

	it("documents a schema-driven auth-link handshake", () => {
		for (const connectors of [genericConnectors, hostedConnectors]) {
			const compact = connectors.replace(/\s+/g, " ");
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
			expect(connectors).not.toContain("COMPOSIO_WAIT_FOR_CONNECTIONS");
			expect(connectors).not.toContain("Return only the authorization link");
			expect(connectors).not.toMatch(/dashboard/i);
		}
	});

	it("requires complete targets and keeps result handling conditional", () => {
		for (const connectors of [genericConnectors, hostedConnectors]) {
			const compact = connectors.replace(/\s+/g, " ");
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

	it("teaches hosted MCP capabilities without local-only operations", () => {
		expect(hostedSkill).toContain("## Memory");
		expect(hostedSkill).toContain("`memory_search`");
		expect(hostedSkill).toContain("`memory_add`");
		expect(hostedSkill).toContain("`memory_extract`");
		expect(hostedSkill).toContain("## Projects");
		expect(hostedSkill).toContain("`project_current`");
		expect(hostedSkill).toContain("## Vault Metadata");
		expect(hostedSkill).toContain("`vault_get`");
		expect(hostedSkill).toContain("`vault_resolve`");
		expect(hostedSkill).not.toMatch(/\bVault CLI\b|\bAI Provider CLI\b|\bsetup\b/i);
		expect(hostedSkill).not.toMatch(/dashboard/i);
		expect(genericSkill).toContain("## Memory");
		expect(genericSkill).toContain("## Vault CLI");
		expect(genericSkill).toContain("## AI Provider CLI");
	});
});
