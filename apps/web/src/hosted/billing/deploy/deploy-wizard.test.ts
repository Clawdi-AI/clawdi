import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEPLOY_ASSISTANT_NAME_MAX_LENGTH } from "@/hosted/billing/deploy/deploy-request";

const wizardSource = readFileSync(new URL("./deploy-wizard.tsx", import.meta.url), "utf8");
const planComparisonSource = readFileSync(
	new URL("../subscription/plan-comparison.tsx", import.meta.url),
	"utf8",
);
const agentDetailSource = readFileSync(
	new URL("../../agents/hosted-agent-detail.tsx", import.meta.url),
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
		expect(wizardSource).toContain("After your agent is ready, connect channels from its page.");
		expect(wizardSource).not.toContain('title="Runtimes"');
		expect(wizardSource).not.toContain("execution engine");
		expect(wizardSource).not.toContain('title="Link after deploy"');
	});

	test("links checkout fallback recovery to the agents list", () => {
		expect(wizardSource).toContain('label: "View agents"');
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
