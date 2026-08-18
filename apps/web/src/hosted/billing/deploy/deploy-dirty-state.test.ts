import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DEPLOY_AI_ACCESS_MODE,
	DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE,
	DEFAULT_DEPLOY_RUNTIME,
} from "@/hosted/billing/deploy/deploy-defaults";
import {
	type DeployWizardDirtyState,
	deployWizardDraftIsDirty,
} from "@/hosted/billing/deploy/deploy-dirty-state";
import { runtimeDisplayName } from "@/hosted/runtimes";

const baseline: DeployWizardDirtyState = {
	runtime: DEFAULT_DEPLOY_RUNTIME,
	agentName: runtimeDisplayName(DEFAULT_DEPLOY_RUNTIME),
	compute: "basic",
	language: "en",
	timezone: "America/Los_Angeles",
	term: 1,
	paymentMethod: "card",
	subscriptionSource: { mode: "new" },
	aiBindingDraft: {
		bindingMode: DEFAULT_DEPLOY_AI_ACCESS_MODE,
		primaryProviderChoice: DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE,
		primaryModel: "managed-default",
	},
	checkoutOpen: false,
};

describe("deploy wizard dirty state", () => {
	test("keeps browser, inventory, and managed-model hydration clean", () => {
		const beforeManagedModelEffect = {
			...baseline,
			aiBindingDraft: { ...baseline.aiBindingDraft, primaryModel: "" },
		};

		expect(deployWizardDraftIsDirty(beforeManagedModelEffect, baseline)).toBe(false);
		expect(deployWizardDraftIsDirty(baseline, baseline)).toBe(false);
	});

	test("blocks real edits until the deployment is committed", () => {
		const edited = {
			...baseline,
			language: "fr",
			aiBindingDraft: { ...baseline.aiBindingDraft, primaryModel: "another-model" },
		};

		expect(deployWizardDraftIsDirty(edited, baseline)).toBe(true);
		expect(deployWizardDraftIsDirty(edited, baseline, true)).toBe(false);
	});
});
