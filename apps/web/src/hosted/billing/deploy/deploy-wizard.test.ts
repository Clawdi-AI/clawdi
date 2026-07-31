import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateHostedDeployPersona } from "@clawdi/shared/api";
import { DEPLOY_ASSISTANT_NAME_MAX_LENGTH } from "@/hosted/billing/deploy/deploy-request";

const wizardSource = readFileSync(new URL("./deploy-wizard.tsx", import.meta.url), "utf8");
const acceptedNavigationSource = readFileSync(
	new URL("./accepted-deployment-navigation.ts", import.meta.url),
	"utf8",
);
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
const runtimesSource = readFileSync(new URL("../../runtimes.ts", import.meta.url), "utf8");
const addProviderDialogSource = readFileSync(
	new URL("../../v2/ai-providers/add-provider-dialog.tsx", import.meta.url),
	"utf8",
);
const addProviderDialogLogicSource = readFileSync(
	new URL("../../v2/ai-providers/add-provider-dialog.logic.ts", import.meta.url),
	"utf8",
);
const aiProviderHooksSource = readFileSync(
	new URL("../../v2/ai-providers/ai-providers-hooks.ts", import.meta.url),
	"utf8",
);

describe("deploy wizard personalization", () => {
	test("uses a stable dashboard name within the strictest backend limit", () => {
		expect(wizardSource).toContain('htmlFor="agent-name"');
		expect(wizardSource).toContain('<Label htmlFor="agent-name">Name in Clawdi</Label>');
		expect(wizardSource).toContain('id="agent-name"');
		expect(wizardSource).toContain("maxLength={DEPLOY_ASSISTANT_NAME_MAX_LENGTH}");
		expect(DEPLOY_ASSISTANT_NAME_MAX_LENGTH).toBe(64);
		expect(
			validateHostedDeployPersona({ assistantName: "", language: "en", timezone: "Etc/UTC" }),
		).toContainEqual({ field: "assistantName", message: "Enter a name for this agent." });
		expect(wizardSource).toContain("Used to identify this agent in Clawdi.");
		expect(wizardSource).toContain("runtimeDisplayName(DEFAULT_DEPLOY_RUNTIME)");
		expect(wizardSource).toContain("assistantNameEditedRef");
		expect(wizardSource).toContain("deployAssistantNameAfterRuntimeChange");
		expect(wizardSource).toContain("required");
		expect(wizardSource).toContain("aria-invalid={nameError ? true : undefined}");
		expect(wizardSource).toContain('"agent-name-error agent-name-count"');
		expect(wizardSource).toContain('"agent-name-help agent-name-count"');
		expect(wizardSource).toContain('id="agent-name-count"');
		expect(wizardSource).toContain("nameLimitReached");
		expect(wizardSource).toContain('className="sr-only" role="status" aria-live="polite"');
		expect(wizardSource).toContain('aria-live="polite"');
		expect(wizardSource).toContain('" — limit reached."');
		expect(wizardSource).toContain("Name limit reached. You can enter up to");
		expect(wizardSource).toContain('type="submit"');
		expect(wizardSource).toContain("submitBlockingReason");
	});
});

describe("deploy wizard product copy and flow", () => {
	test("uses customer language and keeps channels out of the decision flow", () => {
		expect(wizardSource).toContain('title="Agent software"');
		expect(wizardSource).toContain("<DeploySectionSkeleton columns={2} />");
		expect(wizardSource).toContain('description="Choose a compute plan and how paid plans renew."');
		expect(wizardSource).toContain("After your agent is running, connect channels from its page.");
		expect(wizardSource).not.toContain('title="Runtimes"');
		expect(wizardSource).not.toContain("execution engine");
		expect(wizardSource).not.toContain("per-deployment funding");
		expect(wizardSource).not.toContain("server quote");
		expect(wizardSource).not.toContain('title="Link after deploy"');
	});

	test("makes the recommended agent software choice answerable", () => {
		expect(wizardSource).toContain('<Badge variant="secondary">Recommended</Badge>');
		expect(wizardSource).not.toContain("Agent software can’t be changed later");
		expect(wizardSource).not.toContain("To switch after creation");
		expect(runtimesSource).toContain("Chat with and manage your agent in the Hermes Dashboard.");
		expect(runtimesSource).toContain("already use OpenClaw and want its Control UI and workflows.");
		expect(runtimesSource).not.toContain("Your own personal AI assistant.");
		expect(runtimesSource).not.toContain("The agent that grows with you.");
		expect(runtimesSource).not.toContain("DEFAULT_HOSTED_RUNTIME");
	});

	test("links unresolved post-payment recovery to the agents list", () => {
		expect(wizardSource).toContain('id: "deploy-post-payment-error"');
		expect(wizardSource).toContain("duration: Number.POSITIVE_INFINITY");
		expect(wizardSource).toContain("View agents");
		expect(wizardSource).toContain('router.navigate({ href: "/agents" })');
	});
});

describe("hosted agent security and copy", () => {
	test("shows the Hermes username and masks Hermes and OpenClaw secrets", () => {
		expect(agentDetailSource).toContain(
			'<RuntimeUiCredentialRow label="Username" value={credentials.username} />',
		);
		expect(agentDetailSource).toContain(
			'<RuntimeUiCredentialRow label="Password" value={credentials.password} secret />',
		);
		expect(agentDetailSource).toContain(
			'<RuntimeUiCredentialRow label="Token" value={credentials.token} secret />',
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
		expect(wizardSource).toContain("acceptDeployment(created.deploymentId)");
		expect(wizardSource).toContain("acceptDeployment(outcome.deploymentId)");
		expect(wizardSource).not.toContain("resolveWalletDeploymentId");
	});

	test("routes accepted creates directly by canonical deployment selector", () => {
		expect(acceptedNavigationSource).toContain(
			'agentSectionHref(deploymentId, "overview", "source=on-clawdi")',
		);
		expect(wizardSource).not.toContain("setup=accepted");
		expect(wizardSource).not.toContain("waitForRuntime");
		expect(wizardSource).not.toContain("getDeployment(created.deploymentId)");
		expect(wizardSource).not.toContain("Agent deployment started");
		expect(wizardSource).not.toContain("agent is getting ready now");
		expect(wizardSource).toContain('toast.success("Wallet payment confirmed"');
		expect(wizardSource).toContain("toast.dismiss(WALLET_PAYMENT_TOAST_ID)");
	});

	test("keeps infrastructure vocabulary out of customer copy", () => {
		expect(planComparisonSource).toContain("Always-on agent with TEE protection");
		expect(planComparisonSource).toContain("Public ports for agent services");
		expect(planComparisonSource).not.toContain("hosted runtime");
		expect(planComparisonSource).not.toContain("runtime-owned services");
		expect(addProviderDialogSource).toContain("Agent environment variable");
		expect(addProviderDialogSource).not.toContain("Runtime mapping");
		expect(addProviderDialogSource).not.toContain("Runtime env var");
		expect(addProviderDialogLogicSource).not.toContain("manifest secret");
		expect(addProviderDialogLogicSource).not.toContain("hosted runtime");
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

	test("does not blame the user while the Managed AI catalog is loading or unavailable", () => {
		expect(wizardSource).toContain('return "Loading Managed AI models."');
		expect(wizardSource).toContain('return "Retry loading Managed AI models above."');
		expect(wizardSource).toContain('return "Choose an available primary model."');
		expect(wizardSource.indexOf('return "Loading Managed AI models."')).toBeLessThan(
			wizardSource.indexOf('return "Choose an available primary model."'),
		);
	});
});

describe("deploy provider choice", () => {
	test("shows every provider choice in the expanded form", () => {
		expect(wizardSource).toContain(
			'description="Choose how your agent accesses AI models and select its primary model."',
		);
		expect(wizardSource).toContain('title="Add a provider"');
		expect(wizardSource).toContain('title={authCardLabel("unmanaged")}');
		expect(wizardSource).not.toContain("aiProviderEditorOpen");
		expect(wizardSource).not.toContain("aiProviderSummaryTitle");
		expect(wizardSource).not.toContain("Using Managed AI");
	});

	test("explains that the welcome balance is used before added Wallet funds", () => {
		expect(wizardSource).toContain(
			"Your welcome balance covers usage first; after that, it draws from your Wallet.",
		);
		expect(wizardSource).not.toContain("Managed-AI usage paid directly from your Wallet");
	});

	test("uses an exclusive provider selection and hides the redundant provider picker", () => {
		expect(wizardSource).toContain("selectProvider: selectAiProviderChoice");
		expect(wizardSource).toContain("selectAiProviderChoice(MANAGED_AI_CHOICE)");
		expect(wizardSource).toContain("selectAiProviderChoice(provider.provider_id)");
		expect(wizardSource).toContain("showProviderSelect={false}");
		expect(wizardSource).not.toContain("toggleAiProviderChoice");
		expect(wizardSource).not.toContain("selectedProviderCount");
		expect(wizardSource).not.toContain("aiProviderChoices.includes");
	});
});

describe("AI provider usability gate", () => {
	test("builds every deploy-provider choice from the usable subset", () => {
		expect(wizardSource).toContain("usableProviders(aiProviders.data ?? [])");
		expect(wizardSource).toContain("{providerList.map((provider) => (");
		expect(wizardSource).not.toContain("{aiProviders.data?.map((provider) => (");
	});
});

describe("billing-read gates", () => {
	test("keeps deploy disabled until inventory succeeds and offers retries", () => {
		expect(wizardSource).toContain("deployments.isSuccess &&");
		expect(wizardSource).toContain("activeIncludedBasicSlot === null");
		expect(wizardSource).toContain("Free Basic agent availability is unknown");
		expect(wizardSource).toContain("No free agent is assumed.");
		expect(wizardSource).toContain('title="Couldn\'t check existing agents"');
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
		expect(wizardSource).not.toContain("checkoutSessionId");
		expect(wizardSource).not.toContain("subscriptionHostedFallbackRequest");
		expect(wizardSource).toContain("cardCheckoutUiMode === CHECKOUT_ELEMENTS_UI_MODE &&");
		const onDeployStart = wizardSource.indexOf("async function onDeploy()");
		const walletBranch = wizardSource.slice(
			wizardSource.indexOf('if (paymentMethod === "wallet")', onDeployStart),
			wizardSource.indexOf("const checkoutFingerprint"),
		);
		expect(walletBranch).not.toContain("refreshCheckoutReturn");
		expect(walletBranch).not.toContain("recheckCanCreateCloudAgents");
		expect(wizardSource).toContain("acceptDeployment(outcome.deploymentId)");
	});

	test("funnels every accepted create and activation through the same immediate navigation", () => {
		for (const acceptedId of [
			"resolved.deploymentId",
			"deploymentId",
			"outcome.deploymentId",
			"created.deploymentId",
		]) {
			expect(wizardSource).toContain(`acceptDeployment(${acceptedId}`);
		}
		expect(wizardSource).toContain("navigateToAcceptedDeployment({");
		expect(wizardSource).not.toContain("setup=accepted");
	});

	test("shows a scoped honest busy state and reports failures only through actionable toasts", () => {
		expect(wizardSource).toContain("setSubmitBusyLabel(");
		expect(wizardSource).toContain('"Confirming payment & creating agent…"');
		expect(wizardSource).toContain('"Opening secure checkout…"');
		expect(wizardSource).toContain('"Creating agent…"');
		expect(wizardSource).toContain('<Spinner data-icon="inline-start" />');
		expect(wizardSource).toContain("{submitting ? submitBusyLabel : deployLabel}");
		expect(wizardSource).toContain('id: "deploy-submit-error"');
		expect(wizardSource).toContain('label: "Retry"');
		expect(wizardSource).toContain("deploySubmissionErrorPresentation(");
		expect(wizardSource).not.toContain('data-testid="deploy-submit-error"');
		expect(wizardSource).not.toContain("submitError");
		expect(wizardSource).not.toContain('toast.error("Couldn’t deploy"');
		expect(wizardSource).not.toContain('toast.error("Couldn’t create agent"');
		expect(wizardSource).not.toContain('submitting ? "Working…"');
	});

	test("keeps the reachable provider mutation busy state scoped and does not await refetch", () => {
		expect(addProviderDialogSource).toContain("const runAction = useActionLock()");
		expect(addProviderDialogSource).toContain("void runAction(submit)");
		expect(addProviderDialogSource).toContain('<Spinner data-icon="inline-start" />');
		expect(addProviderDialogSource).toContain('"Opening sign-in…"');
		expect(addProviderDialogSource).toContain('"Adding provider…"');
		expect(addProviderDialogSource).toContain('"Saving provider…"');
		expect(aiProviderHooksSource).toContain("void qc.invalidateQueries({ queryKey: KEY })");
	});
});
