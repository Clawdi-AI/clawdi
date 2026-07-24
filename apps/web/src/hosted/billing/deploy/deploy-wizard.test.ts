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
		expect(wizardSource).toContain('id="agent-name"');
		expect(wizardSource).toContain("maxLength={DEPLOY_ASSISTANT_NAME_MAX_LENGTH}");
		expect(DEPLOY_ASSISTANT_NAME_MAX_LENGTH).toBe(255);
		expect(wizardSource).toContain("required");
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
		expect(wizardSource).toContain('title="Couldn\'t load your AI Credits wallet"');
		expect(wizardSource).toContain("onRetry={() => void wallet.refetch()}");
	});
});
