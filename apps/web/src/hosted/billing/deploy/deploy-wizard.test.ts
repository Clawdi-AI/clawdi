import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateHostedDeployPersona } from "@clawdi/shared/api";
import { DEPLOY_AGENT_NAME_MAX_LENGTH } from "@/hosted/billing/deploy/deploy-request";

const wizardSource = readFileSync(new URL("./deploy-wizard.tsx", import.meta.url), "utf8");
const deployPageSource = readFileSync(
	new URL("../../../pages/dashboard/deploy/page.tsx", import.meta.url),
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
const entityCardSource = readFileSync(
	new URL("../../../components/entity-card.tsx", import.meta.url),
	"utf8",
);
const runtimesSource = readFileSync(new URL("../../runtimes.ts", import.meta.url), "utf8");
const addProviderDialogSource = readFileSync(
	new URL("../../v2/ai-providers/add-provider-dialog.tsx", import.meta.url),
	"utf8",
);
const providerFieldsFormSource = readFileSync(
	new URL("../../v2/ai-providers/provider-fields-form.tsx", import.meta.url),
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
	test("keeps deploy-specific controls proportionate to their content", () => {
		expect(modelBindingPickerSource).toContain('className="flex w-full min-w-0 flex-col gap-3"');
		expect(wizardSource).not.toContain("max-w-4xl rounded-none border-0");
		expect(wizardSource).toContain('<div className="flex max-w-2xl flex-col gap-4">');
		expect(wizardSource).toContain('className="flex w-full max-w-md flex-col gap-1.5"');
		expect(wizardSource).toContain('<Label htmlFor="agent-language">Language</Label>');
		expect(wizardSource).toContain('<Label htmlFor="agent-timezone">Timezone</Label>');
		expect(wizardSource).toContain('<SelectTrigger id="agent-language" type="button">');
		expect(wizardSource).toContain('className="flex w-full max-w-sm min-w-0 flex-col gap-1.5"');
		expect(wizardSource).toContain('className="flex max-w-xs flex-col gap-1.5"');
	});

	test("uses a stable dashboard name within the strictest backend limit", () => {
		expect(wizardSource).toContain('htmlFor="agent-name"');
		expect(wizardSource).toContain('<Label htmlFor="agent-name">Name in Clawdi</Label>');
		expect(wizardSource).toContain('id="agent-name"');
		expect(wizardSource).toContain("maxLength={DEPLOY_AGENT_NAME_MAX_LENGTH}");
		expect(DEPLOY_AGENT_NAME_MAX_LENGTH).toBe(64);
		expect(
			validateHostedDeployPersona({ agentName: "", language: "en", timezone: "Etc/UTC" }),
		).toContainEqual({ field: "agentName", message: "Enter a name for this agent." });
		expect(wizardSource).not.toContain("Used to identify this agent in Clawdi.");
		expect(wizardSource).toContain("runtimeDisplayName(DEFAULT_DEPLOY_RUNTIME)");
		expect(wizardSource).toContain("agentNameEditedRef");
		expect(wizardSource).toContain("deployAgentNameAfterRuntimeChange");
		expect(wizardSource).toContain("required");
		expect(wizardSource).toContain("aria-invalid={nameError ? true : undefined}");
		expect(wizardSource).toContain('"agent-name-error agent-name-count"');
		expect(wizardSource).not.toContain("agent-name-help");
		expect(wizardSource).toContain('id="agent-name-count"');
		expect(wizardSource).toContain("showNameCount");
		expect(wizardSource).toContain("nameLimitReached");
		expect(wizardSource).toContain('className="sr-only" role="status" aria-live="polite"');
		expect(wizardSource).toContain('aria-live="polite"');
		expect(wizardSource).toContain('" — limit reached."');
		expect(wizardSource).toContain("Name limit reached. You can enter up to");
		expect(wizardSource).toContain("submitBlockingReason");
	});
});

describe("deploy wizard responsive layout", () => {
	test("keeps the shared page width while sizing card grids from the main pane", () => {
		expect(wizardSource).toContain("CENTERED_PAGE_WIDTH_CLASS.page");
		expect(wizardSource).toContain(
			'<div className={ENTITY_CHOICE_GRID_CLASS} data-testid="provider-choice-grid">',
		);
		expect(agentDetailSource).toContain(
			'<div className={ENTITY_CHOICE_GRID_CLASS} data-testid="provider-choice-grid">',
		);
		expect(entityCardSource).toContain(
			'export const ENTITY_CHOICE_GRID_CLASS = "grid gap-2 @2xl/main:grid-cols-2";',
		);
		expect(entityCardSource).toContain("export function EntityAddCard(");
		expect(wizardSource).not.toContain("TWO_TILE_GRID_CLASS");
		expect(wizardSource).not.toContain("THREE_TILE_GRID_CLASS");
		expect(wizardSource).not.toContain("@5xl/main:grid-cols-3");
		expect(wizardSource).not.toContain('className="grid gap-2 sm:grid-cols-2"');
		expect(wizardSource).not.toContain("sm:flex-row sm:items-center sm:justify-between");
		expect(deployPageSource).toContain('className="grid gap-2 @2xl/main:grid-cols-2"');
	});

	test("keeps compute identity, resources, and recurring price in one compact hierarchy", () => {
		expect(wizardSource.match(/detailsPlacement="trailing"/g)).toHaveLength(2);
		expect(wizardSource.match(/className="items-center p-3"/g)).toHaveLength(2);
		expect(wizardSource).toContain('testId="basic-ram-resource"');
		expect(wizardSource).toContain('testId="performance-ram-resource"');
		expect(wizardSource).toContain("diskGb={basicPlan.disk_size}");
		expect(wizardSource).toContain("diskGb={perfPlan.disk_size}");
		expect(wizardSource).toContain("{diskGb} GB storage");
		expect(wizardSource).toContain("Basic plan unavailable");
		expect(wizardSource).not.toContain("basicPlan?.vcpu ?? 2");
		expect(wizardSource).not.toContain("basicPlan?.ram_gb ?? 4");
		expect(agentDetailSource.match(/storageGib=\{spec\.resources\.disk_gib\}/g)).toHaveLength(1);
		expect(wizardSource).toContain('className="whitespace-nowrap" data-testid={testId}');
		expect(wizardSource).toMatch(/data-testid=\{`\$\{testId\}-savings`\}/);
	});

	test("keeps the action bar sticky across the full form and adapts it to the main pane", () => {
		const formIndex = wizardSource.indexOf("<form");
		const agentSoftwareIndex = wizardSource.indexOf('title="Agent software"');
		const actionBarIndex = wizardSource.indexOf('data-testid="deploy-action-bar"');
		expect(formIndex).toBeGreaterThan(-1);
		expect(formIndex).toBeLessThan(agentSoftwareIndex);
		expect(actionBarIndex).toBeGreaterThan(wizardSource.indexOf('title="Personalize"'));
		expect(wizardSource).toContain("sticky bottom-0 z-10");
		expect(wizardSource).toContain("@2xl/main:flex-row");
		expect(wizardSource).toContain("@2xl/main:w-auto");
		expect(wizardSource).toContain("@2xl/main:w-56 @2xl/main:items-end");
		expect(wizardSource).toContain("@2xl/main:w-40 @2xl/main:items-end");
		expect(wizardSource).not.toContain("sm:sticky sm:bottom-0");
	});

	test("keeps concise funding copy", () => {
		expect(wizardSource).not.toContain("hidden @3xl/main:inline-flex");
		expect(wizardSource).toContain(
			'description="Recurring subscription via Stripe. Manage or cancel anytime."',
		);
		expect(wizardSource).toContain('<Badge variant="secondary">{selectedCardTrial.label}</Badge>');
		expect(wizardSource).toContain("Paid upfront from your Wallet balance. Renews from Wallet.");
	});

	test("summarizes runtime, AI selection, and compute without personalization", () => {
		const summarySource = wizardSource.slice(
			wizardSource.indexOf("const summaryLine"),
			wizardSource.indexOf("const plansLoadError"),
		);
		expect(summarySource.indexOf("runtimeSummary")).toBeLessThan(
			summarySource.indexOf("aiSummary"),
		);
		expect(summarySource.indexOf("aiSummary")).toBeLessThan(
			summarySource.indexOf("selectedComputeLabel"),
		);
		expect(summarySource).not.toContain("LANGUAGE_OPTIONS");
		expect(summarySource).not.toContain("timezone");
	});
});

describe("deploy wizard product copy and flow", () => {
	test("uses customer language and keeps channels out of the decision flow", () => {
		expect(wizardSource).toContain('title="Agent software"');
		expect(wizardSource).not.toContain(
			'description="Choose a compute plan and how paid plans renew."',
		);
		expect(wizardSource).not.toContain(
			"After your agent is running, connect channels from its page.",
		);
		expect(wizardSource).not.toContain("No AI provider will be selected for you.");
		expect(wizardSource).not.toContain('title="Runtimes"');
		expect(wizardSource).not.toContain("execution engine");
		expect(wizardSource).not.toContain("per-deployment funding");
		expect(wizardSource).not.toContain("server quote");
		expect(wizardSource).not.toContain('title="Link after deploy"');
	});

	test("makes the recommended agent software choice answerable", () => {
		expect(wizardSource.match(/<Badge variant="secondary">Recommended<\/Badge>/g)).toHaveLength(2);
		expect(wizardSource).not.toContain('<Badge variant="secondary">Default</Badge>');
		expect(wizardSource).not.toContain("Agent software can’t be changed later");
		expect(wizardSource).not.toContain("To switch after creation");
		expect(runtimesSource).toContain("Chat with and manage your agent in the Hermes Dashboard.");
		expect(runtimesSource).toContain("already use OpenClaw and want its Control UI and workflows.");
		expect(runtimesSource).not.toContain("Your own personal AI assistant.");
		expect(runtimesSource).not.toContain("The agent that grows with you.");
		expect(runtimesSource).not.toContain("DEFAULT_HOSTED_RUNTIME");
	});
});

describe("hosted agent security and copy", () => {
	test("shows and masks the Hermes credentials without exposing OpenClaw tokens", () => {
		expect(agentDetailSource).toContain(
			'<RuntimeUiCredentialRow label="Username" value={renderedCredentials.username} />',
		);
		expect(agentDetailSource).toContain("value={renderedCredentials.password}");
		expect(agentDetailSource).not.toContain('<RuntimeUiCredentialRow label="Token"');
		expect(agentDetailSource).not.toContain("hermes-password-");
		expect(agentDetailSource).not.toContain("openclaw-token-");
	});

	test("keeps save actions stable and hides internal fallback ids", () => {
		expect(agentDetailSource).toContain("Save changes");
		expect(agentDetailSource).toContain('account?.name ?? "Unnamed channel"');
		expect(agentDetailSource).not.toContain('"No changes"');
		expect(agentDetailSource).not.toContain("This runtime is bound to");
	});

	test("uses product language for terminal connection states and failures", () => {
		expect(agentDetailSource).toContain('reconnecting: "Reconnecting"');
		expect(agentDetailSource).toContain('disconnected: "Disconnected"');
		expect(agentDetailSource).not.toContain("terminal websocket URL");
		expect(agentDetailSource).not.toContain("Opening deployment terminal");
		expect(terminalPanelSource).toContain("Secure terminal could not be opened");
		expect(terminalPanelSource).toContain("Fresh terminal access could not be requested");
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
	test("keeps obsolete free-slot implementation copy out of the wizard", () => {
		expect(wizardSource).not.toContain("Your first Basic agent is free.");
		expect(wizardSource).not.toContain("included Basic slot");
		expect(wizardSource).not.toContain("included Basic deployment");
		expect(wizardSource).not.toContain("included slot");
		expect(wizardSource).not.toContain("resolveWalletDeploymentId");
		expect(agentDetailSource).not.toContain("falls back to free compute");
	});

	test("keeps post-acceptance waiting out of the customer flow", () => {
		expect(wizardSource).not.toContain("setup=accepted");
		expect(wizardSource).not.toContain("waitForRuntime");
		expect(wizardSource).not.toContain("Agent deployment started");
		expect(wizardSource).not.toContain("agent is getting ready now");
		expect(wizardSource).not.toContain("Wallet payment confirmed");
	});

	test("keeps infrastructure vocabulary out of customer copy", () => {
		expect(providerFieldsFormSource).toContain("Agent environment variable");
		expect(providerFieldsFormSource).not.toContain("Runtime mapping");
		expect(providerFieldsFormSource).not.toContain("Runtime env var");
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
		expect(modelBindingPickerSource).toContain("isManaged && hasCatalogModels");
		expect(wizardSource).not.toContain("compactManagedModelChoices");
		expect(agentDetailSource).not.toContain("compactManagedModelChoices");
		expect(modelBindingPickerSource).toContain("compactManagedItems.featured.map((item) =>");
		expect(modelBindingPickerSource).toContain("compactManagedItems.overflow.map((item) =>");
		expect(modelBindingPickerSource).toContain("<EntityChoiceCard");
		expect(modelBindingPickerSource).not.toContain("entityChoiceCardClass");
		expect(modelBindingPickerSource).not.toContain("<RadioGroup");
		expect(modelBindingPickerSource).not.toContain("<Check");
		expect(modelBindingPickerSource).toContain('data-testid="managed-model-overflow"');
		expect(modelBindingPickerSource).toContain('placeholder="More models"');
		expect(modelBindingPickerSource).toContain("aria-labelledby=");
		expect(modelBindingPickerSource).toContain("<Label id=");
		expect(modelBindingPickerSource).toContain(">Main model</Label>");
		expect(modelBindingPickerSource).toContain("<Label htmlFor={modelInputId}>Main model</Label>");
		expect(modelBindingPickerSource).toContain("list={hasCatalogModels ? modelListId : undefined}");
		expect(modelBindingPickerSource).toContain("<datalist id={modelListId}>");
		expect(modelBindingPickerSource).toContain("{item.description}");
		expect(modelBindingPickerSource).not.toContain("ManagedModelDetails");
		expect(modelBindingPickerSource).not.toContain("managed-model-capabilities");
		expect(modelBindingPickerSource).not.toContain("managed-model-cost-hint");
		expect(modelBindingPickerSource).not.toContain("Primary model");
		expect(modelBindingPickerSource).not.toContain("Catalog model");
		expect(modelBindingPickerSource).toContain('className="flex w-full min-w-0 flex-col gap-3"');
		expect(modelBindingPickerSource).toContain("@md/main:grid-cols-2 @4xl/main:grid-cols-4");
		expect(modelBindingPickerSource).not.toContain("max-w-2xl");
		expect(modelBindingPickerSource).not.toContain("bg-muted/20");
		expect(modelBindingPickerSource).not.toContain("Primary provider");
		expect(modelBindingPickerSource).not.toContain("showProviderSelect");
		expect(modelBindingPickerSource).toContain("Loading Clawdi AI models…");
		expect(modelBindingPickerSource).toContain('title="Couldn\'t load Clawdi AI models"');
	});

	test("does not blame the user while the Clawdi AI catalog is loading or unavailable", () => {
		expect(wizardSource).toContain('return "Loading Clawdi AI models."');
		expect(wizardSource).toContain('return "Retry loading Clawdi AI models above."');
		expect(wizardSource).toContain('return "Choose an available primary model."');
		expect(wizardSource.indexOf('return "Loading Clawdi AI models."')).toBeLessThan(
			wizardSource.indexOf('return "Choose an available primary model."'),
		);
	});
});

describe("deploy provider choice", () => {
	test("shows every provider choice in the expanded form", () => {
		expect(wizardSource).toContain('<SettingsSection title="AI providers">');
		expect(wizardSource).not.toContain(
			'description="Choose how your agent accesses AI models and select its primary model."',
		);
		expect(wizardSource).toContain('title="Add a provider"');
		expect(wizardSource).toContain('title={authCardLabel("unmanaged")}');
		expect(wizardSource).not.toContain("aiProviderEditorOpen");
		expect(wizardSource).not.toContain("aiProviderSummaryTitle");
		expect(wizardSource).not.toContain("Using Clawdi AI");
	});

	test("puts Clawdi AI before configuring AI inside the agent", () => {
		expect(wizardSource.indexOf("selected={managedProviderSelected}")).toBeLessThan(
			wizardSource.indexOf('selected={aiAccessMode === "unmanaged"}'),
		);
	});

	test("contrasts Clawdi AI with provider setup without implying free usage", () => {
		expect(wizardSource).toContain("No setup required. Usage draws from your Wallet.");
		expect(wizardSource).not.toContain(
			"Your welcome balance covers usage first; after that, it draws from your Wallet.",
		);
	});

	test("uses provider cards as the only exclusive provider selection", () => {
		expect(wizardSource).toContain("selectProvider: selectAiProviderChoice");
		expect(wizardSource).toContain("selectAiProviderChoice(MANAGED_AI_CHOICE)");
		expect(wizardSource).toContain("selectAiProviderChoice(provider.provider_id)");
		expect(wizardSource).not.toContain("showProviderSelect");
		expect(wizardSource).not.toContain("onPrimaryProviderChange");
		expect(wizardSource).not.toContain(">Selected</Badge>");
		expect(agentDetailSource).not.toContain(">Selected</Badge>");
		expect(agentDetailSource).not.toContain(">Current</Badge>");
		expect(agentDetailSource).not.toContain(">In use</Badge>");
	});
});

describe("AI provider usability gate", () => {
	test("keeps local-only providers out and disables runtime-incompatible choices", () => {
		expect(wizardSource).toContain("usableProviders(aiProviders.data ?? [])");
		expect(wizardSource).toContain("usableProviders(savedProviderList, availabilityContext)");
		expect(wizardSource).toContain("{savedProviderList.map((provider) => {");
		expect(wizardSource).toContain("providerAvailabilityIssue(provider, availabilityContext)");
		expect(wizardSource).toContain("disabled={Boolean(issue)}");
		expect(wizardSource).not.toContain("{aiProviders.data?.map((provider) => (");
	});
});

describe("billing-read gates", () => {
	test("keeps deploy disabled until inventory resolves and offers scoped retries", () => {
		expect(wizardSource).toContain("useIncludedBasicAvailability()");
		expect(wizardSource).toContain(
			"shouldBlockQueryError(includedBasic.error, includedBasic.data)",
		);
		expect(wizardSource).toContain("includedBasic.data.available_slots > 0");
		expect(wizardSource).toContain('title="Couldn\'t check included Basic availability"');
		expect(wizardSource).toContain("onRetry={() => void includedBasic.refetch()}");
		expect(wizardSource).not.toContain("usesActiveIncludedBasicSlot");
		expect(wizardSource).toContain('title="Couldn\'t load compute plans"');
		expect(wizardSource).toContain("async function retryWalletQuote()");
		expect(wizardSource).toContain('toast.error("Couldn’t refresh Wallet quote"');
		expect(wizardSource).toContain("onClick={() => void retryWalletQuote()}");
	});
});

describe("deploy acceptance", () => {
	test("pauses quote reads, submits the last successful quote, and navigates on acceptance", () => {
		expect(wizardSource).toContain(
			'enabled: subscriptionSource?.mode === "new" && paymentMethod === "wallet" && !submitting',
		);
		expect(wizardSource).toContain(
			"const lastSuccessfulSubscriptionQuote = subscriptionCreateQuote.data ?? null;",
		);
		expect(wizardSource).toContain(
			"submitting || lastSuccessfulSubscriptionQuote ? null : subscriptionCreateQuote.error;",
		);
		const onDeploySource = wizardSource.slice(
			wizardSource.indexOf("async function onDeploy()"),
			wizardSource.indexOf("const deployLabel"),
		);
		expect(onDeploySource).not.toContain("await subscriptionCreateQuote.refetch()");
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
	});

	test("keeps submit progress inside the action and reports failures through actionable toasts", () => {
		expect(wizardSource).toContain('"Deploying…"');
		expect(wizardSource).not.toContain("Loading agent details");
		expect(wizardSource).not.toContain('"Payment is processing."');
		expect(wizardSource).not.toContain('"Waiting for your agent."');
		expect(wizardSource).not.toContain("Keep this page open");
		expect(wizardSource).not.toContain("Payment and agent creation are still being confirmed.");
		expect(wizardSource).toContain('<Spinner data-icon="inline-start" />');
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
		expect(addProviderDialogSource).toContain('"Saving settings…"');
		expect(aiProviderHooksSource).toContain("void qc.invalidateQueries({ queryKey: KEY })");
	});
});
