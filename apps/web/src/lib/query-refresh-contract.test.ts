import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_ROOT = join(import.meta.dir, "..");

function source(relativePath: string): string {
	return readFileSync(join(SOURCE_ROOT, relativePath), "utf8");
}

describe("query refresh presentation contract", () => {
	test("keeps known empty, count, and error surfaces data-aware", () => {
		const billingHistory = source("hosted/billing/subscription/billing-history-section.tsx");
		const subscriptionDialog = source("hosted/billing/subscription/subscription-create-dialog.tsx");
		const deployWizard = source("hosted/billing/deploy/deploy-wizard.tsx");
		const providerDialog = source("hosted/v2/ai-providers/add-provider-dialog.tsx");
		const hostedInventory = source("hosted/hosted-agent-resolution.ts");
		const hostedAgentHome = source("hosted/agents/agent-home.tsx");
		const connectedAgentDetail = source("components/dashboard/connected-agent-detail.tsx");
		const channelDetail = source("hosted/v2/channels/channel-detail-page.tsx");
		const memoryDetail = source("pages/dashboard/memories/[id]/page.tsx");
		const memories = source("components/memories/memories-surface.tsx");
		const projectsPage = source("pages/dashboard/projects/page.tsx");
		const vaults = source("components/vault/vaults-surface.tsx");
		const projectDetail = source("pages/dashboard/projects/[id]/page.tsx");

		expect(billingHistory).toContain("shouldBlockQueryError(history.error, history.data)");
		expect(subscriptionDialog).toContain(
			"shouldBlockQueryError(createQuote.error, createQuote.data)",
		);
		expect(deployWizard).not.toContain(".isSuccess");
		expect(providerDialog).toContain(
			"providerListAllowsSubmit(isEdit, providers.data !== undefined)",
		);
		expect(hostedInventory).toContain(
			'return { status: "resolved", deployments, hasSnapshot: true, error: null };',
		);
		expect(hostedAgentHome).not.toContain("requestedHostedAgent && !deployment && isFetching");
		expect(hostedAgentHome).toContain("disabled={manualChecking}");
		expect(hostedAgentHome).toContain("!focusManager.isFocused() || isFetchingRef.current");
		expect(connectedAgentDetail).toContain(
			"isApiNotFoundError(error) || shouldBlockQueryError(error, agent)",
		);
		expect(channelDetail).toContain(
			"isApiNotFoundError(channel.error) || shouldBlockQueryError(channel.error, channel.data)",
		);
		expect(memoryDetail).toContain('api.useQuery("get", "/v1/memories/{memory_id}"');
		expect(memoryDetail).toContain('api.useMutation("delete", "/v1/memories/{memory_id}"');
		expect(memories).toContain('$api.useQuery(\n\t\t"get",\n\t\t"/v1/memories"');
		expect(memories).toContain('api.useMutation("post", "/v1/memories"');
		expect(memories).toContain('$api.useMutation("delete", "/v1/memories/{memory_id}"');
		expect(projectsPage).toContain('$api.useMutation("post", "/v1/projects"');
		expect(vaults).not.toContain("projectNamesUnavailable={!!projects.error}");
		expect(projectDetail).not.toContain("selectedBindings.isError");
	});

	test("keeps every intended polling surface out of background tabs", () => {
		const pollingPolicyFiles = [
			"components/app-sidebar.tsx",
			"components/dashboard/add-agent-setup.tsx",
			"components/dashboard/agent-skills-query.ts",
			"hosted/agents/hosted-agent-detail.tsx",
			"hosted/agents/hosted-agent-session-query.ts",
			"hosted/billing/hooks.ts",
			"hosted/billing/wallet/wallet-query.ts",
			"hosted/v2/channels/channel-health-query.ts",
			"hosted/v2/channels/channels-hooks.ts",
			"pages/dashboard/agents/page.tsx",
			"pages/dashboard/page.tsx",
		];
		const missingForegroundPolicy = pollingPolicyFiles.filter(
			(path) => !source(path).includes("refetchIntervalInBackground: false"),
		);

		expect(missingForegroundPolicy).toEqual([]);
		expect(source("components/dashboard/add-agent-setup.tsx")).toContain(
			"return current.some((agent)",
		);
		expect(source("components/dashboard/add-agent-setup.tsx")).toContain("? false : 5_000");
	});
});
