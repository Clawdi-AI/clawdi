"use client";

import { isFirstPartyManagedAiProvider } from "@clawdi/shared";
import { useLocation, useRouter } from "@tanstack/react-router";
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
import { useEffect, useMemo, useRef, useState } from "react";
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
import { PlanCBillingUnavailableNotice } from "@/hosted/billing/components/plan-c-unavailable-notice";
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
	type DeployWizardAiAccessMode,
} from "@/hosted/billing/deploy/deploy-defaults";
import { resolveBasicDeploySelection } from "@/hosted/billing/deploy/deploy-model";
import {
	buildHostedDeployRequest,
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
	billingErrorDetail,
	billingErrorNormalizer,
	isIdempotencyKeyReusedError,
	normalizeBillingError,
} from "@/hosted/billing/errors";
import {
	billingTermLabel,
	billingTermSuffix,
	formatCents,
	formatCentsCompact,
} from "@/hosted/billing/format";
import {
	checkoutReturnDeploymentId,
	checkoutReturnMarker,
	checkoutReturnWasCanceled,
	useCheckoutReturnRefresh,
	useCreateSubscription,
	useHostedDeployments,
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
import type {
	SubscriptionBillingTermMonths,
	SubscriptionCreateRequestView,
	SubscriptionCreateSelection,
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
import { topUpAmountCentsForCreditShortfall } from "@/hosted/billing/wallet/top-up-dialog.logic";
import { walletDebitShortfallCredits } from "@/hosted/billing/wallet/wallet-debit-summary";
import { runtimeBlurb, runtimeDisplayName } from "@/hosted/runtimes";
import { AddProviderDialog } from "@/hosted/v2/ai-providers/add-provider-dialog";
import { useAiProviders } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { AuthBadge, ProviderTypeChip } from "@/hosted/v2/ai-providers/ai-providers-ui";
import { authCardLabel } from "@/hosted/v2/ai-providers/auth-card-label";
import {
	dedupeProviderIds,
	firstModelForProvider,
	MANAGED_AI_CHOICE,
	MANAGED_PRIMARY_MODEL_FALLBACK,
	MANAGED_PROVIDER_ID,
	modelIdsForProvider,
	normalizeSelectedProviderIds,
	primaryModelRef,
	providerRefFromChoice,
} from "@/hosted/v2/ai-providers/model-binding";
import {
	aiProviderRuntimeId,
	buildAiProviderPoolBootstrap,
	type RuntimeAiProviderAuthKind,
} from "@/hosted/v2/ai-providers/runtime-bootstrap";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";
import { providerMeta } from "@/hosted/v2/channels/channel-providers";
import type { ChannelAccount } from "@/hosted/v2/channels/channel-types";
import { useChannels } from "@/hosted/v2/channels/channels-hooks";
import { agentSectionHref } from "@/lib/agent-routes";
import { isApiAuthError, normalizeApiError } from "@/lib/api-errors";
import { formatShortDate } from "@/lib/format";
import { useHostedProductAccess } from "@/lib/hosted-product-access";
import { cn } from "@/lib/utils";

type Compute = "basic" | "performance";
type AiAccessMode = DeployWizardAiAccessMode;
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
type WalletTopUpContext = {
	initialAmountCents: number | null;
	refundDebtCredits: number | null;
	blockedChargeCredits: number | null;
};
type SubscriptionReuseNotice = {
	validUntil: string | null;
};
const DEPLOY_PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6");
const THREE_TILE_GRID_CLASS = "grid gap-2 sm:grid-cols-2 lg:grid-cols-3";
const TWO_TILE_GRID_CLASS = "grid gap-2 sm:grid-cols-2";
const RUNTIME_TILE_GRID_CLASS = "grid gap-2 sm:grid-cols-2";
const CUSTOM_MODEL_CHOICE = "__custom__";
const EMPTY_WALLET_TOP_UP_CONTEXT: WalletTopUpContext = {
	initialAmountCents: null,
	refundDebtCredits: null,
	blockedChargeCredits: null,
};

function supportedBillingTerm(value: number): SubscriptionBillingTermMonths | null {
	return value === 1 || value === 12 ? value : null;
}

function decimalCredits(value: unknown): number | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const aiProviderErrorNormalizer: ApiErrorNormalizer = {
	isAuthError: isApiAuthError,
	normalizeError: (error) => `${normalizeApiError(error)} Managed AI still works.`,
};

function aiAuthKind(provider: AiProvider): RuntimeAiProviderAuthKind {
	return provider.auth.type === "agent_profile" || provider.auth.type === "oauth_profile"
		? "codex_oauth"
		: "api_key";
}

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
	const effectiveMonthly = formatCentsCompact(offer.effective_monthly_price_cents);
	const agentLabel =
		tierLabel === "Basic" ? "additional hosted Basic agent" : "hosted Performance agent";
	return {
		detail:
			termMonths === 1
				? `Per ${agentLabel}, billed monthly.`
				: `${effectiveMonthly}/mo effective per ${agentLabel}.`,
		planName: plan.name,
		priceLabel: formatCentsCompact(offer.price_cents),
		termLabel: billingTermLabel(termMonths),
	};
}

function recurringOfferLabel(offer: BillingOffer): string {
	const monthly = `${formatCentsCompact(offer.effective_monthly_price_cents)}/mo`;
	return offer.billing_term_months === 1
		? monthly
		: `${monthly}, billed ${formatCentsCompact(offer.price_cents)}${billingTermSuffix(
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
			badge={
				<Badge variant="outline" className="capitalize">
					{channel.status}
				</Badge>
			}
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
			return {
				tone: "destructive",
				message:
					basicSelection.reason === "offers_missing"
						? "Paid Basic checkout isn’t available from the billing service. Retry plans or choose Performance."
						: "The Basic plan isn’t available from the billing service. Retry plans before deploying.",
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
			message: `Checkout opens here. Billed ${formatCentsCompact(
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
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const hostedAccess = useHostedProductAccess();
	const plans = usePlans();
	const deployments = useHostedDeployments();
	const aiProviders = useAiProviders();
	const channels = useChannels();
	const createSubscription = useCreateSubscription();
	const resolveDeploymentRequest = useResolveDeploymentRequest();
	const refreshCheckoutReturn = useCheckoutReturnRefresh();
	const runAction = useActionLock();
	const checkoutAttemptRef = useRef<IdempotencyAttempt | null>(null);
	const walletCreateAttemptRef = useRef<IdempotencyAttempt | null>(null);
	const checkoutReturnRef = useRef<string | null>(null);
	const createdProviderGuardRef = useRef<{ providerId: string; dataUpdatedAt: number } | null>(
		null,
	);

	const [runtime, setRuntime] = useState(DEFAULT_DEPLOY_RUNTIME);
	const [aiAccessMode, setAiAccessMode] = useState<AiAccessMode>(DEFAULT_DEPLOY_AI_ACCESS_MODE);
	const [aiProviderChoices, setAiProviderChoices] = useState<string[]>([
		...DEFAULT_DEPLOY_AI_PROVIDER_CHOICES,
	]);
	const [primaryProviderChoice, setPrimaryProviderChoice] = useState(
		DEFAULT_DEPLOY_PRIMARY_PROVIDER_CHOICE,
	);
	const [primaryModel, setPrimaryModel] = useState(DEFAULT_DEPLOY_PRIMARY_MODEL);
	const [compute, setCompute] = useState<Compute>("basic");
	const [language, setLanguage] = useState("");
	const [timezone, setTimezone] = useState("");
	const [addProviderOpen, setAddProviderOpen] = useState(false);
	const [checkoutSession, setCheckoutSession] = useState<NativeDeployCheckout | null>(null);
	const [subscriptionReuseNotice, setSubscriptionReuseNotice] =
		useState<SubscriptionReuseNotice | null>(null);
	const [term, setTerm] = useState(1);
	const [submitting, setSubmitting] = useState(false);
	const [paymentMethod, setPaymentMethod] = useState<DeployPaymentMethod>("card");
	const [walletTopUpOpen, setWalletTopUpOpen] = useState(false);
	const [walletTopUpContext, setWalletTopUpContext] = useState<WalletTopUpContext>(
		EMPTY_WALLET_TOP_UP_CONTEXT,
	);

	// Default language + timezone to the browser's after mount (avoids an SSR
	// mismatch). Both stay explicitly unsettable back to the runtime default.
	useEffect(() => {
		setTimezone((tz) => tz || browserTimezone());
		setLanguage((lang) => lang || browserLanguage());
	}, []);
	useEffect(() => {
		if (hostedAccess.isLoading || hostedAccess.canUsePlanCBilling) return;
		setCheckoutSession(null);
		setWalletTopUpOpen(false);
	}, [hostedAccess.canUsePlanCBilling, hostedAccess.isLoading]);
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
			}),
		[basicPlan, term],
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
	const paidSelection: PaidDeploySelection | null =
		compute === "performance" && perfPlan && perfOfferSelection
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
		enabled: hostedAccess.canUsePlanCBilling && paymentMethod === "wallet",
	});
	const subscriptionCreateQuote = useSubscriptionCreateQuote(subscriptionCreateSelection, {
		enabled: hostedAccess.canUsePlanCBilling && paymentMethod === "wallet",
	});
	const walletDebit = subscriptionCreateQuote.data?.walletDebit ?? null;
	const walletShortfallCredits = walletDebitShortfallCredits(walletDebit);
	const walletInsufficient = walletShortfallCredits !== null;
	const basicUnavailable = basicSelection.mode === "unavailable";

	const providerList = useMemo(
		() =>
			(aiProviders.data?.providers ?? []).filter(
				(provider) => !isFirstPartyManagedAiProvider(provider),
			),
		[aiProviders.data?.providers],
	);
	const channelList = channels.data ?? [];
	const computePlanReady =
		compute === "performance" ? !!perfPlan && !!perfOfferSelection : !basicUnavailable;
	const planReady = !plans.isLoading && computePlanReady;
	const canSubmit =
		hostedAccess.canUsePlanCBilling &&
		planReady &&
		!submitting &&
		subscriptionReuseNotice === null &&
		(!paidSelection ||
			paymentMethod === "card" ||
			(!!walletDebit &&
				!subscriptionCreateQuote.isFetching &&
				!subscriptionCreateQuote.error &&
				!walletInsufficient));

	function selectCreatedProvider(providerId: string) {
		createdProviderGuardRef.current = {
			providerId,
			dataUpdatedAt: aiProviders.dataUpdatedAt,
		};
		setAiAccessMode("configured");
		setAiProviderChoices([providerId]);
		setPrimaryProvider(providerId);
	}

	useEffect(() => {
		const marker = checkoutReturnMarker(searchStr);
		if (!marker || checkoutReturnRef.current === marker) return;
		checkoutReturnRef.current = marker;
		void refreshCheckoutReturn().then(() => {
			if (checkoutReturnWasCanceled(searchStr)) {
				toast.message("Checkout canceled", {
					description: "You were not charged. Your agent was not deployed.",
				});
				return;
			}
			const deploymentId = checkoutReturnDeploymentId(searchStr);
			if (deploymentId) {
				void router.navigate({
					href: agentSectionHref(deploymentId, "overview", "source=on-clawdi"),
					replace: true,
				});
				return;
			}
			toast.message("Checkout status refreshed", {
				description: "We checked your deployments, subscription, and wallet.",
			});
		});
	}, [refreshCheckoutReturn, router, searchStr]);

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

	// Don't let the selection silently degrade to managed: if the chosen
	// provider vanishes from a SUCCESSFULLY-loaded list (deleted elsewhere),
	// reset to managed so the UI and the deploy request agree.
	useEffect(() => {
		const providerIds = new Set(providerList.map((provider) => provider.provider_id));
		const createdGuard = createdProviderGuardRef.current;

		let nextChoices = aiProviderChoices.filter(
			(choice) => choice === MANAGED_AI_CHOICE || providerIds.has(choice),
		);
		if (nextChoices.some((choice) => choice === createdGuard?.providerId)) {
			createdProviderGuardRef.current = null;
		}

		if (createdGuard && aiProviderChoices.includes(createdGuard.providerId)) {
			if (aiProviders.dataUpdatedAt <= createdGuard.dataUpdatedAt) return;
			createdProviderGuardRef.current = null;
		}

		if (aiProviders.isSuccess && !aiProviders.isFetching) {
			if (nextChoices.length === 0) nextChoices = [MANAGED_AI_CHOICE];
			const normalized = dedupeProviderIds(nextChoices);
			if (normalized.join("\0") !== aiProviderChoices.join("\0")) {
				setAiProviderChoices(normalized);
			}
			if (!normalized.includes(primaryProviderChoice)) {
				setPrimaryProvider(normalized[0] ?? MANAGED_AI_CHOICE);
			}
		}
	}, [
		aiProviderChoices,
		aiProviders.dataUpdatedAt,
		aiProviders.isFetching,
		aiProviders.isSuccess,
		primaryProviderChoice,
		providerList,
	]);

	useEffect(() => {
		if (primaryModel.trim()) return;
		const fallback = firstModelForProvider(
			primaryProviderChoice,
			aiProviders.data?.providers ?? [],
		);
		if (fallback) setPrimaryModel(fallback);
	}, [aiProviders.data?.providers, primaryModel, primaryProviderChoice]);

	function setComputeTier(next: Compute) {
		setCompute(next);
	}

	function providerUnavailable(description = "Refresh providers or choose Managed by Clawdi.") {
		toast.error("Provider unavailable", { description });
	}

	function setPrimaryProvider(choice: string) {
		setAiAccessMode("configured");
		const providers = aiProviders.data?.providers ?? [];
		const previousCatalog = modelIdsForProvider(primaryProviderChoice, providers);
		const nextCatalog = modelIdsForProvider(choice, providers);
		const fallback = firstModelForProvider(choice, providers);
		setPrimaryProviderChoice(choice);
		setAiProviderChoices((current) => normalizeSelectedProviderIds(current, choice));
		setPrimaryModel((current) => {
			const trimmed = current.trim();
			if (!trimmed) return fallback;
			if (
				previousCatalog.includes(trimmed) &&
				nextCatalog.length > 0 &&
				!nextCatalog.includes(trimmed)
			) {
				return fallback;
			}
			return current;
		});
	}

	function toggleAiProviderChoice(choice: string) {
		setAiAccessMode("configured");
		const selected = aiProviderChoices.includes(choice);
		let next = selected
			? aiProviderChoices.filter((item) => item !== choice)
			: aiProviderChoices.length === 1 &&
					aiProviderChoices[0] === MANAGED_AI_CHOICE &&
					choice !== MANAGED_AI_CHOICE
				? [choice]
				: [...aiProviderChoices, choice];
		if (next.length === 0) next = [choice];
		next = dedupeProviderIds(next);
		setAiProviderChoices(next);
		if (!next.includes(primaryProviderChoice)) {
			setPrimaryProvider(next[0] ?? MANAGED_AI_CHOICE);
		}
	}

	function aiDeployFields(): DeployAiFields | null {
		if (aiAccessMode === "unmanaged") {
			return { ai_provider_auth_kind: "unmanaged" };
		}
		const selectedChoices = normalizeSelectedProviderIds(aiProviderChoices, primaryProviderChoice);
		const providerRefs = selectedChoices
			.map((choice) => providerRefFromChoice(choice, providerList))
			.filter((providerId): providerId is string => Boolean(providerId));
		if (providerRefs.length !== selectedChoices.length) {
			providerUnavailable();
			return null;
		}

		const primaryProviderRef =
			providerRefFromChoice(primaryProviderChoice, providerList) ?? MANAGED_PROVIDER_ID;
		const modelRef = primaryModelRef(primaryProviderRef, primaryModel);
		if (!modelRef) {
			toast.error("Primary model required", {
				description: "Choose a catalog model or enter a model id.",
			});
			return null;
		}
		const primaryProvider = providerList.find(
			(provider) => provider.provider_id === primaryProviderChoice,
		);
		const primaryKind = primaryProvider ? aiAuthKind(primaryProvider) : "managed";
		const customProviders = selectedChoices
			.filter((choice) => choice !== MANAGED_AI_CHOICE)
			.map((choice) => providerList.find((provider) => provider.provider_id === choice))
			.filter((provider): provider is AiProvider => Boolean(provider));
		const body: DeployAiFields = {
			ai_provider_id: primaryProvider ? aiProviderRuntimeId(primaryProvider) : null,
			ai_provider_auth_kind: primaryKind,
			provider_ids: providerRefs,
			primary_model: modelRef,
		};
		if (customProviders.length > 0) {
			const bootstrapSelectedProvider = primaryProvider ?? customProviders[0];
			const bootstrapKind = aiAuthKind(bootstrapSelectedProvider);
			try {
				body.ai_provider_bootstrap = buildAiProviderPoolBootstrap(
					customProviders,
					bootstrapSelectedProvider.provider_id,
					bootstrapKind,
				);
			} catch (error) {
				providerUnavailable(
					error instanceof Error ? error.message : "Check provider configuration.",
				);
				return null;
			}
		}
		return body;
	}

	function buildDeployRequest(
		aiFields: DeployAiFields,
		computePlanSlug: ComputePlanSlug,
	): DeployRequest {
		return buildHostedDeployRequest({
			computePlanSlug,
			runtime,
			persona: {
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

	async function recheckPlanCBilling(): Promise<boolean> {
		const available = await hostedAccess.recheckPlanCBilling();
		if (!available) {
			setCheckoutSession(null);
			setWalletTopUpOpen(false);
		}
		return available;
	}

	function openWalletTopUp({
		shortfallCredits,
		refundDebtCredits = null,
		blockedChargeCredits = null,
	}: {
		shortfallCredits: number | null;
		refundDebtCredits?: number | null;
		blockedChargeCredits?: number | null;
	}) {
		const pointsPerUsd = walletDebit?.pointsPerUsd ?? wallet.data?.points_per_usd ?? 0;
		setWalletTopUpContext({
			initialAmountCents: topUpAmountCentsForCreditShortfall(shortfallCredits, pointsPerUsd),
			refundDebtCredits,
			blockedChargeCredits,
		});
		setWalletTopUpOpen(true);
	}

	function handleWalletCreateError(error: unknown): boolean {
		const detail = billingErrorDetail(error);
		if (detail?.code === "insufficient_wallet_balance" || detail?.code === "insufficient_balance") {
			openWalletTopUp({ shortfallCredits: decimalCredits(detail.shortfall_credits) });
			toast.error("Not enough AI Credits", {
				description: "Top up the shortfall, then review a fresh wallet quote.",
			});
			return true;
		}
		if (detail?.code === "open_refund_debt") {
			const refundDebtCredits = decimalCredits(detail.outstanding_debt_credits);
			const blockedChargeCredits = decimalCredits(walletDebit?.exactDebitCredits);
			openWalletTopUp({
				shortfallCredits:
					refundDebtCredits === null ? null : refundDebtCredits + (blockedChargeCredits ?? 0),
				refundDebtCredits,
				blockedChargeCredits,
			});
			toast.error("Refund debt must be repaid", {
				description: "Top up before starting this wallet subscription.",
			});
			return true;
		}
		return false;
	}

	function showSubscriptionReuseNotice({
		currentPeriodEnd,
		entitledUntil,
	}: {
		currentPeriodEnd: string | null;
		entitledUntil: string | null;
	}) {
		setCheckoutSession(null);
		setSubscriptionReuseNotice({
			validUntil: currentPeriodEnd ?? entitledUntil,
		});
		toast.success("Agent deployment started", {
			description: "Your active subscription was reused without another charge.",
		});
	}

	async function resolveWalletDeploymentId(
		deploymentId: string | null | undefined,
		deployRequestId: string | null | undefined,
	): Promise<string | null> {
		if (!deployRequestId) return deploymentId ?? null;
		const resolved = await resolveDeploymentRequest.mutateAsync(deployRequestId);
		return resolved.deploymentId || deploymentId || null;
	}

	async function fallbackToHostedCheckout(request: SubscriptionCreateRequestView) {
		if (!(await recheckPlanCBilling())) return;
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
		if (outcome.flowType === "subscription_activation") {
			forgetIdempotencyAttempt("subscription-checkout-hosted-fallback", fingerprint);
			checkoutAttemptRef.current = null;
			showSubscriptionReuseNotice(outcome);
			return;
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
				void router.navigate({
					href: agentSectionHref(resolved.deploymentId, "overview", "source=on-clawdi"),
					replace: true,
				});
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
			void router.navigate({
				href: agentSectionHref(deploymentId, "overview", "source=on-clawdi"),
				replace: true,
			});
			return;
		}
		toast.success("Checkout complete", {
			description: `Your ${tierLabel} deployment is provisioning. Check your agents list in a moment.`,
		});
	}

	async function onDeploy() {
		if (!canSubmit) return;
		setSubscriptionReuseNotice(null);
		setSubmitting(true);
		try {
			if (!(await recheckPlanCBilling())) return;
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
					const deploymentId = await resolveWalletDeploymentId(
						outcome.deploymentId,
						outcome.deployRequestId ?? attempt.key,
					);
					forgetIdempotencyAttempt("subscription-wallet-deploy", fingerprint);
					walletCreateAttemptRef.current = null;
					if (deploymentId) {
						toast.success("Agent deployed", {
							description: `${formatCents(walletDebit?.exactDebitCents ?? paidSelection.offer.price_cents)} was paid with AI Credits.`,
						});
						void router.navigate({
							href: agentSectionHref(deploymentId, "overview", "source=on-clawdi"),
						});
						return;
					}
					toast.success("Wallet subscription active", {
						description: "Your deployment is provisioning and will appear in Agents shortly.",
					});
					void router.navigate({ href: "/" });
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
				if (outcome.flowType === "subscription_activation") {
					forgetIdempotencyAttempt("subscription-checkout", checkoutFingerprint);
					checkoutAttemptRef.current = null;
					showSubscriptionReuseNotice(outcome);
					return;
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
		} catch (e) {
			if (paymentMethod === "wallet") {
				void subscriptionCreateQuote.refetch();
				if (handleWalletCreateError(e)) return;
			}
			toast.error("Couldn’t deploy", { description: normalizeBillingError(e) });
		} finally {
			setSubmitting(false);
		}
	}

	const deployLabel = subscriptionReuseNotice
		? "Deployment started"
		: !hostedAccess.canUsePlanCBilling
			? "Deployment temporarily unavailable"
			: paidSelection
				? paymentMethod === "wallet"
					? subscriptionCreateQuote.isFetching
						? "Getting wallet quote…"
						: walletInsufficient
							? "Top up to deploy"
							: walletDebit
								? `Pay ${formatCents(walletDebit.exactDebitCents)} from Wallet & deploy`
								: "Review wallet quote"
					: "Continue to checkout"
				: "Deploy agent";
	const selectedProviderCount =
		aiAccessMode === "configured"
			? normalizeSelectedProviderIds(aiProviderChoices, primaryProviderChoice).length
			: 0;
	const aiSummary =
		aiAccessMode === "unmanaged"
			? authCardLabel("unmanaged")
			: `${providerChoiceLabel(primaryProviderChoice, providerList)}${
					selectedProviderCount > 1 ? ` +${selectedProviderCount - 1}` : ""
				}`;
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

	if (plans.error) {
		return (
			<div data-hosted="true" data-v2="true" className={DEPLOY_PAGE_CLASS}>
				<PageHeader title="Deploy an Agent" />
				<ApiErrorPanel
					normalizer={billingErrorNormalizer}
					error={plans.error}
					onRetry={() => plans.refetch()}
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
				{subscriptionReuseNotice ? (
					<Alert
						data-testid="subscription-reuse-banner"
						aria-live="polite"
						className="border-emerald-500/35 bg-emerald-500/5"
					>
						<Sparkles />
						<AlertTitle>Active subscription reused</AlertTitle>
						<AlertDescription>
							{subscriptionReuseNotice.validUntil
								? `Reusing your active subscription — valid until ${formatShortDate(
										subscriptionReuseNotice.validUntil,
									)}, no additional charge.`
								: "Reusing your active subscription — no additional charge."}
						</AlertDescription>
					</Alert>
				) : null}
				{hostedAccess.isLoading || hostedAccess.canUsePlanCBilling ? null : (
					<PlanCBillingUnavailableNotice description="New deployments are temporarily unavailable. You can still review compute options, providers, channels, and existing agents." />
				)}

				<SettingsSection
					title="Runtimes"
					description="Choose one execution engine for this hosted compute."
				>
					<div className={RUNTIME_TILE_GRID_CLASS}>
						<EntityChoiceCard
							selected={runtime === "hermes"}
							onClick={() => setRuntime("hermes")}
							icon={
								<EntityIcon kind="framework" id="hermes" label={runtimeDisplayName("hermes")} />
							}
							title={runtimeDisplayName("hermes")}
							description={runtimeBlurb("hermes")}
						/>
						<EntityChoiceCard
							selected={runtime === "openclaw"}
							onClick={() => setRuntime("openclaw")}
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
							title="Managed by Clawdi"
							description="AI Credits from your wallet."
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
								title={provider.label ?? provider.provider_id}
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
						<PrimaryModelPicker
							providers={aiProviders.data?.providers ?? []}
							customProviders={providerList}
							selectedProviderChoices={normalizeSelectedProviderIds(
								aiProviderChoices,
								primaryProviderChoice,
							)}
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
						<div className="grid gap-2 sm:grid-cols-2">
							<EntityChoiceCard
								selected={compute === "basic"}
								onClick={!basicUnavailable ? () => setComputeTier("basic") : undefined}
								icon={
									<IconChip tint="bg-identity-3-bg text-identity-3-fg">
										<Cpu />
									</IconChip>
								}
								title="Basic"
								description={
									basicOffer
										? `${basicPlan?.vcpu ?? 2} vCPU / ${basicPlan?.ram_gb ?? 4} GB · ${recurringOfferLabel(basicOffer)}`
										: "Basic funding unavailable"
								}
								badge={
									<Badge variant="secondary">
										{basicOffer
											? `${formatCentsCompact(basicOffer.effective_monthly_price_cents)}/mo`
											: "Unavailable"}
									</Badge>
								}
								disabled={basicUnavailable}
							/>
							<EntityChoiceCard
								selected={compute === "performance"}
								onClick={perfPlan ? () => setComputeTier("performance") : undefined}
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
											? `${formatCentsCompact(perfOffer.effective_monthly_price_cents)}/mo`
											: perfPlan
												? `${formatCentsCompact(perfPlan.price_cents)}/mo`
												: "Unavailable"}
									</Badge>
								}
								disabled={!perfPlan}
							/>
						</div>
						{(compute === "performance" ? perfOffers : basicOffers).length > 1 ? (
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
										onClick={
											hostedAccess.canUsePlanCBilling ? () => setPaymentMethod("card") : undefined
										}
										icon={
											<IconChip tint="bg-muted text-muted-foreground">
												<CreditCard />
											</IconChip>
										}
										title="Card subscription"
										description="Pay securely with Stripe and manage the subscription from billing settings."
										badge={<Badge variant="secondary">Monthly or Annual</Badge>}
										disabled={!hostedAccess.canUsePlanCBilling}
									/>
									<EntityChoiceCard
										selected={paymentMethod === "wallet"}
										onClick={
											walletDisabledReason || !hostedAccess.canUsePlanCBilling
												? undefined
												: () => setPaymentMethod("wallet")
										}
										icon={
											<IconChip tint="bg-identity-6-bg text-identity-6-fg">
												<WalletCards />
											</IconChip>
										}
										title="Wallet balance"
										description={
											walletDisabledReason ??
											"Debit the exact quoted amount from AI Credits, then renew on the selected term."
										}
										badge={<Badge variant="outline">Monthly or Annual</Badge>}
										disabled={walletDisabledReason !== null || !hostedAccess.canUsePlanCBilling}
									/>
								</div>

								{paymentMethod === "wallet" ? (
									<div className="flex flex-col gap-3">
										{subscriptionCreateQuote.isFetching && !subscriptionCreateQuote.data ? (
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
													balanceBeforeCredits={walletDebit.balanceBeforeCredits}
													exactDebitCredits={walletDebit.exactDebitCredits}
													exactDebitCents={walletDebit.exactDebitCents}
													balanceAfterCredits={walletDebit.balanceAfterCredits}
												/>
												{walletInsufficient ? (
													<Alert variant="destructive">
														<TriangleAlert aria-hidden />
														<AlertTitle>Not enough AI Credits</AlertTitle>
														<AlertDescription className="flex flex-col items-start gap-3">
															<span>Top up the shortfall, then review a fresh wallet quote.</span>
															<Button
																type="button"
																size="sm"
																variant="outline"
																disabled={!wallet.data}
																onClick={() =>
																	openWalletTopUp({
																		shortfallCredits: walletShortfallCredits,
																	})
																}
															>
																<WalletCards data-icon="inline-start" /> Top up AI Credits
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
					title={
						<>
							Personalize <span className="font-normal text-muted-foreground">· optional</span>
						</>
					}
					description="Choose the agent's language and timezone."
				>
					<div className="grid max-w-2xl gap-4 sm:grid-cols-2">
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
						aria-describedby={
							hostedAccess.canUsePlanCBilling ? undefined : "plan-c-deploy-unavailable"
						}
						className="w-full sm:w-auto"
					>
						{submitting ? (
							<Spinner data-icon="inline-start" />
						) : (
							<Rocket data-icon="inline-start" />
						)}
						{submitting ? "Working…" : deployLabel}
					</Button>
					{hostedAccess.canUsePlanCBilling ? null : (
						<span id="plan-c-deploy-unavailable" className="sr-only">
							New deployments are temporarily unavailable.
						</span>
					)}
				</div>
			</div>

			{/* Create a provider without leaving the wizard. */}
			<AddProviderDialog
				open={addProviderOpen}
				onOpenChange={setAddProviderOpen}
				onCreated={selectCreatedProvider}
			/>
			{hostedAccess.canUsePlanCBilling && wallet.data ? (
				<TopUpDialog
					open={walletTopUpOpen}
					onOpenChange={(open) => {
						setWalletTopUpOpen(open);
						if (!open) setWalletTopUpContext(EMPTY_WALLET_TOP_UP_CONTEXT);
					}}
					wallet={wallet.data}
					initialAmountCents={walletTopUpContext.initialAmountCents}
					refundDebtCredits={walletTopUpContext.refundDebtCredits}
					blockedChargeCredits={walletTopUpContext.blockedChargeCredits}
					onComplete={() => void subscriptionCreateQuote.refetch()}
				/>
			) : null}
			<StripeCheckoutDialog
				open={checkoutSession !== null && hostedAccess.canUsePlanCBilling}
				onOpenChange={(next) => {
					if (!next) setCheckoutSession(null);
				}}
				clientSecret={checkoutSession?.clientSecret ?? null}
				title={`Complete ${checkoutSession?.tierLabel ?? "compute"} checkout`}
				description="Enter payment details without leaving this page. Redirect-based payment methods return here after confirmation."
				summary={checkoutSession?.summary ?? null}
				onBeforeConfirm={recheckPlanCBilling}
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

function providerChoiceLabel(choice: string, providers: readonly AiProvider[]): string {
	if (choice === MANAGED_AI_CHOICE) return "Managed AI";
	const provider = providers.find((item) => item.provider_id === choice);
	return provider?.label ?? provider?.provider_id ?? "Your provider";
}

function providerCatalogDescription(provider: AiProvider): string {
	const count = provider.models?.length ?? 0;
	if (count === 0) return providerTypeLabelFallback(provider);
	if (count === 1) return provider.models?.[0]?.id ?? providerTypeLabelFallback(provider);
	return `${count} catalog models`;
}

function PrimaryModelPicker({
	providers,
	customProviders,
	selectedProviderChoices,
	primaryProviderChoice,
	primaryModel,
	onPrimaryProviderChange,
	onPrimaryModelChange,
}: {
	providers: readonly AiProvider[];
	customProviders: readonly AiProvider[];
	selectedProviderChoices: readonly string[];
	primaryProviderChoice: string;
	primaryModel: string;
	onPrimaryProviderChange: (choice: string) => void;
	onPrimaryModelChange: (model: string) => void;
}) {
	const catalogModelIds = modelIdsForProvider(primaryProviderChoice, providers);
	const modelChoice = catalogModelIds.includes(primaryModel) ? primaryModel : CUSTOM_MODEL_CHOICE;
	const primaryProviderItems = [
		...(selectedProviderChoices.includes(MANAGED_AI_CHOICE)
			? [{ value: MANAGED_AI_CHOICE, label: "Managed by Clawdi" }]
			: []),
		...customProviders
			.filter((provider) => selectedProviderChoices.includes(provider.provider_id))
			.map((provider) => ({
				value: provider.provider_id,
				label: provider.label ?? provider.provider_id,
			})),
	];
	const catalogModelItems = [
		...catalogModelIds.map((model) => ({ value: model, label: model })),
		{ value: CUSTOM_MODEL_CHOICE, label: "Custom model" },
	];
	return (
		<div className="mt-4 flex max-w-2xl flex-col gap-3 rounded-lg border bg-muted/20 p-3">
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="deploy-primary-provider">Primary provider</Label>
					<Select
						items={primaryProviderItems}
						value={primaryProviderChoice}
						onValueChange={(value) => {
							if (value) onPrimaryProviderChange(value);
						}}
					>
						<SelectTrigger id="deploy-primary-provider" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								{selectedProviderChoices.includes(MANAGED_AI_CHOICE) ? (
									<SelectItem value={MANAGED_AI_CHOICE}>Managed by Clawdi</SelectItem>
								) : null}
								{customProviders
									.filter((provider) => selectedProviderChoices.includes(provider.provider_id))
									.map((provider) => (
										<SelectItem key={provider.provider_id} value={provider.provider_id}>
											{provider.label ?? provider.provider_id}
										</SelectItem>
									))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>
				{catalogModelIds.length > 0 ? (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="deploy-catalog-model">Catalog model</Label>
						<Select
							items={catalogModelItems}
							value={modelChoice}
							onValueChange={(value) => {
								if (!value) return;
								onPrimaryModelChange(value === CUSTOM_MODEL_CHOICE ? "" : value);
							}}
						>
							<SelectTrigger id="deploy-catalog-model" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{catalogModelIds.map((model) => (
										<SelectItem key={model} value={model}>
											{model}
										</SelectItem>
									))}
									<SelectItem value={CUSTOM_MODEL_CHOICE}>Custom model</SelectItem>
								</SelectGroup>
							</SelectContent>
						</Select>
					</div>
				) : null}
			</div>
			{/* The free-text model id is only needed when the catalog dropdown is
			    on "Custom model" (or the provider has no catalog). When a catalog
			    model is selected it just duplicates the dropdown, so hide it. */}
			{modelChoice === CUSTOM_MODEL_CHOICE ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="deploy-primary-model">
						{catalogModelIds.length > 0 ? "Custom model" : "Primary model"}
					</Label>
					<Input
						id="deploy-primary-model"
						value={primaryModel}
						onChange={(event) => onPrimaryModelChange(event.target.value)}
						placeholder={
							primaryProviderChoice === MANAGED_AI_CHOICE
								? MANAGED_PRIMARY_MODEL_FALLBACK
								: "model id"
						}
						autoComplete="off"
						spellCheck={false}
					/>
				</div>
			) : null}
		</div>
	);
}

function providerTypeLabelFallback(provider: AiProvider): string {
	return provider.base_url.replace(/^https?:\/\//, "");
}
