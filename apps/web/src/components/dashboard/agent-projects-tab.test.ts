import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("agent Projects presentation", () => {
	test("keeps one ordered stack with concise role and access signals", () => {
		const source = readFileSync(new URL("./agent-projects-tab.tsx", import.meta.url), "utf8");

		expect(source).toContain('aria-label="Effective Project read order"');
		expect(source).toContain("Writes here by default");
		expect(source).toContain("showAccess={!isProjectOwner(project)}");
		expect(source).toMatch(/aria-label=\{`Move \$\{projectName\} up`\}/);
		expect(source).toMatch(/aria-label=\{`Move \$\{projectName\} down`\}/);
		expect(source).toMatch(/aria-label=\{`Remove \$\{projectName\}`\}/);
		expect(source).not.toContain(">Fixed<");
		expect(source).not.toContain("Default writes");
		expect(source).not.toContain("Read access");
		expect(source).not.toContain("Reads Skills and Vaults");
	});
});
