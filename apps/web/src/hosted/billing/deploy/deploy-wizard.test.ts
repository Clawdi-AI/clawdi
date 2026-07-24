import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEPLOY_ASSISTANT_NAME_MAX_LENGTH } from "@/hosted/billing/deploy/deploy-request";

const wizardSource = readFileSync(new URL("./deploy-wizard.tsx", import.meta.url), "utf8");
const planComparisonSource = readFileSync(
	new URL("../subscription/plan-comparison.tsx", import.meta.url),
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
	});
});
