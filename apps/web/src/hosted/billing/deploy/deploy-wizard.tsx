"use client";

import { useRouter } from "@tanstack/react-router";
import {
	CalendarClock,
	Cpu,
	CreditCard,
	Plus,
	RefreshCw,
	Rocket,
	Settings2,
	Sparkles,
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
	findNewDeploymentId,
	hasCheckoutClientSecret,
} from "@/hosted/billing/components/stripe-checkout.logic";
import {
	StripeCheckoutDialog,
	type StripeCheckoutSummary,
} from "@/hosted/billing/components/stripe-checkout-dialog";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import { WalletDebitEquation } from "@/hosted/billing/components/wallet-debit-equation";
import type {
	BillingOffer,
	ComputePlanSlug,
	DeployRequest,
	Plan,
} from "@/hosted/billing/contracts";
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
	buildHostedDeployRequest,
	DEPLOY_ASSISTANT_NAME_MAX_LENGTH,
	type DeployAiFields,
} from "@/hosted/billing/deploy/deploy-request";
import {
	browserLanguage,
	browserTimezone,
	LANGUAGE_OPTIONS,
	LANGUAGE_SELECT_ITEMS,
	supportedTimezones,
	TimezoneCombobox,
} from "@/hosted/billing/deploy/language-timezone-controls";
import {
	billingErrorNormalizer,
	isIdempotencyKeyReusedError,
	normalizeBillingError,
} from "@/hosted/billing/errors";
import {
	billingTermLabel,
	billingTermSuffix,
	formatCents,
	formatUsdExact,
} from "@/hosted/billing/format";
import {
	useCheckoutReturnRefresh,
	useCreateSubscription,
	useHostedDeployments,
	useManagedModelCatalog,
	usePlans,
	useResolveDeploymentRequest,
	useSubscriptionCreateQuote,
	useWallet,
} from "@/hosted/billing/hooks";
import {
	forgetIdempotencyAttempt,
	type IdempotencyAttempt,
	idempotencyAttemptFor,
	idempotencyFingerprint,
	newIdempotencyKey,
} from "@/hosted/billing/idempotency";
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
import { type HostedRuntime, runtimeBlurb, runtimeDisplayName } from "@/hosted/runtimes";
import { AddProviderDialog } from "@/hosted/v2/ai-providers/add-provider-dialog";
import {
	aiBindingBuildErrorCopy,
	buildAiBindingFields,
} from "@/hosted/v2/ai-providers/ai-provider-binding";
import { useUserAiProviders } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { AuthBadge, ProviderTypeChip } from "@/hosted/v2/ai-providers/ai-providers-ui";
import { authCardLabel } from "@/hosted/v2/ai-providers/auth-card-label";
import {
	MANAGED_AI_CHOICE,
	MANAGED_PROVIDER_ID,
	MANAGED_PROVIDER_LABEL,
	modelDisplayName,
	modelOptionsForProvider,
	providerCatalogDescription,
	providerDisplayLabel,
} from "@/hosted/v2/ai-providers/model-binding";
import { ModelBindingPicker } from "@/hosted/v2/ai-providers/model-binding-picker";
import { useAiProviderBindingDraft } from "@/hosted/v2/ai-providers/use-ai-provider-binding-draft";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";
import type { ChannelAccount } from "@/hosted/v2/channels/channel-types";
import { ChannelStatusBadge } from "@/hosted/v2/channels/channel-ui";
import { useChannels } from "@/hosted/v2/channels/channels-hooks";
import { agentSectionHref } from "@/lib/agent-routes";
import { isApiAuthError, normalizeApiError } from "@/lib/api-errors";
import { useHostedProductAccess } from "@/lib/hosted-product-access";
import { cn } from "@/lib/utils";

type Compute = "basic" | "performance";
type DeployPaymentMethod = "card" | "wallet";
type NativeDeployCheckout = {
	clientSecret: string;
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
const THREE_TILE_GRID_CLASS = "grid gap-2 sm:grid-cols-2 lg:grid-cols-3";
const TWO_TILE_GRID_CLASS = "grid gap-2 sm:grid-cols-2";
const RUNTIME_TILE_GRID_CLASS = "grid gap-2 sm:grid-cols-2";

function acceptedDeploymentNavigation(deploymentId: string, replace = false) {
	return { href: agentSectionHref(deploymentId, "overview", "source=on-clawdi"), replace };
}

const aiProviderErrorNormalizer: ApiErrorNormalizer = {
	isAuthError: isApiAuthError,
	normalizeError: (error) => `${normalizeApiError(error)} Managed AI still works.`,
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

function recurringOfferLabel(offer: BillingOffer): string {
	const monthly = `${formatCents(offer.effective_monthly_price_cents)}/mo`;
	return offer.billing_term_months === 1
		? monthly
		: `${monthly}, billed ${formatCents(offer.price_cents)}${billingTermSuffix(
				offer.billing_term_months,
			)}`;
}

function ChannelInfoTile({ channel }: { channel: ChannelAccount }) {
	const meta = providerMeta(channel.provider);
	return (
		<EntityChoiceCard
			selected={false}
			icon={<EntityIcon kind="channel" id={channel.provider} label={meta.label} />}
			title={channel.name}
			description={`${meta.label} is ready. Link it from the agent page after deploy.`}
			badge={<ChannelStatusBadge status={channel.status} />}
			className="h-full bg-card"
		/>
	);
}

interface ComputeStatusInput {
	compute: Compute;
	basicSelection: ReturnType<typeof resolveBasicDeploySelection>;
	basicOffer: BillingOffer | null;
	perfOffer: BillingOffer | null;
	paymentMethod: DeployPaymentMethod;
}

function ComputeStatusLine(input: ComputeStatusInput) {
	const status = computeStatusLine(input);
	if (!status) return null;
	return (
		<p
			className={cn(
				"text-xs",
				status.tone === "destructive" ? "text-destructive" : "text-muted-foreground",
			)}
		>
			{status.message}
		</p>
	);
}

function DeploySectionSkeleton({ columns = 2 }: { columns?: 2 | 3 }) {
	return (
		<section className="flex flex-col gap-4">
			<Separator />
			<div className="flex max-w-2xl flex-col gap-2">
				<Skeleton className="h-4 w-24" />
				<Skeleton className="h-3.5 w-80 max-w-full" />
				<Skeleton className="h-3.5 w-56 max-w-full" />
			</div>
			<div className={columns === 3 ? THREE_TILE_GRID_CLASS : TWO_TILE_GRID_CLASS}>
				{Array.from({ length: columns }).map((_, index) => (
					<Skeleton key={index} className="h-[86px] w-full rounded-lg" />
				))}
			</div>
		</section>
	);
}

function computeStatusLine({
	compute,
	basicSelection,
	basicOffer,
	perfOffer,
	paymentMethod,
}: ComputeStatusInput): { message: string; tone: "destructive" | "muted" } | null {
	if (compute === "basic") {
		if (basicSelection.mode === "unavailable") {
			if (basicSelection.reason === "inventory_unavailable") return null;
			return {
				tone: "destructive",
				message:
					basicSelection.reason === "offers_missing"
						? "Paid Basic checkout isn’t available from the billing service. Retry plans or choose Performance."
						: "The Basic plan isn’t available from the billing service. Retry plans before deploying.",
			};
		}
		if (basicSelection.mode === "included") {
			return {
				tone: "muted",
				message: "Your first Basic agent is free. No compute subscription is required.",
			};
		}
		if (basicOffer) {
			return {
				tone: "muted",
				message:
					paymentMethod === "wallet"
						? `Wallet funds this Basic agent at ${recurringOfferLabel(basicOffer)}.`
						: `Checkout opens here for this Basic agent at ${recurringOfferLabel(basicOffer)}.`,
			};
		}
		return null;
	}
	if (paymentMethod === "wallet") {
		return {
			tone: "muted",
			message: "Wallet debits the exact server quote now and renews on the selected billing term.",
		};
	}

	if (perfOffer && perfOffer.billing_term_months !== 1) {
		return {
			tone: "muted",
			message: `Checkout opens here. Billed ${formatCents(
				perfOffer.price_cents,
			)}${billingTermSuffix(
				perfOffer.billing_term_months,
			)}; each Performance agent uses its own subscription.`,
		};
	}
	return {
		tone: "muted",
		message: "Checkout opens here. Each Performance agent uses its own subscription.",
	};
}

export function DeployWizard() {
	const router = useRouter();
	const navigateCheckoutReturn = useCallback(
		(deploymentId: string): undefined => {
			void router.navigate(acceptedDeploymentNavigation(deploymentId, true));
		},
		[router],
	);
	useCheckoutReturnHandler({
		onCancelCopy: "You were not charged. Your agent was not deployed.",
		onNavigate: navigateCheckoutReturn,
	});
	const hostedAccess = useHostedProductAccess();
	const plans = usePlans();
	const deployments = useHostedDeployments();
	const managedModelCatalog = useManagedModelCatalog();
	const aiProviders = useUserAiProviders();
	const channels = useChannels();
	const createSubscription = useCreateSubscription();
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
	const [addProviderOpen, setAddProviderOpen] = useState(false);
	const [checkoutSession, setCheckoutSession] = useState<NativeDeployCheckout | null>(null);
	const [term, setTerm] = useState(1);
	const [submitting, setSubmitting] = useState(false);
	const [paymentMethod, setPaymentMethod] = useState<DeployPaymentMethod>("card");
	const walletTopUp = useWalletTopUpDialog(SUBSCRIPTION_WALLET_FUNDING_ERROR_COPY);

	// Default language + timezone to the browser's after mount (avoids an SSR
	// mismatch). Both stay explicitly unsettable back to the runtime default.
	useEffect(() => {
		setTimezone((tz) => tz || browserTimezone());
		setLanguage((lang) => lang || browserLanguage());
	}, []);
	const tzOptions = useMemo(() => {
		const all = supportedTimezones();
		if (timezone && !all.includes(timezone)) return [timezone, ...all];
		return all;
	}, [timezone]);

	const basicPlan = resolveBasicPlan(plans.data);
	const perfPlan = resolvePerformancePlan(plans.data);
	const basicOfferSelection = useMemo(
		() => (basicPlan ? selectExplicitOfferForTerm(basicPlan, term) : null),
		[basicPlan, term],
	);
	const basicSelection = useMemo(
		() =>
			resolveBasicDeploySelection({
				basicPlan,
				billingTermMonths: term,
				includedSlotAvailable: deployments.isSuccess
					? !usesActiveIncludedBasicSlot(deployments.data)
					: null,
			}),
		[basicPlan, deployments.data, deployments.isSuccess, term],
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
	const wallet = useWallet({
		enabled: paymentMethod === "wallet",
	});
	const subscriptionCreateQuote = useSubscriptionCreateQuote(subscriptionCreateSelection, {
		enabled: paymentMethod === "wallet",
	});
	const walletDebit = subscriptionCreateQuote.data?.walletDebit ?? null;
	const walletShortfallUsd = walletDebitShortfallUsd(walletDebit);
	const walletInsufficient = walletShortfallUsd !== null;
	const basicUnavailable = basicSelection.mode === "unavailable";

	const providerList = aiProviders.data ?? [];
	const managedModels = managedModelCatalog.data?.models ?? [];
	const {
		draft: aiBindingDraft,
		managedPrimaryModelReady,
		selectedProviderChoices,
		selectCreatedProvider: selectCreatedAiProvider,
		setBindingMode: setAiAccessMode,
		setPrimaryModel,
		setPrimaryProvider,
		toggleProvider: toggleAiProviderChoice,
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
	const {
		bindingMode: aiAccessMode,
		primaryModel,
		primaryProviderChoice,
		providerChoices: aiProviderChoices,
	} = aiBindingDraft;
	const channelList = channels.data ?? [];
	const computePlanReady =
		compute === "performance" ? !!perfPlan && !!perfOfferSelection : !basicUnavailable;
	const planReady = plans.isSuccess && computePlanReady;
	const canSubmit =
		planReady &&
		deployments.isSuccess &&
		managedPrimaryModelReady &&
		assistantName.trim().length > 0 &&
		!submitting &&
		(!paidSelection ||
			paymentMethod === "card" ||
			(wallet.isSuccess &&
				!!wallet.data &&
				!!walletDebit &&
				!subscriptionCreateQuote.isFetching &&
				!subscriptionCreateQuote.error &&
				!walletInsufficient));

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

	async function recheckCanCreateCloudAgents(): Promise<boolean> {
		const available = await hostedAccess.recheckCanCreateCloudAgents();
		if (!available) {
			setCheckoutSession(null);
			walletTopUp.reset();
		}
		return available;
	}

	async function fallbackToHostedCheckout(request: SubscriptionCreateRequestView) {
		if (!(await recheckCanCreateCloudAgents())) return;
		const fingerprint = idempotencyFingerprint({
			selection: request.selection,
			target: request.target,
			uiMode: "hosted",
			quote: request.quote,
		});
		checkoutAttemptRef.current = idempotencyAttemptFor(
			checkoutAttemptRef.current,
			"subscription-checkout-hosted-fallback",
			fingerprint,
			newIdempotencyKey,
		);
		const outcome = await createSubscription
			.mutateAsync({
				...request,
				uiMode: "hosted",
				idempotencyKey: checkoutAttemptRef.current.key,
			})
			.catch((error: unknown) => {
				if (isIdempotencyKeyReusedError(error)) {
					forgetIdempotencyAttempt("subscription-checkout-hosted-fallback", fingerprint);
					checkoutAttemptRef.current = null;
				}
				throw error;
			});
		if (outcome.flowType !== "checkout") {
			throw new Error("Hosted card fallback returned an activation flow.");
		}
		if (redirectTo(checkoutRedirectUrl(outcome.checkout))) return;
		throw new Error("No checkout URL was returned.");
	}

	async function handleCheckoutComplete(
		previousDeploymentIds: readonly string[],
		tierLabel: "Basic" | "Performance",
		request: SubscriptionCreateRequestView | null,
	) {
		setCheckoutSession(null);
		let requestFingerprint: string | null = null;
		if (request) {
			requestFingerprint = idempotencyFingerprint({
				selection: request.selection,
				target: request.target,
			});
			try {
				const resolved = await resolveDeploymentRequest.mutateAsync(request.idempotencyKey);
				forgetIdempotencyAttempt("subscription-checkout", requestFingerprint);
				checkoutAttemptRef.current = null;
				toast.success("Deployment ready", {
					description: `Your ${tierLabel} agent finished provisioning.`,
				});
				void router.navigate(acceptedDeploymentNavigation(resolved.deploymentId, true));
				return;
			} catch {
				// Stripe may complete before its deploy request is visible. Fall back
				// to the inventory refresh path and let normal polling pick it up.
			}
		}
		let refreshedDeployments: Awaited<ReturnType<typeof refreshCheckoutReturn>>;
		try {
			refreshedDeployments = await refreshCheckoutReturn();
		} catch {
			toast.success("Checkout complete", {
				description: `Your ${tierLabel} deployment is provisioning. We’ll refresh it on the next load.`,
			});
			return;
		}
		const deploymentId = findNewDeploymentId(previousDeploymentIds, refreshedDeployments);
		if (deploymentId) {
			if (requestFingerprint) {
				forgetIdempotencyAttempt("subscription-checkout", requestFingerprint);
				checkoutAttemptRef.current = null;
			}
			toast.success("Checkout complete", {
				description: `Your ${tierLabel} deployment is provisioning now.`,
			});
			void router.navigate(acceptedDeploymentNavigation(deploymentId, true));
			return;
		}
		toast.success("Checkout complete", {
			description: `Your ${tierLabel} deployment is provisioning. Check your agents list in a moment.`,
		});
	}

	async function onDeploy() {
		if (!canSubmit) return;
		setSubmitting(true);
		try {
			if (!(await recheckCanCreateCloudAgents())) return;
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
						.mutateAsync({
							selection,
							target,
							uiMode: CHECKOUT_ELEMENTS_UI_MODE,
							idempotencyKey: attempt.key,
							quote: subscriptionCreateQuote.data ?? null,
						})
						.catch((error: unknown) => {
							if (isIdempotencyKeyReusedError(error)) {
								forgetIdempotencyAttempt("subscription-wallet-deploy", fingerprint);
								walletCreateAttemptRef.current = null;
							}
							throw error;
						});
					if (outcome.flowType !== "subscription_activation") {
						throw new Error("Wallet subscription returned a checkout flow.");
					}
					forgetIdempotencyAttempt("subscription-wallet-deploy", fingerprint);
					walletCreateAttemptRef.current = null;
					toast.success("Agent deployed", {
						description: `${walletDebit ? formatUsdExact(walletDebit.debitAmountUsd) : formatCents(paidSelection.offer.price_cents)} was paid from Wallet.`,
					});
					void router.navigate(acceptedDeploymentNavigation(outcome.deploymentId));
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
					.mutateAsync({
						selection,
						target,
						uiMode: CHECKOUT_ELEMENTS_UI_MODE,
						idempotencyKey: checkoutAttemptRef.current.key,
						quote: subscriptionCreateQuote.data ?? null,
					})
					.catch((error: unknown) => {
						if (isIdempotencyKeyReusedError(error)) {
							forgetIdempotencyAttempt("subscription-checkout", checkoutFingerprint);
							checkoutAttemptRef.current = null;
						}
						throw error;
					});
				if (outcome.flowType !== "checkout") {
					throw new Error("Card subscription returned an activation flow.");
				}
				const result = outcome.checkout;
				if (hasCheckoutClientSecret(result)) {
					setCheckoutSession({
						clientSecret: result.client_secret,
						previousDeploymentIds: (deployments.data ?? []).map(
							(deployment) => deployment.resource.id,
						),
						request: {
							selection,
							target,
							uiMode: CHECKOUT_ELEMENTS_UI_MODE,
							idempotencyKey: checkoutAttemptRef.current.key,
							quote: subscriptionCreateQuote.data ?? null,
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
				toast.error("Couldn't start checkout", {
					description: "No checkout URL was returned. Please try again.",
				});
				return;
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
			toast.success("Agent deployed", {
				description: "Your first Basic agent is provisioning now for free.",
			});
			void router.navigate(acceptedDeploymentNavigation(created.deploymentId));
		} catch (e) {
			if (paymentMethod === "wallet") {
				void subscriptionCreateQuote.refetch();
				if (walletTopUp.handleFundingError(e)) return;
			}
			toast.error("Couldn’t deploy", { description: normalizeBillingError(e) });
		} finally {
			setSubmitting(false);
		}
	}

	const deployLabel = paidSelection
		? paymentMethod === "wallet"
			? subscriptionCreateQuote.isFetching
				? "Getting wallet quote…"
				: walletInsufficient
					? "Top up to deploy"
					: walletDebit
						? `Pay ${formatUsdExact(walletDebit.debitAmountUsd)} from Wallet & deploy`
						: "Review wallet quote"
			: "Continue to checkout"
		: "Deploy agent";
	const selectedProviderCount = aiAccessMode === "configured" ? selectedProviderChoices.length : 0;
	const primaryProvider = providerList.find(
		(provider) => provider.provider_id === primaryProviderChoice,
	);
	const aiSummary =
		aiAccessMode === "unmanaged"
			? authCardLabel("unmanaged")
			: [
					`${providerDisplayLabel(
						primaryProvider ??
							(primaryProviderChoice === MANAGED_AI_CHOICE
								? MANAGED_PROVIDER_ID
								: primaryProviderChoice),
					)}${selectedProviderCount > 1 ? ` +${selectedProviderCount - 1}` : ""}`,
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
				<DeploySectionSkeleton columns={3} />
				<DeploySectionSkeleton />
				<DeploySectionSkeleton />
				<DeploySectionSkeleton />
				<DeploySectionSkeleton />
			</div>
		);
	}

	return (
		<div data-hosted="true" data-v2="true" className={DEPLOY_PAGE_CLASS}>
			<div className="flex flex-col gap-6 sm:pb-24">
				<PageHeader
					title="Deploy an Agent"
					description="Choose the execution engine and AI provider for this hosted deployment."
				/>
				<SettingsSection
					title="Runtimes"
					description="Choose one execution engine for this hosted compute."
				>
					<div className={RUNTIME_TILE_GRID_CLASS}>
						<EntityChoiceCard
							selected={runtime === "hermes"}
							onClick={() => selectRuntime("hermes")}
							icon={
								<EntityIcon kind="framework" id="hermes" label={runtimeDisplayName("hermes")} />
							}
							title={runtimeDisplayName("hermes")}
							description={runtimeBlurb("hermes")}
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

				<SettingsSection
					title="AI providers"
					description="Bind the provider pool and choose the primary model for the deployment."
				>
					<div className={TWO_TILE_GRID_CLASS}>
						<EntityChoiceCard
							selected={aiAccessMode === "unmanaged"}
							onClick={() => setAiAccessMode("unmanaged")}
							icon={
								<IconChip tint="bg-muted text-muted-foreground">
									<Settings2 />
								</IconChip>
							}
							title={authCardLabel("unmanaged")}
							description="Deploy first, then configure model access inside the runtime."
							badge={
								<Badge variant={aiAccessMode === "unmanaged" ? "secondary" : "outline"}>
									{aiAccessMode === "unmanaged" ? "Selected" : "Optional"}
								</Badge>
							}
						/>
						<EntityChoiceCard
							selected={
								aiAccessMode === "configured" && aiProviderChoices.includes(MANAGED_AI_CHOICE)
							}
							onClick={() => toggleAiProviderChoice(MANAGED_AI_CHOICE)}
							icon={
								<IconChip tint="bg-primary/10 text-primary">
									<Sparkles />
								</IconChip>
							}
							title={MANAGED_PROVIDER_LABEL}
							description="Managed-AI usage paid directly from your Wallet."
							badge={
								<Badge variant="secondary">
									{aiAccessMode === "configured" && primaryProviderChoice === MANAGED_AI_CHOICE
										? "Default"
										: "Managed"}
								</Badge>
							}
						/>
						{aiProviders.isLoading ? (
							<Skeleton className="h-[74px] w-full rounded-lg" />
						) : aiProviders.error ? (
							<div className="sm:col-span-2">
								<ApiErrorPanel
									title="Couldn't load providers"
									error={aiProviders.error}
									onRetry={() => aiProviders.refetch()}
									normalizer={aiProviderErrorNormalizer}
								/>
							</div>
						) : null}
						{providerList.map((provider) => (
							<EntityChoiceCard
								key={provider.provider_id}
								selected={
									aiAccessMode === "configured" && aiProviderChoices.includes(provider.provider_id)
								}
								onClick={() => toggleAiProviderChoice(provider.provider_id)}
								icon={<ProviderTypeChip type={provider.type} />}
								title={providerDisplayLabel(provider)}
								description={providerCatalogDescription(provider)}
								badge={
									primaryProviderChoice === provider.provider_id ? (
										<Badge variant="secondary">Primary</Badge>
									) : (
										<AuthBadge auth={provider.auth} />
									)
								}
							/>
						))}
						<AddTile
							title="Add a provider"
							description="Connect OpenAI, Anthropic, or another endpoint."
							onClick={() => setAddProviderOpen(true)}
						/>
					</div>
					{aiAccessMode === "unmanaged" ? (
						<p className="mt-4 text-sm text-muted-foreground">
							This deploy sends no hosted provider binding. Configure models inside the agent after
							provisioning.
						</p>
					) : (
						<ModelBindingPicker
							idPrefix="deploy"
							className="mt-4"
							providers={providerList}
							managedModels={managedModels}
							managedModelsLoading={managedModels.length === 0 && managedModelCatalog.isFetching}
							managedModelsError={managedModelCatalog.error}
							managedModelsErrorNormalizer={billingErrorNormalizer}
							onManagedModelsRetry={() => void managedModelCatalog.refetch()}
							customProviders={providerList}
							selectedProviderChoices={selectedProviderChoices}
							primaryProviderChoice={primaryProviderChoice}
							primaryModel={primaryModel}
							onPrimaryProviderChange={setPrimaryProvider}
							onPrimaryModelChange={setPrimaryModel}
						/>
					)}
				</SettingsSection>

				<SettingsSection
					title={
						<>
							Channels <span className="font-normal text-muted-foreground">· optional</span>
						</>
					}
					description="Deploy first, then link a native channel from the agent page once provisioning creates the agent identity."
				>
					<div className={TWO_TILE_GRID_CLASS}>
						<EntityChoiceCard
							selected
							icon={
								<IconChip tint="bg-muted text-muted-foreground">
									<CalendarClock />
								</IconChip>
							}
							title="Link after deploy"
							description="Channel links need the agent identity created during provisioning."
							badge={<Badge variant="secondary">Default</Badge>}
						/>
						{channels.isLoading ? <Skeleton className="h-[74px] w-full rounded-lg" /> : null}
						{channels.error ? (
							<div className="flex min-h-[74px] flex-col items-start justify-center gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground sm:col-span-2">
								<p>Couldn’t load your channels. You can still deploy and link later.</p>
								<Button size="sm" variant="outline" onClick={() => channels.refetch()}>
									<RefreshCw /> Retry
								</Button>
							</div>
						) : (
							channelList.map((channel) => <ChannelInfoTile key={channel.id} channel={channel} />)
						)}
					</div>
				</SettingsSection>

				<SettingsSection
					title="Compute"
					description="Basic and Performance agents use per-deployment funding selected below."
				>
					<div className="flex flex-col gap-3">
						{!deployments.isSuccess ? (
							deployments.error ? (
								<ApiErrorPanel
									normalizer={billingErrorNormalizer}
									error={deployments.error}
									onRetry={() => void deployments.refetch()}
									title="Couldn't check deployment inventory"
								/>
							) : (
								<p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
									<Spinner className="size-3.5" /> Checking your free Basic slot…
								</p>
							)
						) : null}
						<div className="grid gap-2 sm:grid-cols-2">
							<EntityChoiceCard
								selected={compute === "basic"}
								onClick={
									deployments.isSuccess && !basicUnavailable
										? () => setComputeTier("basic")
										: undefined
								}
								icon={
									<IconChip tint="bg-identity-3-bg text-identity-3-fg">
										<Cpu />
									</IconChip>
								}
								title="Basic"
								description={
									!deployments.isSuccess
										? deployments.error
											? "Basic availability couldn't be checked"
											: "Checking free Basic slot availability"
										: basicSelection.mode === "included"
											? `${basicPlan?.vcpu ?? 2} vCPU / ${basicPlan?.ram_gb ?? 4} GB · First Basic agent — Free`
											: basicOffer
												? `${basicPlan?.vcpu ?? 2} vCPU / ${basicPlan?.ram_gb ?? 4} GB · ${recurringOfferLabel(basicOffer)}`
												: "Basic funding unavailable"
								}
								badge={
									<Badge variant="secondary">
										{!deployments.isSuccess
											? deployments.error
												? "Unavailable"
												: "Checking…"
											: basicSelection.mode === "included"
												? "Free"
												: basicOffer
													? `${formatCents(basicOffer.effective_monthly_price_cents)}/mo`
													: "Unavailable"}
									</Badge>
								}
								disabled={!deployments.isSuccess || basicUnavailable}
							/>
							<EntityChoiceCard
								selected={compute === "performance"}
								onClick={
									deployments.isSuccess && perfPlan
										? () => setComputeTier("performance")
										: undefined
								}
								icon={
									<IconChip tint="bg-identity-8-bg text-identity-8-fg">
										<Zap />
									</IconChip>
								}
								title="Performance"
								description={
									perfPlan
										? `${perfPlan.vcpu} vCPU / ${perfPlan.ram_gb} GB · per-agent subscription`
										: "Performance plan unavailable"
								}
								badge={
									<Badge>
										{perfOffer
											? `${formatCents(perfOffer.effective_monthly_price_cents)}/mo`
											: perfPlan
												? `${formatCents(perfPlan.price_cents)}/mo`
												: "Unavailable"}
									</Badge>
								}
								disabled={!deployments.isSuccess || !perfPlan}
							/>
						</div>
						{paidSelection && (compute === "performance" ? perfOffers : basicOffers).length > 1 ? (
							<div className="flex flex-col gap-1.5 sm:max-w-xs">
								<span className="text-xs text-muted-foreground">Billing term</span>
								<TermSwitcher
									offers={compute === "performance" ? perfOffers : basicOffers}
									value={compute === "performance" ? perfBillingTermMonths : basicBillingTermMonths}
									onChange={setTerm}
								/>
							</div>
						) : null}
						{paidSelection ? (
							<div className="flex flex-col gap-3">
								<div>
									<div className="text-sm font-medium">Payment method</div>
									<p className="text-xs text-muted-foreground">
										Choose how this deployment renews. You can review the charge before paying.
									</p>
								</div>
								<div className="grid gap-2 sm:grid-cols-2">
									<EntityChoiceCard
										selected={paymentMethod === "card"}
										onClick={() => setPaymentMethod("card")}
										icon={
											<IconChip tint="bg-muted text-muted-foreground">
												<CreditCard />
											</IconChip>
										}
										title="Card subscription"
										description="Pay securely with Stripe and manage the subscription from billing settings."
										badge={<Badge variant="secondary">Monthly or Annual</Badge>}
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
											"Debit the exact quoted USD amount from Wallet, then renew on the selected term."
										}
										badge={<Badge variant="outline">Monthly or Annual</Badge>}
										disabled={walletDisabledReason !== null}
									/>
								</div>

								{paymentMethod === "wallet" ? (
									<div className="flex flex-col gap-3">
										{!wallet.data && wallet.isFetching ? (
											<p className="text-sm text-muted-foreground" role="status">
												Loading your Wallet balance…
											</p>
										) : !wallet.data && wallet.error ? (
											<ApiErrorPanel
												normalizer={billingErrorNormalizer}
												error={wallet.error}
												onRetry={() => void wallet.refetch()}
												title="Couldn't load your Wallet balance"
											/>
										) : subscriptionCreateQuote.isFetching && !subscriptionCreateQuote.data ? (
											<p className="text-sm text-muted-foreground" role="status">
												Getting the exact wallet debit…
											</p>
										) : subscriptionCreateQuote.error ? (
											<ApiErrorPanel
												normalizer={billingErrorNormalizer}
												error={subscriptionCreateQuote.error}
												onRetry={() => void subscriptionCreateQuote.refetch()}
												title="Couldn’t get subscription quote"
											/>
										) : walletDebit ? (
											<>
												<WalletDebitEquation
													balanceBeforeUsd={walletDebit.balanceBeforeUsd}
													debitAmountUsd={walletDebit.debitAmountUsd}
													balanceAfterUsd={walletDebit.balanceAfterUsd}
												/>
												{walletInsufficient ? (
													<Alert variant="destructive">
														<TriangleAlert aria-hidden />
														<AlertTitle>Not enough Wallet balance</AlertTitle>
														<AlertDescription className="flex flex-col items-start gap-3">
															<span>Top up the shortfall, then review a fresh wallet quote.</span>
															<Button
																type="button"
																size="sm"
																variant="outline"
																disabled={!wallet.data}
																onClick={() => walletTopUp.show(walletShortfallUsd)}
															>
																<WalletCards data-icon="inline-start" /> Top up Wallet
															</Button>
														</AlertDescription>
													</Alert>
												) : null}
											</>
										) : null}
									</div>
								) : null}
							</div>
						) : null}
						<ComputeStatusLine
							compute={compute}
							basicSelection={basicSelection}
							basicOffer={basicOffer}
							perfOffer={perfOffer}
							paymentMethod={paymentMethod}
						/>
					</div>
				</SettingsSection>

				<SettingsSection
					title="Personalize"
					description="Name your agent and optionally choose its language and timezone."
				>
					<div className="grid max-w-2xl gap-4 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5 sm:col-span-2">
							<label htmlFor="agent-name" className="text-sm text-muted-foreground">
								Name
							</label>
							<Input
								id="agent-name"
								value={assistantName}
								maxLength={DEPLOY_ASSISTANT_NAME_MAX_LENGTH}
								required
								onChange={(event) => {
									assistantNameEditedRef.current = true;
									setAssistantName(event.target.value);
								}}
								onBlur={() => setAssistantName((name) => name.trim())}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<label htmlFor="agent-language" className="text-sm text-muted-foreground">
								Language
							</label>
							<Select
								items={LANGUAGE_SELECT_ITEMS}
								value={language || "default"}
								onValueChange={(v) => {
									setLanguage(v === null || v === "default" ? "" : v);
								}}
							>
								<SelectTrigger id="agent-language">
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
							<div className="flex flex-col gap-1.5">
								<label htmlFor="agent-timezone" className="text-sm text-muted-foreground">
									Timezone
								</label>
								<TimezoneCombobox
									id="agent-timezone"
									value={timezone}
									onValueChange={setTimezone}
									options={tzOptions}
								/>
							</div>
						) : null}
					</div>
				</SettingsSection>
			</div>

			{/* Sticky action bar */}
			<div className="-mx-4 border-t bg-background/90 px-4 pt-3 pb-[calc(--spacing(3)+env(safe-area-inset-bottom))] backdrop-blur sm:sticky sm:bottom-0 lg:-mx-6 lg:px-6">
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
					<p className="min-w-0 max-w-full truncate text-xs text-muted-foreground sm:text-sm">
						{summaryLine}
					</p>
					<Button
						size="lg"
						onClick={() => runAction(onDeploy)}
						disabled={!canSubmit}
						className="w-full sm:w-auto"
					>
						{submitting ? (
							<Spinner data-icon="inline-start" />
						) : (
							<Rocket data-icon="inline-start" />
						)}
						{submitting ? "Working…" : deployLabel}
					</Button>
				</div>
			</div>

			{/* Create a provider without leaving the wizard. */}
			<AddProviderDialog
				open={addProviderOpen}
				onOpenChange={setAddProviderOpen}
				onCreated={selectCreatedProvider}
			/>
			{wallet.data ? (
				<TopUpDialog
					{...walletTopUp.dialogProps}
					onComplete={() => void subscriptionCreateQuote.refetch()}
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
				onBeforeConfirm={recheckCanCreateCloudAgents}
				onComplete={() =>
					void handleCheckoutComplete(
						checkoutSession?.previousDeploymentIds ?? [],
						checkoutSession?.tierLabel ?? "Basic",
						checkoutSession?.request ?? null,
					)
				}
				onFallback={() =>
					checkoutSession
						? fallbackToHostedCheckout(checkoutSession.request)
						: Promise.reject(new Error("Missing checkout request."))
				}
			/>
		</div>
	);
}
