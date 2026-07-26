import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEPLOY_ASSISTANT_NAME_MAX_LENGTH } from "@/hosted/billing/deploy/deploy-request";

const wizardSource = readFileSync(new URL("./deploy-wizard.tsx", import.meta.url), "utf8");
const planComparisonSource = readFileSync(
	new URL("../subscription/plan-comparison.tsx", import.meta.url),
	"utf8",
);
const planChangeDialogSource = readFileSync(
	new URL("../subscription/plan-change-dialog.tsx", import.meta.url),
	"utf8",
);
const agentDetailSource = readFileSync(
	new URL("../../agents/hosted-agent-detail.tsx", import.meta.url),
	"utf8",
);
const terminalPanelSource = readFileSync(
	new URL("../../agents/hosted-terminal-panel.tsx", import.meta.url),
	"utf8",
);
const modelBindingPickerSource = readFileSync(
	new URL("../../v2/ai-providers/model-binding-picker.tsx", import.meta.url),
	"utf8",
);

describe("deploy wizard personalization", () => {
	test("renders the required bounded agent name input", () => {
		expect(wizardSource).toContain('htmlFor="agent-name"');
		expect(wizardSource).toContain('<Label htmlFor="agent-name">');
		expect(wizardSource).toContain('id="agent-name"');
		expect(wizardSource).toContain("maxLength={DEPLOY_ASSISTANT_NAME_MAX_LENGTH}");
		expect(DEPLOY_ASSISTANT_NAME_MAX_LENGTH).toBe(255);
		expect(wizardSource).toContain("required");
		expect(wizardSource).toContain("aria-invalid={nameError ? true : undefined}");
		expect(wizardSource).toContain('type="submit"');
		expect(wizardSource).toContain("submitBlockingReason");
	});
});

describe("deploy wizard product copy and flow", () => {
	test("uses customer language and keeps channels out of the decision flow", () => {
		expect(wizardSource).toContain('title="Agent software"');
		expect(wizardSource).toContain("<DeploySectionSkeleton columns={2} />");
		expect(wizardSource).toContain('description="Choose a compute plan and how paid plans renew."');
		expect(wizardSource).toContain("After your agent is ready, connect channels from its page.");
		expect(wizardSource).not.toContain('title="Runtimes"');
		expect(wizardSource).not.toContain("execution engine");
		expect(wizardSource).not.toContain("per-deployment funding");
		expect(wizardSource).not.toContain("server quote");
		expect(wizardSource).not.toContain('title="Link after deploy"');
	});

	test("links unresolved post-payment recovery to the agents list", () => {
		expect(wizardSource).toContain("submitError.blocksRetry");
		expect(wizardSource).toContain("View agents");
		expect(wizardSource).toContain('router.navigate({ href: "/agents" })');
	});
});

describe("hosted agent security and copy", () => {
	test("renders runtime secrets through the shared masked token control", () => {
		expect(agentDetailSource).toContain(
			'<TokenReveal label="Password" value={credentials.value.password} />',
		);
		expect(agentDetailSource).toContain(
			'<TokenReveal label="Token" value={credentials.value.token} />',
		);
		expect(agentDetailSource).not.toContain("hermes-password-");
		expect(agentDetailSource).not.toContain("openclaw-token-");
	});

	test("keeps save actions stable and hides internal fallback ids", () => {
		expect(agentDetailSource).toContain("Save changes");
		expect(agentDetailSource).toContain('account?.name ?? "Unnamed channel"');
		expect(agentDetailSource).not.toContain('"No changes"');
		expect(agentDetailSource).not.toContain("This runtime is bound to");
	});

	test("uses product language for terminal startup and failures", () => {
		expect(agentDetailSource).toContain("Opening secure terminal");
		expect(agentDetailSource).toContain("Starting a secure shell for your agent.");
		expect(agentDetailSource).not.toContain("terminal websocket URL");
		expect(agentDetailSource).not.toContain("Opening deployment terminal");
		expect(terminalPanelSource).toContain("secure terminal could not be opened");
		expect(terminalPanelSource).not.toContain("terminal websocket could not be opened");
	});
});

describe("plan-change copy", () => {
	test("reviews price and timing without exposing server terminology", () => {
		expect(planChangeDialogSource).toContain("review the exact price and timing");
		expect(planChangeDialogSource).toContain("Listed recurring price {formatCents");
		expect(planChangeDialogSource).not.toContain("server quote");
	});
});

describe("first Basic agent copy", () => {
	test("describes the first Basic agent as free instead of included", () => {
		expect(wizardSource).toContain("First Basic agent — Free");
		expect(wizardSource).toContain('message: "Your first Basic agent is free.');
		expect(wizardSource).toContain('? "Free"');
		expect(wizardSource).not.toContain("included Basic slot");
		expect(wizardSource).not.toContain("included Basic deployment");
		expect(wizardSource).not.toContain("included slot");
		expect(planComparisonSource).toContain("The first active Basic agent is free.");
		expect(planComparisonSource).toContain("Your first active Basic agent is free.");
		expect(planComparisonSource).not.toContain("agent is included");
		expect(wizardSource).toContain("acceptedDeploymentNavigation(created.deploymentId)");
		expect(wizardSource).toContain("acceptedDeploymentNavigation(outcome.deploymentId)");
		expect(wizardSource).not.toContain("resolveWalletDeploymentId");
	});
});

describe("managed model picker", () => {
	test("uses real catalog items and exposes loading and retry states", () => {
		for (const source of [wizardSource, agentDetailSource]) {
			expect(source).toContain("<ModelBindingPicker");
			expect(source).not.toContain("__hosted_default__");
			expect(source).not.toContain("Hosted default (Luna)");
		}
		expect(modelBindingPickerSource).toContain("modelPickerItems(");
		expect(modelBindingPickerSource).toContain("Loading managed models…");
		expect(modelBindingPickerSource).toContain('title="Couldn\'t load managed models"');
	});
});

describe("billing-read gates", () => {
	test("keeps deploy disabled until inventory succeeds and offers retries", () => {
		expect(wizardSource).toContain("deployments.isSuccess &&");
		expect(wizardSource).toContain('title="Couldn\'t check deployment inventory"');
		expect(wizardSource).toContain("onRetry={() => void deployments.refetch()}");
		expect(wizardSource).toContain('title="Couldn\'t load compute plans"');
		expect(wizardSource).toContain('title="Couldn\'t load your Wallet balance"');
		expect(wizardSource).toContain("onRetry={() => void wallet.refetch()}");
	});
});

describe("deploy acceptance", () => {
	test("pauses quote reads, submits the last successful quote, and navigates on acceptance", () => {
		expect(wizardSource).toContain('enabled: paymentMethod === "wallet" && !submitting');
		expect(wizardSource).toContain(
			"const lastSuccessfulSubscriptionQuote = subscriptionCreateQuote.data ?? null;",
		);
		expect(wizardSource.match(/quote: lastSuccessfulSubscriptionQuote/g)).toHaveLength(3);
		expect(wizardSource).toContain(
			"submitting || lastSuccessfulSubscriptionQuote ? null : subscriptionCreateQuote.error;",
		);
		expect(wizardSource).not.toContain("await subscriptionCreateQuote.refetch()");
		expect(wizardSource).not.toContain("subscription-checkout-hosted-fallback");
		expect(wizardSource).toContain("fallbackUrl: checkoutRedirectUrl(result)");
		const onDeployStart = wizardSource.indexOf("async function onDeploy()");
		const walletBranch = wizardSource.slice(
			wizardSource.indexOf('if (paymentMethod === "wallet")', onDeployStart),
			wizardSource.indexOf("const checkoutFingerprint"),
		);
		expect(walletBranch).not.toContain("refreshCheckoutReturn");
		expect(walletBranch).not.toContain("recheckCanCreateCloudAgents");
		expect(wizardSource).toContain(
			"router.navigate(acceptedDeploymentNavigation(outcome.deploymentId))",
		);
	});

	test("shows a scoped honest busy state and keeps a persistent actionable failure", () => {
		expect(wizardSource).toContain("setSubmitBusyLabel(");
		expect(wizardSource).toContain('"Confirming payment & creating agent…"');
		expect(wizardSource).toContain('"Opening secure checkout…"');
		expect(wizardSource).toContain('"Creating agent…"');
		expect(wizardSource).toContain('<Spinner data-icon="inline-start" />');
		expect(wizardSource).toContain("{submitting ? submitBusyLabel : deployLabel}");
		expect(wizardSource).toContain('role="alert"');
		expect(wizardSource).toContain("Your choices are unchanged; review them and try again.");
		expect(wizardSource).not.toContain('submitting ? "Working…"');
	});
});
