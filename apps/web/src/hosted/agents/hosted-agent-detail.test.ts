import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("hosted agent detail header", () => {
	test("shows the Cloud and account-wide badges beside their scoped titles", () => {
		const detailSource = readFileSync(
			new URL("./hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);
		const sidebarSource = readFileSync(
			new URL("../../components/app-sidebar.tsx", import.meta.url),
			"utf8",
		);

		expect(detailSource).toContain('<AgentSourceBadge source="hosted" compact />');
		expect(detailSource).toContain('activeTab === "overview" ? (');
		expect(detailSource).toContain("isAccountWideAgentSection(activeTab)");
		expect(detailSource).toContain("<AccountWideScopeBadge />");
		expect(sidebarSource).toContain("AgentSourceBadge");
	});

	test("keeps persisted provider state visible until a replacement provider is selected", () => {
		const source = readFileSync(new URL("./hosted-agent-detail.tsx", import.meta.url), "utf8");
		expect(source).toContain("const disabled = Boolean(issue) && !selected;");
		expect(source).toContain("disabled={disabled}");
		expect(source).toContain("selectProvider,");
		expect(source).toContain("onClick={() => selectProvider(p.provider_id)}");
		expect(source).toContain("onClick={() => selectProvider(MANAGED_AI_CHOICE)}");
		expect(source).toContain('data-testid="provider-choice-grid"');
		expect(source).toContain("<EntityAddCard");
		expect(source).not.toContain("customProviders=");
		expect(source).not.toContain("onPrimaryProviderChange=");
	});

	test("removes the shared runtime dashboard action without removing Console access", () => {
		const detailSource = readFileSync(
			new URL("./hosted-agent-detail.tsx", import.meta.url),
			"utf8",
		);

		expect(detailSource).not.toContain("const headerActions");
		expect(detailSource).not.toContain("actions={headerActions}");
		expect(detailSource).not.toContain("Access {runtimeBrowserUiLabel(runtime)}");
		expect(detailSource).toContain("<RuntimeUiAccessDialog");
	});

	test("describes missing projection sections with visible navigation labels", () => {
		const source = readFileSync(new URL("./hosted-agent-detail.tsx", import.meta.url), "utf8");

		expect(source).toContain(
			"Projects, Skills, Vaults, and Channels will appear when this agent is ready.",
		);
		expect(source).not.toContain(
			"Sessions, Projects, Skills, Vaults, and Channels will appear when this agent is ready.",
		);
		expect(source).not.toContain("Vaults, profile, and channels");
	});
});
