import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("hosted agent detail header", () => {
	test("keeps the agent source badge out of tab page headers", () => {
		const detailSource = readFileSync(
			new URL("./hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		const sidebarSource = readFileSync(
			new URL("../../components/app-sidebar.tsx", import.meta.url),
			"utf8",
		);

		expect(detailSource).not.toContain("AgentSourceBadge");
		expect(sidebarSource).toContain("AgentSourceBadge");
	});

	test("keeps selected unavailable providers removable without exposing them as primary choices", () => {
		const source = readFileSync(new URL("./hosted-agent-detail.tsx", import.meta.url), "utf8");
		expect(source).toContain("const disabled = Boolean(issue) && !selected;");
		expect(source).toContain("disabled={disabled}");
		expect(source).toContain("customProviders={availableProviders}");
		expect(source).toContain("onClick={() => toggleProvider(p.provider_id)}");
	});
});
