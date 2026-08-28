import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("hosted agent detail header", () => {
	test("keeps per-agent failures off the dashboard home", () => {
		const homeSource = readFileSync(
			new URL("../hosted-agents-section.tsx", import.meta.url),
			"utf8",
		);

		for (const misplacedCopy of [
			"HostedDeletionFailureNotices",
			"Cleanup for",
			"Retry cleanup",
			"Contact support before trying again",
		]) {
			expect(homeSource).not.toContain(misplacedCopy);
		}
	});

	test("primes the owner Files grant before embedding and launches via bootstrap", () => {
		const source = readFileSync(new URL("./hosted-agent-detail.tsx", import.meta.url), "utf8");
		const hookSource = readFileSync(
			new URL("./use-files-grant-bootstrap.ts", import.meta.url),
			"utf8",
		);

		// The Files iframe is only rendered after the deployment-scoped grant is
		// primed; the new-window launch bootstraps then navigates (no direct anchor).
		expect(source).toContain("function FilesFrame(");
		expect(source).toContain("useFilesGrantBootstrap(url)");
		expect(source).toContain("useOpenFilesInNewWindow(url, deploymentId)");
		expect(source).toContain("src={url}");
		expect(source).toContain('title="Files"');
		expect(source).toContain("Open in new window");
		expect(source.match(/<OpenInNewWindowButton/g)).toHaveLength(3);
		expect(source).toContain("Opening Files…");
		expect(source).not.toContain('target="_blank"');
		expect(source).toContain("hostedAgentVisibleSectionIds(");
		expect(source).toContain(
			'const activeTab = visibleSectionIds.includes(parsedTab) ? parsedTab : "overview";',
		);

		// The Clerk token only ever travels in the HTTPS Authorization header —
		// never URL, iframe src, DOM, or a persisted browser credential.
		expect(hookSource).toContain("Authorization");
		expect(hookSource).toContain('credentials: "include"');
		expect(hookSource).toContain("openSecureRuntimeWindow(window.open.bind(window))");
		expect(hookSource).not.toContain('"noopener,noreferrer"');
		expect(hookSource).not.toContain("fileBrowserPassword");
		expect(hookSource).not.toContain("Files credentials");
	});

	test("shows Cloud origin only on the established Overview title", () => {
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
		expect(detailSource).not.toContain("AllAgentsAccessBadge");
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

	test("uses the shared billing query contract for overview workspace skills", () => {
		const source = readFileSync(new URL("./hosted-agent-detail.tsx", import.meta.url), "utf8");

		expect(source).toContain("queryKey: billingKeys.workspaceSkills(deployment.resource.id)");
		expect(source).toContain("enabled: isRunningStatus(deploymentStatus)");
		expect(source).toContain("retry: billingQueryRetry");
	});
});
