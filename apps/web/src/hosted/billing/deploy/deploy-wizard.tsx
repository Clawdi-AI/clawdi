"use client";

import { validateHostedDeployPersona } from "@clawdi/shared/api";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
	Cpu,
	CreditCard,
	Plus,
	RefreshCw,
	Rocket,
	Settings2,
	TriangleAlert,
	WalletCards,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type ApiErrorNormalizer, ApiErrorPanel } from "@/components/api-error-panel";
import { EntityChoiceCard } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SettingsSection } from "@/components/settings-section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useBillingClient } from "@/hosted/billing/billing-client";
import { useCheckoutReturnHandler } from "@/hosted/billing/checkout-return";
import {
	CHECKOUT_ELEMENTS_UI_MODE,
	checkoutRedirectUrl,
	checkoutSessionClientSecret,
	checkoutUiModeForPublishableKey,
	findNewDeploymentId,
} from "@/hosted/billing/components/stripe-checkout.logic";
import {
	StripeCheckoutDialog,
	type StripeCheckoutSummary,
} from "@/hosted/billing/components/stripe-checkout-dialog";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import type {
	BillingOffer,
	ComputePlanSlug,
	DeployRequest,
	Plan,
} from "@/hosted/billing/contracts";
import { navigateToAcceptedDeployment } from "@/hosted/billing/deploy/accepted-deployment-navigation";
import {
	DEFAULT_DEPLOY_AI_ACCESS_MODE,
	DEFAULT_DEPLOY_AI_PROVIDER_CHOICES,
	DEFAULT_DEPLOY_PRIMARY_MODEL,
	DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE,
	DEFAULT_DEPLOY_RUNTIME,
	deployAssistantNameAfterRuntimeChange,
} from "@/hosted/billing/deploy/deploy-defaults";
import {
	resolveBasicDeploySelection,
	usesActiveIncludedBasicSlot,
} from "@/hosted/billing/deploy/deploy-model";
import {
	type ComputePricePresentation,
	cardDeployAmountPresentation,
	computePricePresentation,
	walletDeployAmountPresentation,
} from "@/hosted/billing/deploy/deploy-price-presentation";
import {
	buildHostedDeployRequest,
	DEPLOY_ASSISTANT_NAME_MAX_LENGTH,
	type DeployAiFields,
} from "@/hosted/billing/deploy/deploy-request";
import {
	browserLanguage,
	browserTimezone,
	fallbackTimezones,
	LANGUAGE_OPTIONS,
	LANGUAGE_SELECT_ITEMS,
	mergeTimezoneOptions,
	supportedTimezones,
	TimezoneCombobox,
} from "@/hosted/billing/deploy/language-timezone-controls";
import {
	billingErrorNormalizer,
	DeploymentRequestTerminalError,
	deploySubmissionErrorPresentation,
	isIdempotencyKeyReusedError,
	normalizeBillingError,
} from "@/hosted/billing/errors";
import { billingTermLabel, formatCents, formatUsdExact } from "@/hosted/billing/format";
import {
	useCheckoutReturnRefresh,
	useHostedDeployments,
	useManagedModelCatalog,
	usePlans,
	useResolveDeploymentRequest,
	useSubscriptionCreateQuote,
} from "@/hosted/billing/hooks";
import {
	forgetIdempotencyAttempt,
	type IdempotencyAttempt,
	idempotencyAttemptFor,
	idempotencyFingerprint,
	newIdempotencyKey,
} from "@/hosted/billing/idempotency";
import { useSensitiveCreateSubscription } from "@/hosted/billing/sensitive-actions";
import type { CheckoutSessionClientSecret } from "@/hosted/billing/stripe-client-secret";
import {
	type SubscriptionCreateRequestView,
	type SubscriptionCreateSelection,
	supportedBillingTerm,
} from "@/hosted/billing/subscription/subscription-create-adapter";
import {
	COMPUTE_BASIC_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	explicitPlanOffers,
	planOffers,
	resolveBasicPlan,
	resolvePerformancePlan,
	selectExplicitOfferForTerm,
	selectOfferForTerm,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { TopUpDialog } from "@/hosted/billing/wallet/top-up-dialog";
import { walletDebitShortfallUsd } from "@/hosted/billing/wallet/wallet-debit-summary";
import {
	SUBSCRIPTION_WALLET_FUNDING_ERROR_COPY,
	useWalletTopUpDialog,
} from "@/hosted/billing/wallet/wallet-funding";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import { type HostedRuntime, runtimeBlurb, runtimeDisplayName } from "@/hosted/runtimes";
import { AddProviderDialog } from "@/hosted/v2/ai-providers/add-provider-dialog";
import {
	aiBindingBuildErrorCopy,
	buildAiBindingFields,
} from "@/hosted/v2/ai-providers/ai-provider-binding";
import { useUserAiProviders } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { AuthBadge, ProviderIcon } from "@/hosted/v2/ai-providers/ai-providers-ui";
import { authCardLabel } from "@/hosted/v2/ai-providers/auth-card-label";
import {
	MANAGED_AI_CHOICE,
	MANAGED_PROVIDER_ID,
	MANAGED_PROVIDER_LABEL,
	modelDisplayName,
	modelOptionsForProvider,
	providerAvailabilityIssue,
	providerCatalogDescription,
	providerDisplayLabel,
	usableProviders,
} from "@/hosted/v2/ai-providers/model-binding";
import { ModelBindingPicker } from "@/hosted/v2/ai-providers/model-binding-picker";
import { useAiProviderBindingDraft } from "@/hosted/v2/ai-providers/use-ai-provider-binding-draft";
import { isApiAuthError, normalizeApiError } from "@/lib/api-errors";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";

type Compute = "basic" | "performance";
type DeployPaymentMethod = "card" | "wallet";
type NativeDeployCheckout = {
	clientSecret: CheckoutSessionClientSecret;
	previousDeploymentIds: string[];
	request: SubscriptionCreateRequestView;
	summary: StripeCheckoutSummary;
	tierLabel: "Basic" | "Performance";
};
type PaidDeploySelection = {
	billingTermMonths: number;
	computePlanSlug: ComputePlanSlug;
	offer: BillingOffer;
	plan: Plan;
	tierLabel: "Basic" | "Performance";
};
const DEPLOY_PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6");
const TWO_TILE_GRID_CLASS = "grid gap-2 @2xl/main:grid-cols-2";
const WALLET_PAYMENT_TOAST_ID = "agent-create-wallet-payment";
const WALLET_PAYMENT_TOAST_DURATION_MS = 8_000;

function showWalletPaymentConfirmation(amount: string) {
	toast.success("Wallet payment confirmed", {
		id: WALLET_PAYMENT_TOAST_ID,
		description: `${amount} was paid from Wallet.`,
		duration: Number.POSITIVE_INFINITY,
	});
	globalThis.setTimeout(
		() => toast.dismiss(WALLET_PAYMENT_TOAST_ID),
		WALLET_PAYMENT_TOAST_DURATION_MS,
	);
}

const aiProviderErrorNormalizer: ApiErrorNormalizer = {
	isAuthError: isApiAuthError,
	normalizeError: (error) => `${normalizeApiError(error)} Clawdi AI still works.`,
};

function AddTile({
	title,
	description,
	onClick,
}: {
	title: string;
	description: string;
	onClick: () => void;
}) {
	return (
		<EntityChoiceCard
			selected={false}
			onClick={onClick}
			icon={
				<IconChip tint="bg-muted text-muted-foreground">
					<Plus />
				</IconChip>
			}
			title={title}
			description={description}
			className="h-full border-dashed bg-card"
		/>
	);
}

function computeCheckoutSummary({
	offer,
	plan,
	termMonths,
	tierLabel,
}: {
	offer: BillingOffer;
	plan: Plan;
	termMonths: number;
	tierLabel: "Basic" | "Performance";
}): StripeCheckoutSummary {
	const effectiveMonthly = formatCents(offer.effective_monthly_price_cents);
	const agentLabel =
		tierLabel === "Basic" ? "additional hosted Basic agent" : "hosted Performance agent";
	return {
		detail:
			termMonths === 1
				? `Per ${agentLabel}, billed monthly.`
				: `${effectiveMonthly}/mo effective per ${agentLabel}.`,
		planName: plan.name,
		priceLabel: formatCents(offer.price_cents),
		termLabel: billingTermLabel(termMonths),
	};
}

function ComputePriceBlock({
	presentation,
	testId,
}: {
	presentation: ComputePricePresentation;
	testId: string;
}) {
	return (
		<div data-testid={testId} className="flex min-w-0 flex-col items-end text-right tabular-nums">
			<div className="flex items-baseline justify-end leading-5">
				<span className="whitespace-nowrap text-sm font-semibold text-foreground">
					{presentation.primary}
				</span>
			</div>
			<div className="text-xs leading-4 font-normal text-muted-foreground">
				{presentation.secondary}
				{presentation.savings ? (
					<>
						{" "}
						<span className="whitespace-nowrap" data-testid={`${testId}-savings`}>
							· {presentation.savings}
						</span>
					</>
				) : null}
			</div>
		</div>
	);
}

function ComputeResources({
	testId,
	vcpu,
	ramGb,
}: {
	testId: string;
	vcpu: number;
	ramGb: number;
}) {
	return (
		<span className="text-xs">
			<span className="whitespace-nowrap">{vcpu} vCPU</span>
			{" · "}
			<span className="whitespace-nowrap" data-testid={testId}>
				{ramGb} GB RAM
			</span>
		</span>
	);
}

function DeploySectionSkeleton() {
	return (
		<section className="flex flex-col gap-4">
			<Separator />
			<div className="flex max-w-2xl flex-col gap-2">
				<Skeleton className="h-4 w-24" />
				<Skeleton className="h-3.5 w-80 max-w-full" />
				<Skeleton className="h-3.5 w-56 max-w-full" />
			</div>
			<div className={TWO_TILE_GRID_CLASS}>
				{Array.from({ length: 2 }).map((_, index) => (
					<Skeleton key={index} className="h-[86px] w-full rounded-lg" />
				))}
			</div>
		</section>
	);
}

export function DeployWizard() {
	const router = useRouter();
	const queryClient = useQueryClient();
	const acceptDeployment = useCallback(
		(deploymentId: string, replace = false): void => {
			navigateToAcceptedDeployment({
				deploymentId,
				navigate: (options) => void router.navigate(options),
				queryClient,
				replace,
			});
		},
		[queryClient, router],
	);
	const navigateCheckoutReturn = useCallback(
		(deploymentId: string): undefined => {
			acceptDeployment(deploymentId, true);
		},
		[acceptDeployment],
	);
	useCheckoutReturnHandler({
		onCancelCopy: "You were not charged. Your agent was not deployed.",
		onNavigate: navigateCheckoutReturn,
	});
	const plans = usePlans();
	const deployments = useHostedDeployments();
	const managedModelCatalog = useManagedModelCatalog();
	const aiProviders = useUserAiProviders();
	const createSubscription = useSensitiveCreateSubscription();
	const billingClient = useBillingClient();
	const resolveDeploymentRequest = useResolveDeploymentRequest();
	const refreshCheckoutReturn = useCheckoutReturnRefresh();
	const runAction = useActionLock();
	const checkoutAttemptRef = useRef<IdempotencyAttempt | null>(null);
	const walletCreateAttemptRef = useRef<IdempotencyAttempt | null>(null);
	const includedCreateAttemptRef = useRef<IdempotencyAttempt | null>(null);
	const assistantNameEditedRef = useRef(false);
	const [runtime, setRuntime] = useState(DEFAULT_DEPLOY_RUNTIME);
	const [assistantName, setAssistantName] = useState(() =>
		runtimeDisplayName(DEFAULT_DEPLOY_RUNTIME),
	);
	const [compute, setCompute] = useState<Compute>("basic");
	const [language, setLanguage] = useState("");
	const [timezone, setTimezone] = useState("");
	const [timezoneOptions, setTimezoneOptions] = useState(fallbackTimezones);
	const [addProviderOpen, setAddProviderOpen] = useState(false);
	const [checkoutSession, setCheckoutSession] = useState<NativeDeployCheckout | null>(null);
	const [term, setTerm] = useState(1);
	const [submitting, setSubmitting] = useState(false);
	const [postPaymentBlocked, setPostPaymentBlocked] = useState(false);
	const [submitTakingLong, setSubmitTakingLong] = useState(false);
	const [submitBusyLabel, setSubmitBusyLabel] = useState("Creating agent…");
	const [submitTakingLongCopy, setSubmitTakingLongCopy] = useState(
		"Agent creation is still starting. Keep this page open; we’ll take you to your agent as soon as its page is available.",
	);
	const [paymentMethod, setPaymentMethod] = useState<DeployPaymentMethod>("card");
	const walletTopUp = useWalletTopUpDialog(SUBSCRIPTION_WALLET_FUNDING_ERROR_COPY);

	// Keep the first client render on the same deterministic fallback as SSR,
	// then adopt runtime IANA data and best-effort browser defaults after mount.
	useEffect(() => {
		const browserTimezoneValue = browserTimezone();
		setTimezone((current) => current || browserTimezoneValue);
		setTimezoneOptions(supportedTimezones(browserTimezoneValue ? [browserTimezoneValue] : []));
		setLanguage((lang) => lang || browserLanguage());
	}, []);
	useEffect(() => {
		if (!submitting) return;
		const timeout = window.setTimeout(() => setSubmitTakingLong(true), 5_000);
		return () => window.clearTimeout(timeout);
	}, [submitting]);
	const tzOptions = useMemo(() => {
		return mergeTimezoneOptions(timezoneOptions, timezone ? [timezone] : []);
	}, [timezone, timezoneOptions]);

	const basicPlan = resolveBasicPlan(plans.data);
	const perfPlan = resolvePerformancePlan(plans.data);
	const basicOfferSelection = useMemo(
		() => (basicPlan ? selectExplicitOfferForTerm(basicPlan, term) : null),
		[basicPlan, term],
	);
	const activeIncludedBasicSlot = useMemo(
		() => (deployments.isSuccess ? usesActiveIncludedBasicSlot(deployments.data) : null),
		[deployments.data, deployments.isSuccess],
	);
	const basicSelection = useMemo(
		() =>
			resolveBasicDeploySelection({
				basicPlan,
				billingTermMonths: term,
				includedSlotAvailable: activeIncludedBasicSlot === null ? null : !activeIncludedBasicSlot,
			}),
		[activeIncludedBasicSlot, basicPlan, term],
	);
	const perfOfferSelection = useMemo(
		() => (perfPlan ? selectOfferForTerm(perfPlan, term) : null),
		[perfPlan, term],
	);
	const perfOffer = perfOfferSelection?.offer ?? null;
	const basicOffer = basicOfferSelection?.offer ?? null;
	const basicBillingTermMonths = basicOfferSelection?.billingTermMonths ?? term;
	const perfBillingTermMonths = perfOfferSelection?.billingTermMonths ?? term;
	const basicOffers = basicPlan ? explicitPlanOffers(basicPlan) : [];
	const perfOffers = perfPlan ? planOffers(perfPlan) : [];
	const basicPricePresentation = basicOffer
		? computePricePresentation(basicOffer, basicOffers)
		: null;
	const perfPricePresentation = perfOffer ? computePricePresentation(perfOffer, perfOffers) : null;
	const paidSelection: PaidDeploySelection | null = !deployments.isSuccess
		? null
		: compute === "performance" && perfPlan && perfOfferSelection
			? {
					billingTermMonths: perfOfferSelection.billingTermMonths,
					computePlanSlug: COMPUTE_PERFORMANCE_SLUG,
					offer: perfOfferSelection.offer,
					plan: perfPlan,
					tierLabel: "Performance",
				}
			: compute === "basic" && basicSelection.mode === "checkout"
				? {
						billingTermMonths: basicSelection.billingTermMonths,
						computePlanSlug: COMPUTE_BASIC_SLUG,
						offer: basicSelection.offer,
						plan: basicSelection.plan,
						tierLabel: "Basic",
					}
				: null;
	const walletBillingTerm = supportedBillingTerm(paidSelection?.billingTermMonths ?? 1);
	const walletDisabledReason = walletBillingTerm
		? null
		: "Wallet subscriptions support Monthly and Annual billing.";
	const subscriptionCreateSelection: SubscriptionCreateSelection | null =
		paidSelection && walletBillingTerm
			? {
					planSlug: paidSelection.computePlanSlug,
					billingTermMonths: walletBillingTerm,
					fundingSource: paymentMethod === "wallet" ? "wallet" : "stripe",
				}
			: null;
	const wallet = useWalletSnapshot({
		enabled: paymentMethod === "wallet",
	});
	const subscriptionCreateQuote = useSubscriptionCreateQuote(subscriptionCreateSelection, {
		enabled: paymentMethod === "wallet" && !submitting,
	});
	const lastSuccessfulSubscriptionQuote = subscriptionCreateQuote.data ?? null;
	const visibleSubscriptionQuoteError =
		submitting || lastSuccessfulSubscriptionQuote ? null : subscriptionCreateQuote.error;
	const visibleSubscriptionQuoteFetching = !submitting && subscriptionCreateQuote.isFetching;
	const walletDebit = lastSuccessfulSubscriptionQuote?.walletDebit ?? null;
	const walletShortfallUsd = walletDebitShortfallUsd(walletDebit);
	const walletInsufficient = walletShortfallUsd !== null;
	const walletQuoteState =
		(!wallet.data && wallet.error) || visibleSubscriptionQuoteError
			? "error"
			: walletDebit
				? "ready"
				: "loading";
	const basicUnavailable = basicSelection.mode === "unavailable";

	const savedProviderList = usableProviders(aiProviders.data ?? []);
	const availabilityContext = { runtime, environmentId: null };
	const providerList = usableProviders(savedProviderList, availabilityContext);
	const managedModels = managedModelCatalog.data?.models ?? [];
	const {
		draft: aiBindingDraft,
		managedPrimaryModelReady,
		selectedProviderChoices,
		selectCreatedProvider: selectCreatedAiProvider,
		selectProvider: selectAiProviderChoice,
		setBindingMode: setAiAccessMode,
		setPrimaryModel,
	} = useAiProviderBindingDraft({
		initialDraft: {
			bindingMode: DEFAULT_DEPLOY_AI_ACCESS_MODE,
			providerChoices: [...DEFAULT_DEPLOY_AI_PROVIDER_CHOICES],
			primaryProviderChoice: DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE,
			primaryModel: DEFAULT_DEPLOY_PRIMARY_MODEL,
		},
		managedCatalogReady: managedModelCatalog.isSuccess,
		managedModels,
		operationMode: "create",
		providerCatalog: {
			dataUpdatedAt: aiProviders.dataUpdatedAt,
			isFetching: aiProviders.isFetching,
			isSuccess: aiProviders.isSuccess,
		},
		providers: providerList,
	});
	const { bindingMode: aiAccessMode, primaryModel, primaryProviderChoice } = aiBindingDraft;
	const managedProviderSelected =
		aiAccessMode === "configured" && primaryProviderChoice === MANAGED_AI_CHOICE;
	const managedModelsNeedRetry =
		managedProviderSelected &&
		managedModels.length === 0 &&
		(Boolean(managedModelCatalog.error) || managedModelCatalog.isSuccess);
	const managedModelsLoading =
		managedProviderSelected && managedModels.length === 0 && !managedModelsNeedRetry;
	const computePlanReady =
		compute === "performance" ? !!perfPlan && !!perfOfferSelection : !basicUnavailable;
	const trimmedAssistantName = assistantName.trim();
	const nameLimitReached = assistantName.length >= DEPLOY_ASSISTANT_NAME_MAX_LENGTH;
	const showNameCount = assistantName.length >= DEPLOY_ASSISTANT_NAME_MAX_LENGTH - 10;
	const personaIssues = validateHostedDeployPersona({
		assistantName: trimmedAssistantName,
		language,
		timezone,
	});
	const nameError = personaIssues.find((issue) => issue.field === "assistantName")?.message ?? null;
	const personaError = personaIssues[0]?.message ?? null;
	const nameDescriptionIds = nameError
		? showNameCount
			? "agent-name-error agent-name-count"
			: "agent-name-error"
		: showNameCount
			? "agent-name-count"
			: undefined;
	const submitBlockingReason = (() => {
		if (submitting) return null;
		if (personaError) return personaError;
		if (!plans.isSuccess) return "Waiting for compute plans.";
		if (!deployments.isSuccess) {
			return deployments.error
				? "Retry the agent availability check above."
				: "Checking your free Basic agent availability.";
		}
		if (!computePlanReady) return "Choose an available compute plan.";
		if (!managedPrimaryModelReady) {
			if (managedModelsNeedRetry) return "Retry loading Clawdi AI models above.";
			if (managedModelsLoading) return "Loading Clawdi AI models.";
			return "Choose an available primary model.";
		}
		if (paidSelection && paymentMethod === "wallet") {
			if (!wallet.isSuccess || !wallet.data) {
				return wallet.error
					? "Retry loading your Wallet balance above."
					: "Loading your Wallet balance.";
			}
			if (visibleSubscriptionQuoteError) return "Retry the Wallet quote above.";
			if (visibleSubscriptionQuoteFetching && !walletDebit) return "Refreshing your Wallet quote.";
			if (!walletDebit) return "Waiting for your Wallet quote.";
			if (walletInsufficient) return "Top up your Wallet to continue.";
		}
		return null;
	})();
	const canSubmit = !submitting && !postPaymentBlocked && submitBlockingReason === null;

	function selectCreatedProvider(providerId: string) {
		selectCreatedAiProvider(providerId, aiProviders.dataUpdatedAt);
	}

	function selectRuntime(nextRuntime: HostedRuntime) {
		setRuntime(nextRuntime);
		setAssistantName((currentName) =>
			deployAssistantNameAfterRuntimeChange({
				currentName,
				hasBeenEdited: assistantNameEditedRef.current,
				runtime: nextRuntime,
			}),
		);
	}

	useEffect(() => {
		if (compute !== "performance" || !plans.isSuccess || perfPlan) return;
		setCompute("basic");
	}, [compute, plans.isSuccess, perfPlan]);

	useEffect(() => {
		const selectedOffer = compute === "performance" ? perfOfferSelection : basicOfferSelection;
		if (!selectedOffer || term === selectedOffer.billingTermMonths) {
			return;
		}
		setTerm(selectedOffer.billingTermMonths);
	}, [basicOfferSelection, compute, perfOfferSelection, term]);

	useEffect(() => {
		if (paymentMethod === "wallet" && walletDisabledReason) setPaymentMethod("card");
	}, [paymentMethod, walletDisabledReason]);

	function setComputeTier(next: Compute) {
		setCompute(next);
	}

	async function retryWalletQuote() {
		try {
			if (!wallet.data) {
				const walletResult = await wallet.refetch();
				if (walletResult.error) throw walletResult.error;
			}
			const quoteResult = await subscriptionCreateQuote.refetch();
			if (quoteResult.error) throw quoteResult.error;
		} catch (error) {
			toast.error("Couldn’t refresh Wallet quote", {
				description: normalizeBillingError(error),
			});
		}
	}

	function aiDeployFields(): DeployAiFields | null {
		try {
			return buildAiBindingFields(aiBindingDraft, {
				managedModels,
				mode: "create",
				providers: providerList,
			});
		} catch (error) {
			const copy = aiBindingBuildErrorCopy(error, "create");
			toast.error(copy.title, copy.description ? { description: copy.description } : undefined);
			return null;
		}
	}

	function showPostPaymentError(title: string, description: string) {
		setPostPaymentBlocked(true);
		toast.error(title, {
			id: "deploy-post-payment-error",
			description,
			duration: Number.POSITIVE_INFINITY,
			action: {
				label: "View agents",
				onClick: () => void router.navigate({ href: "/agents" }),
			},
		});
	}

	function showDeploySubmissionError(error: unknown) {
		const presentation = deploySubmissionErrorPresentation(
			error,
			paidSelection
				? paymentMethod === "wallet"
					? "wallet_creation"
					: "card_checkout"
				: "included_creation",
		);
		toast.error(presentation.title, {
			id: "deploy-submit-error",
			description: presentation.description,
			action: {
				label: "Retry",
				onClick: () => {
					if (canSubmit) void runAction(onDeploy);
				},
			},
		});
	}

	function buildDeployRequest(
		aiFields: DeployAiFields,
		computePlanSlug: ComputePlanSlug,
	): DeployRequest {
		return buildHostedDeployRequest({
			computePlanSlug,
			runtime,
			persona: {
				assistantName,
				language,
				timezone,
			},
			aiFields,
		});
	}

	function redirectTo(url: string | null | undefined): boolean {
		if (url) {
			window.location.href = url;
			return true;
		}
		return false;
	}

	function navigateToReusedSubscription({ deploymentId }: { deploymentId: string }) {
		setCheckoutSession(null);
		acceptDeployment(deploymentId);
	}
	async function handleCheckoutComplete(
		previousDeploymentIds: readonly string[],
		request: SubscriptionCreateRequestView | null,
	) {
		setCheckoutSession(null);
		setSubmitTakingLong(false);
		setSubmitBusyLabel("Creating agent…");
		setSubmitTakingLongCopy(
			"Payment was confirmed and agent creation is still starting. Keep this page open; we’ll take you to your agent as soon as its page is available.",
		);
		setSubmitting(true);
		let requestFingerprint: string | null = null;
		try {
			if (request) {
				requestFingerprint = idempotencyFingerprint({
					selection: request.selection,
					target: request.target,
				});
				try {
					const resolved = await resolveDeploymentRequest.mutateAsync(request.idempotencyKey);
					forgetIdempotencyAttempt("subscription-checkout", requestFingerprint);
					checkoutAttemptRef.current = null;
					acceptDeployment(resolved.deploymentId, true);
					return;
				} catch (error) {
					if (error instanceof DeploymentRequestTerminalError) {
						forgetIdempotencyAttempt("subscription-checkout", requestFingerprint);
						checkoutAttemptRef.current = null;
						const normalized = normalizeBillingError(error);
						showPostPaymentError(
							"Payment succeeded, but the agent could not be started",
							`${normalized} Don’t submit another payment; check Agents for the latest state.`,
						);
						return;
					}
					// Stripe may complete before its deployment request is visible. Fall back
					// to one inventory refresh after the bounded request-status watch ends.
				}
			}
			let refreshedDeployments: Awaited<ReturnType<typeof refreshCheckoutReturn>>;
			try {
				refreshedDeployments = await refreshCheckoutReturn();
			} catch {
				showPostPaymentError(
					"Payment succeeded; agent status is unavailable",
					"We couldn’t refresh your agent list. Don’t submit another payment; open Agents and check again in a moment.",
				);
				return;
			}
			const deploymentId = findNewDeploymentId(previousDeploymentIds, refreshedDeployments);
			if (!deploymentId) {
				showPostPaymentError(
					"Payment succeeded; your agent is not visible yet",
					"Don’t submit another payment. Open Agents and check again in a moment while the accepted request appears.",
				);
				return;
			}
			if (requestFingerprint) {
				forgetIdempotencyAttempt("subscription-checkout", requestFingerprint);
				checkoutAttemptRef.current = null;
			}
			acceptDeployment(deploymentId, true);
		} finally {
			setSubmitting(false);
			setSubmitTakingLong(false);
		}
	}

	async function onDeploy() {
		if (!canSubmit) return;
		setSubmitTakingLong(false);
		setSubmitBusyLabel(
			paidSelection
				? paymentMethod === "wallet"
					? "Confirming payment & creating agent…"
					: "Opening secure checkout…"
				: "Creating agent…",
		);
		setSubmitTakingLongCopy(
			paidSelection
				? paymentMethod === "wallet"
					? "Payment and agent creation are still being confirmed. Keep this page open; we’ll take you to your agent as soon as both are confirmed."
					: "Secure checkout is still opening. No payment has been submitted yet; keep this page open to continue."
				: "Agent creation is still starting. Keep this page open; we’ll take you to your agent as soon as its page is available.",
		);
		setSubmitting(true);
		try {
			const aiFields = aiDeployFields();
			if (!aiFields) return;
			if (paidSelection) {
				const deployConfig = buildDeployRequest(aiFields, paidSelection.computePlanSlug);
				const billingTermMonths = supportedBillingTerm(paidSelection.billingTermMonths);
				if (!billingTermMonths) {
					toast.error("Billing term unavailable", {
						description: "Choose Monthly or Annual billing before deploying.",
					});
					return;
				}
				const selection: SubscriptionCreateSelection = {
					planSlug: paidSelection.computePlanSlug,
					billingTermMonths,
					fundingSource: paymentMethod === "wallet" ? "wallet" : "stripe",
				};
				const cardCheckoutUiMode = checkoutUiModeForPublishableKey(env.VITE_STRIPE_PUBLISHABLE_KEY);
				const target = { kind: "new_deployment", deployConfig } as const;
				if (paymentMethod === "wallet") {
					const fingerprint = idempotencyFingerprint({ selection, target });
					const attempt = idempotencyAttemptFor(
						walletCreateAttemptRef.current,
						"subscription-wallet-deploy",
						fingerprint,
						newIdempotencyKey,
					);
					walletCreateAttemptRef.current = attempt;
					const outcome = await createSubscription
						.execute({
							selection,
							target,
							uiMode: CHECKOUT_ELEMENTS_UI_MODE,
							idempotencyKey: attempt.key,
							quote: lastSuccessfulSubscriptionQuote,
						})
						.catch((error: unknown) => {
							if (isIdempotencyKeyReusedError(error)) {
								forgetIdempotencyAttempt("subscription-wallet-deploy", fingerprint);
								walletCreateAttemptRef.current = null;
							}
							throw error;
						});
					if (outcome.flowType !== "subscription_activation") {
						throw new Error(
							"Wallet payment could not be confirmed. Review the payment method and try again.",
						);
					}
					forgetIdempotencyAttempt("subscription-wallet-deploy", fingerprint);
					walletCreateAttemptRef.current = null;
					showWalletPaymentConfirmation(
						walletDebit
							? formatUsdExact(walletDebit.debitAmountUsd)
							: formatCents(paidSelection.offer.price_cents),
					);
					acceptDeployment(outcome.deploymentId);
					return;
				}
				const checkoutFingerprint = idempotencyFingerprint({ selection, target });
				checkoutAttemptRef.current = idempotencyAttemptFor(
					checkoutAttemptRef.current,
					"subscription-checkout",
					checkoutFingerprint,
					newIdempotencyKey,
				);
				const outcome = await createSubscription
					.execute({
						selection,
						target,
						uiMode: cardCheckoutUiMode,
						idempotencyKey: checkoutAttemptRef.current.key,
						quote: lastSuccessfulSubscriptionQuote,
					})
					.catch((error: unknown) => {
						if (isIdempotencyKeyReusedError(error)) {
							forgetIdempotencyAttempt("subscription-checkout", checkoutFingerprint);
							checkoutAttemptRef.current = null;
						}
						throw error;
					});
				if (outcome.flowType === "subscription_activation") {
					forgetIdempotencyAttempt("subscription-checkout", checkoutFingerprint);
					checkoutAttemptRef.current = null;
					navigateToReusedSubscription(outcome);
					return;
				}
				const result = outcome.checkout;
				const clientSecret = checkoutSessionClientSecret(result);
				if (cardCheckoutUiMode === CHECKOUT_ELEMENTS_UI_MODE && clientSecret) {
					setCheckoutSession({
						clientSecret,
						previousDeploymentIds: (deployments.data ?? []).map(
							(deployment) => deployment.resource.id,
						),
						request: {
							selection,
							target,
							uiMode: cardCheckoutUiMode,
							idempotencyKey: checkoutAttemptRef.current.key,
							quote: lastSuccessfulSubscriptionQuote,
						},
						summary: computeCheckoutSummary({
							offer: paidSelection.offer,
							plan: paidSelection.plan,
							termMonths: paidSelection.billingTermMonths,
							tierLabel: paidSelection.tierLabel,
						}),
						tierLabel: paidSelection.tierLabel,
					});
					return;
				}
				if (redirectTo(checkoutRedirectUrl(result))) return;
				throw new Error(
					"Secure checkout could not be opened. Review the payment method and try again.",
				);
			}
			const deployConfig = buildDeployRequest(aiFields, COMPUTE_BASIC_SLUG);
			const fingerprint = idempotencyFingerprint(deployConfig);
			const attempt = idempotencyAttemptFor(
				includedCreateAttemptRef.current,
				"deployment-create",
				fingerprint,
				newIdempotencyKey,
			);
			includedCreateAttemptRef.current = attempt;
			const created = await billingClient
				.createDeployment(deployConfig, attempt.key)
				.catch((error: unknown) => {
					if (isIdempotencyKeyReusedError(error)) {
						forgetIdempotencyAttempt("deployment-create", fingerprint);
						includedCreateAttemptRef.current = null;
					}
					throw error;
				});
			forgetIdempotencyAttempt("deployment-create", fingerprint);
			includedCreateAttemptRef.current = null;
			acceptDeployment(created.deploymentId);
		} catch (e) {
			if (paymentMethod === "wallet") {
				void subscriptionCreateQuote.refetch();
				if (walletTopUp.handleFundingError(e)) return;
			}
			showDeploySubmissionError(e);
		} finally {
			setSubmitting(false);
			setSubmitTakingLong(false);
		}
	}

	const deployLabel = paidSelection
		? paymentMethod === "wallet"
			? walletInsufficient
				? "Top up Wallet"
				: "Pay & deploy"
			: "Continue to checkout"
		: "Deploy";
	const primaryProvider = providerList.find(
		(provider) => provider.provider_id === primaryProviderChoice,
	);
	const primaryProviderLabel =
		primaryProviderChoice === MANAGED_AI_CHOICE
			? MANAGED_PROVIDER_LABEL
			: providerDisplayLabel(primaryProvider ?? primaryProviderChoice);
	const aiSummary =
		aiAccessMode === "unmanaged"
			? authCardLabel("unmanaged")
			: [
					primaryProviderLabel,
					primaryModel
						? modelDisplayName(
								primaryModel,
								modelOptionsForProvider(primaryProviderChoice, providerList, managedModels),
							)
						: null,
				]
					.filter(Boolean)
					.join(" · ");
	const runtimeSummary = runtimeDisplayName(runtime);
	const deployAmount =
		compute === "basic" && basicSelection.mode === "included"
			? { amount: "Free", caption: null, detail: null }
			: paidSelection
				? paymentMethod === "wallet"
					? walletDeployAmountPresentation({
							billingTermMonths: paidSelection.billingTermMonths,
							state: walletQuoteState,
							walletDebit,
						})
					: cardDeployAmountPresentation(paidSelection.offer)
				: null;
	const walletTopUpAction =
		paidSelection !== null && paymentMethod === "wallet" && walletInsufficient;
	const primaryActionDisabled = walletTopUpAction
		? submitting || postPaymentBlocked || !wallet.data
		: !canSubmit;
	const amountExplainsBlocking =
		paidSelection !== null &&
		paymentMethod === "wallet" &&
		(walletQuoteState !== "ready" || walletInsufficient);
	const visibleSubmitBlockingReason = amountExplainsBlocking ? null : submitBlockingReason;
	const summaryLine = [
		`${compute === "performance" ? "Performance" : "Basic"} compute`,
		aiSummary,
		runtimeSummary,
		LANGUAGE_OPTIONS.find((l) => l.code === language)?.label ?? null,
		timezone || null,
	]
		.filter(Boolean)
		.join(" · ");

	const plansLoadError =
		plans.error ??
		(plans.isSuccess && !basicPlan && !perfPlan
			? new Error("The billing service returned no compute plans. Try loading plans again.")
			: null);

	if (plansLoadError) {
		return (
			<div data-hosted="true" data-v2="true" className={DEPLOY_PAGE_CLASS}>
				<PageHeader title="Deploy an Agent" />
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={plansLoadError}
					onRetry={() => void plans.refetch()}
					title="Couldn't load compute plans"
				/>
			</div>
		);
	}

	if (plans.isLoading) {
		return (
			<div data-hosted="true" data-v2="true" className={DEPLOY_PAGE_CLASS}>
				<PageHeader title="Deploy an Agent" description="Preparing your compute options…" />
				<DeploySectionSkeleton />
				<DeploySectionSkeleton />
				<DeploySectionSkeleton />
				<DeploySectionSkeleton />
			</div>
		);
	}

	return (
		<div data-hosted="true" data-v2="true" className={DEPLOY_PAGE_CLASS}>
			<form
				className="flex flex-col gap-6"
				onSubmit={(event) => {
					event.preventDefault();
					if (canSubmit) void runAction(onDeploy);
				}}
			>
				<PageHeader title="Deploy an Agent" />
				<SettingsSection title="Agent software">
					<div className={TWO_TILE_GRID_CLASS}>
						<EntityChoiceCard
							selected={runtime === "hermes"}
							onClick={() => selectRuntime("hermes")}
							icon={
								<EntityIcon kind="framework" id="hermes" label={runtimeDisplayName("hermes")} />
							}
							title={runtimeDisplayName("hermes")}
							description={runtimeBlurb("hermes")}
							badge={<Badge variant="secondary">Recommended</Badge>}
						/>
						<EntityChoiceCard
							selected={runtime === "openclaw"}
							onClick={() => selectRuntime("openclaw")}
							icon={
								<EntityIcon kind="framework" id="openclaw" label={runtimeDisplayName("openclaw")} />
							}
							title={runtimeDisplayName("openclaw")}
							description={runtimeBlurb("openclaw")}
						/>
					</div>
				</SettingsSection>

				<SettingsSection title="AI providers">
					<div className="flex flex-col gap-4">
						<div className={TWO_TILE_GRID_CLASS}>
							<EntityChoiceCard
								selected={managedProviderSelected}
								onClick={() => selectAiProviderChoice(MANAGED_AI_CHOICE)}
								icon={<ProviderIcon provider={MANAGED_PROVIDER_ID} />}
								title={MANAGED_PROVIDER_LABEL}
								description="No setup required. Usage draws from your Wallet."
								badge={<Badge variant="secondary">Default</Badge>}
							/>
							<EntityChoiceCard
								selected={aiAccessMode === "unmanaged"}
								onClick={() => setAiAccessMode("unmanaged")}
								icon={
									<IconChip tint="bg-muted text-muted-foreground">
										<Settings2 />
									</IconChip>
								}
								title={authCardLabel("unmanaged")}
								description="Deploy first, then configure model access inside the agent."
								badge={
									aiAccessMode === "unmanaged" ? <Badge variant="secondary">Selected</Badge> : null
								}
							/>
							{aiProviders.isLoading ? (
								<Skeleton className="h-[74px] w-full rounded-lg" />
							) : aiProviders.error ? (
								<div className="@2xl/main:col-span-2">
									<ApiErrorPanel
										title="Couldn't load providers"
										error={aiProviders.error}
										onRetry={() => aiProviders.refetch()}
										normalizer={aiProviderErrorNormalizer}
									/>
								</div>
							) : null}
							{savedProviderList.map((provider) => {
								const issue = providerAvailabilityIssue(provider, availabilityContext);
								return (
									<EntityChoiceCard
										key={provider.provider_id}
										selected={
											!issue &&
											aiAccessMode === "configured" &&
											primaryProviderChoice === provider.provider_id
										}
										onClick={() => selectAiProviderChoice(provider.provider_id)}
										disabled={Boolean(issue)}
										icon={<ProviderIcon provider={provider} />}
										title={providerDisplayLabel(provider)}
										description={issue?.message ?? providerCatalogDescription(provider)}
										badge={
											issue ? (
												<Badge variant="secondary">Unavailable</Badge>
											) : primaryProviderChoice === provider.provider_id ? (
												<Badge variant="secondary">Selected</Badge>
											) : (
												<AuthBadge auth={provider.auth} />
											)
										}
									/>
								);
							})}
							<AddTile
								title="Add a provider"
								description="Connect OpenAI, Anthropic, or another endpoint."
								onClick={() => setAddProviderOpen(true)}
							/>
						</div>
						{aiAccessMode !== "unmanaged" ? (
							<ModelBindingPicker
								idPrefix="deploy"
								className="w-full max-w-xl rounded-none border-0 bg-transparent p-0"
								providers={providerList}
								managedModels={managedModels}
								managedModelsLoading={managedModels.length === 0 && managedModelCatalog.isFetching}
								managedModelsError={managedModelCatalog.error}
								managedModelsErrorNormalizer={billingErrorNormalizer}
								onManagedModelsRetry={() => void managedModelCatalog.refetch()}
								customProviders={providerList}
								showProviderSelect={false}
								selectedProviderChoices={selectedProviderChoices}
								primaryProviderChoice={primaryProviderChoice}
								primaryModel={primaryModel}
								onPrimaryProviderChange={selectAiProviderChoice}
								onPrimaryModelChange={setPrimaryModel}
							/>
						) : null}
					</div>
				</SettingsSection>

				<SettingsSection title="Compute">
					<div className="flex flex-col gap-3">
						{!deployments.isSuccess ? (
							deployments.error ? (
								<ApiErrorPanel
									normalizer={billingErrorNormalizer}
									error={deployments.error}
									onRetry={() => void deployments.refetch()}
									title="Couldn't check existing agents"
								/>
							) : (
								<p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
									<Spinner className="size-3.5" /> Checking your free Basic slot…
								</p>
							)
						) : null}
						{deployments.isSuccess && activeIncludedBasicSlot === null ? (
							<Alert data-hosted="true">
								<TriangleAlert />
								<AlertTitle>Free Basic agent availability is unknown</AlertTitle>
								<AlertDescription className="flex flex-col gap-3 @2xl/main:flex-row @2xl/main:items-center @2xl/main:justify-between">
									<span>
										We can’t determine whether an existing agent is already using your free Basic
										allowance. No free agent is assumed.
									</span>
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={deployments.isFetching}
										onClick={() => void deployments.refetch()}
									>
										{deployments.isFetching ? (
											<Spinner className="size-3.5" />
										) : (
											<RefreshCw className="size-3.5" />
										)}
										Check again
									</Button>
								</AlertDescription>
							</Alert>
						) : null}
						{paidSelection && (compute === "performance" ? perfOffers : basicOffers).length > 1 ? (
							<div className="flex max-w-xs flex-col gap-1.5">
								<span className="text-xs text-muted-foreground">Billing term</span>
								<TermSwitcher
									offers={compute === "performance" ? perfOffers : basicOffers}
									value={compute === "performance" ? perfBillingTermMonths : basicBillingTermMonths}
									onChange={setTerm}
								/>
							</div>
						) : null}
						<div className={TWO_TILE_GRID_CLASS}>
							<EntityChoiceCard
								selected={compute === "basic"}
								onClick={
									deployments.isSuccess && !basicUnavailable
										? () => setComputeTier("basic")
										: undefined
								}
								icon={
									<IconChip size="sm" tint="bg-identity-3-bg text-identity-3-fg">
										<Cpu />
									</IconChip>
								}
								title="Basic"
								description={
									!deployments.isSuccess ? (
										<span className="text-xs">
											{deployments.error
												? "Basic availability couldn't be checked"
												: "Checking free Basic slot availability"}
										</span>
									) : (
										<ComputeResources
											testId="basic-ram-resource"
											vcpu={basicPlan?.vcpu ?? 2}
											ramGb={basicPlan?.ram_gb ?? 4}
										/>
									)
								}
								detailsPlacement="trailing"
								details={
									deployments.isSuccess && basicSelection.mode === "included" ? (
										<ComputePriceBlock
											testId="basic-compute-price"
											presentation={{
												primary: "Free",
												secondary: "First Basic agent",
												savings: null,
											}}
										/>
									) : deployments.isSuccess && basicPricePresentation ? (
										<ComputePriceBlock
											testId="basic-compute-price"
											presentation={basicPricePresentation}
										/>
									) : null
								}
								badge={
									!deployments.isSuccess ? (
										<Badge variant="secondary">
											{deployments.error ? "Unavailable" : "Checking…"}
										</Badge>
									) : basicSelection.mode === "unavailable" ? (
										<Badge variant="secondary">Unavailable</Badge>
									) : null
								}
								disabled={!deployments.isSuccess || basicUnavailable}
								className="items-center p-3"
							/>
							<EntityChoiceCard
								selected={compute === "performance"}
								onClick={
									deployments.isSuccess && perfPlan && perfOfferSelection
										? () => setComputeTier("performance")
										: undefined
								}
								icon={
									<IconChip size="sm" tint="bg-identity-8-bg text-identity-8-fg">
										<Zap />
									</IconChip>
								}
								title="Performance"
								description={
									perfPlan ? (
										<ComputeResources
											testId="performance-ram-resource"
											vcpu={perfPlan.vcpu}
											ramGb={perfPlan.ram_gb}
										/>
									) : (
										<span className="text-xs">Performance plan unavailable</span>
									)
								}
								detailsPlacement="trailing"
								details={
									perfPricePresentation ? (
										<ComputePriceBlock
											testId="performance-compute-price"
											presentation={perfPricePresentation}
										/>
									) : null
								}
								badge={perfPricePresentation ? null : <Badge>Unavailable</Badge>}
								disabled={!deployments.isSuccess || !perfPlan || !perfOfferSelection}
								className="items-center p-3"
							/>
						</div>
						{paidSelection ? (
							<div className="flex flex-col gap-3">
								<div className="text-sm font-medium">Payment method</div>
								<div className={TWO_TILE_GRID_CLASS}>
									<EntityChoiceCard
										selected={paymentMethod === "card"}
										onClick={() => setPaymentMethod("card")}
										icon={
											<IconChip tint="bg-muted text-muted-foreground">
												<CreditCard />
											</IconChip>
										}
										title="Card subscription"
										description="Recurring subscription via Stripe. Manage or cancel anytime."
									/>
									<EntityChoiceCard
										selected={paymentMethod === "wallet"}
										onClick={walletDisabledReason ? undefined : () => setPaymentMethod("wallet")}
										icon={
											<IconChip tint="bg-identity-6-bg text-identity-6-fg">
												<WalletCards />
											</IconChip>
										}
										title="Wallet balance"
										description={
											walletDisabledReason ??
											"Paid upfront from your Wallet balance. Renews from Wallet."
										}
										disabled={walletDisabledReason !== null}
									/>
								</div>
							</div>
						) : null}
						{compute === "basic" &&
						basicSelection.mode === "unavailable" &&
						basicSelection.reason !== "inventory_unavailable" ? (
							<p className="text-xs text-destructive" role="alert">
								{basicSelection.reason === "offers_missing"
									? "Paid Basic checkout isn’t available. Retry plans or choose Performance."
									: "The Basic plan isn’t available. Retry plans before deploying."}
							</p>
						) : null}
						{compute === "performance" && perfPlan && !perfOfferSelection ? (
							<p className="text-xs text-destructive" role="alert">
								Performance pricing isn’t available. Retry plans before deploying.
							</p>
						) : null}
					</div>
				</SettingsSection>
				<div className="pb-32 @2xl/main:pb-24">
					<SettingsSection title="Personalize">
						<div className="flex max-w-2xl flex-col gap-4">
							<div className="flex w-full max-w-md flex-col gap-1.5">
								<Label htmlFor="agent-name">Name in Clawdi</Label>
								<Input
									id="agent-name"
									value={assistantName}
									maxLength={DEPLOY_ASSISTANT_NAME_MAX_LENGTH}
									required
									aria-invalid={nameError ? true : undefined}
									aria-describedby={nameDescriptionIds}
									onChange={(event) => {
										assistantNameEditedRef.current = true;
										setAssistantName(event.target.value);
									}}
									onBlur={() => setAssistantName((name) => name.trim())}
								/>
								{nameError ? (
									<p id="agent-name-error" className="text-xs text-destructive" role="alert">
										{nameError}
									</p>
								) : null}
								{showNameCount ? (
									<p
										id="agent-name-count"
										className={cn(
											"text-xs",
											nameLimitReached
												? "font-medium text-warning-muted-foreground"
												: "text-muted-foreground",
										)}
									>
										{`${assistantName.length} / ${DEPLOY_ASSISTANT_NAME_MAX_LENGTH} characters${
											nameLimitReached ? " — limit reached." : ""
										}`}
									</p>
								) : null}
								{nameLimitReached ? (
									<span className="sr-only" role="status" aria-live="polite">
										{`Name limit reached. You can enter up to ${DEPLOY_ASSISTANT_NAME_MAX_LENGTH} characters.`}
									</span>
								) : null}
							</div>
							<div className="flex flex-wrap items-start gap-4">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="agent-language">Language</Label>
									<Select
										items={LANGUAGE_SELECT_ITEMS}
										value={language || "default"}
										onValueChange={(v) => {
											setLanguage(v === null || v === "default" ? "" : v);
										}}
									>
										<SelectTrigger id="agent-language" type="button">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectGroup>
												<SelectItem value="default">Default</SelectItem>
												{LANGUAGE_OPTIONS.map((l) => (
													<SelectItem key={l.code} value={l.code}>
														{l.label}
													</SelectItem>
												))}
											</SelectGroup>
										</SelectContent>
									</Select>
								</div>
								{tzOptions.length > 0 ? (
									<div className="flex w-full max-w-sm min-w-0 flex-col gap-1.5">
										<Label htmlFor="agent-timezone">Timezone</Label>
										<TimezoneCombobox
											id="agent-timezone"
											value={timezone}
											onValueChange={setTimezone}
											options={tzOptions}
										/>
									</div>
								) : null}
							</div>
						</div>
					</SettingsSection>
				</div>

				{/* Sticky action bar */}
				<div
					data-testid="deploy-action-bar"
					className="sticky bottom-0 z-10 -mx-4 border-t bg-background/90 px-4 pt-3 pb-[calc(--spacing(3)+env(safe-area-inset-bottom))] backdrop-blur lg:-mx-6 lg:px-6"
				>
					<div className="flex flex-col gap-2 @2xl/main:flex-row @2xl/main:items-center @2xl/main:justify-between">
						<div
							data-testid="deploy-configuration-summary"
							className="min-w-0 truncate text-xs text-muted-foreground sm:text-sm"
						>
							{summaryLine}
						</div>
						<div className="flex w-full shrink-0 flex-col gap-2 @2xl/main:w-auto @2xl/main:flex-row @2xl/main:items-center @2xl/main:justify-end">
							{deployAmount ? (
								<div
									data-testid="deploy-amount"
									className="flex min-w-0 flex-col @2xl/main:items-end @2xl/main:text-right"
									aria-live="polite"
								>
									<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 @2xl/main:justify-end">
										<span className="whitespace-nowrap font-semibold tabular-nums text-foreground">
											{deployAmount.amount}
										</span>
										{paymentMethod === "wallet" && walletQuoteState === "error" ? (
											<Button
												type="button"
												variant="link"
												size="sm"
												className="h-auto p-0"
												disabled={wallet.isFetching || subscriptionCreateQuote.isFetching}
												onClick={() => void retryWalletQuote()}
											>
												Retry
											</Button>
										) : null}
									</div>
									{deployAmount.caption ? (
										<span className="whitespace-nowrap text-xs text-muted-foreground">
											{deployAmount.caption}
										</span>
									) : null}
									{deployAmount.detail ? (
										<span className="whitespace-nowrap text-xs font-medium text-destructive">
											{deployAmount.detail}
										</span>
									) : null}
								</div>
							) : null}
							<div className="flex min-w-0 flex-col gap-1 @2xl/main:items-end">
								<Button
									type={walletTopUpAction ? "button" : "submit"}
									size="lg"
									disabled={primaryActionDisabled}
									aria-describedby={
										visibleSubmitBlockingReason ? "deploy-blocking-reason" : undefined
									}
									onClick={
										walletTopUpAction ? () => walletTopUp.show(walletShortfallUsd) : undefined
									}
									className="w-full shrink-0 @2xl/main:w-auto"
								>
									{submitting ? (
										<Spinner data-icon="inline-start" />
									) : (
										<Rocket data-icon="inline-start" />
									)}
									{submitting ? submitBusyLabel : deployLabel}
								</Button>
								{submitTakingLong ? (
									<p
										className="max-w-sm text-xs text-muted-foreground @2xl/main:text-right"
										role="status"
									>
										{submitTakingLongCopy}
									</p>
								) : visibleSubmitBlockingReason ? (
									<p
										id="deploy-blocking-reason"
										className={cn(
											"max-w-sm text-xs @2xl/main:text-right",
											nameError ? "text-destructive" : "text-muted-foreground",
										)}
										role="status"
									>
										{visibleSubmitBlockingReason}
									</p>
								) : null}
							</div>
						</div>
					</div>
				</div>
			</form>

			{/* Create a provider without leaving the wizard. */}
			<AddProviderDialog
				open={addProviderOpen}
				onOpenChange={setAddProviderOpen}
				onCreated={selectCreatedProvider}
			/>
			{wallet.data ? (
				<TopUpDialog
					{...walletTopUp.dialogProps}
					onComplete={() => {
						if (!submitting) void retryWalletQuote();
					}}
				/>
			) : null}
			<StripeCheckoutDialog
				open={checkoutSession !== null}
				onOpenChange={(next) => {
					if (!next) setCheckoutSession(null);
				}}
				clientSecret={checkoutSession?.clientSecret ?? null}
				title={`Complete ${checkoutSession?.tierLabel ?? "compute"} checkout`}
				description="Enter payment details without leaving this page. Redirect-based payment methods return here after confirmation."
				summary={checkoutSession?.summary ?? null}
				onComplete={() =>
					void handleCheckoutComplete(
						checkoutSession?.previousDeploymentIds ?? [],
						checkoutSession?.request ?? null,
					)
				}
			/>
		</div>
	);
}
