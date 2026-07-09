"use client";

import { isFirstPartyManagedAiProvider } from "@clawdi/shared";
import { useLocation, useRouter } from "@tanstack/react-router";
import { CalendarClock, Cpu, Plus, RefreshCw, Rocket, Sparkles, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type ApiErrorNormalizer, ApiErrorPanel } from "@/components/api-error-panel";
import { EntityChoiceCard } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TermSwitcher } from "@/hosted/billing/components/term-switcher";
import type {
	BillingOffer,
	CheckoutRequest,
	DeployRequest,
	Plan,
} from "@/hosted/billing/contracts";
import { usesActiveFreeComputeSlot } from "@/hosted/billing/deploy/deploy-model";
import { buildHostedDeployRequest } from "@/hosted/billing/deploy/deploy-request";
import {
	browserTimezone,
	LANGUAGE_OPTIONS,
	LANGUAGE_SELECT_ITEMS,
	supportedTimezones,
	TimezoneCombobox,
} from "@/hosted/billing/deploy/language-timezone-controls";
import { billingErrorNormalizer, normalizeBillingError } from "@/hosted/billing/errors";
import { billingTermSuffix, formatCentsCompact } from "@/hosted/billing/format";
import {
	checkoutReturnDeploymentId,
	checkoutReturnMarker,
	checkoutReturnWasCanceled,
	useCheckout,
	useCheckoutReturnRefresh,
	useCreateDeployment,
	useHostedDeployments,
	usePlans,
} from "@/hosted/billing/hooks";
import {
	type IdempotencyAttempt,
	idempotencyAttemptFor,
	idempotencyFingerprint,
	newIdempotencyKey,
} from "@/hosted/billing/idempotency";
import {
	COMPUTE_FREE_SLUG,
	COMPUTE_PERFORMANCE_SLUG,
	planOffers,
	resolveFreePlan,
	resolvePerformancePlan,
	selectOfferForTerm,
} from "@/hosted/billing/subscription/subscription-utils";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import { type HostedRuntime, runtimeBlurb, runtimeDisplayName } from "@/hosted/runtimes";
import { AddProviderDialog } from "@/hosted/v2/ai-providers/add-provider-dialog";
import { useAiProviders } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { AuthBadge, ProviderTypeChip } from "@/hosted/v2/ai-providers/ai-providers-ui";
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
import { cn } from "@/lib/utils";

type Compute = "free" | "performance";
type ComputePlanSlug = DeployRequest["compute_plan_slug"];
const DEPLOY_PAGE_CLASS = cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex flex-col gap-6 px-4 lg:px-6");
const THREE_TILE_GRID_CLASS = "grid gap-2 sm:grid-cols-2 lg:grid-cols-3";
const TWO_TILE_GRID_CLASS = "grid gap-2 sm:grid-cols-2";
const RUNTIME_TILE_GRID_CLASS = "grid gap-2 sm:grid-cols-2";
const CUSTOM_MODEL_CHOICE = "__custom__";

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
	freeSlotPending: boolean;
	freeSlotUsed: boolean;
	deploymentsError: unknown;
	freePlan: Plan | undefined;
	perfOffer: BillingOffer | null;
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
	freeSlotPending,
	freeSlotUsed,
	deploymentsError,
	freePlan,
	perfOffer,
}: ComputeStatusInput): { message: string; tone: "destructive" | "muted" } | null {
	if (compute === "free") {
		if (deploymentsError) {
			return {
				tone: "destructive",
				message: "Couldn’t verify your Free slot. Retry this page before deploying Free.",
			};
		}
		if (!freePlan) {
			return {
				tone: "destructive",
				message:
					"Free compute isn’t available from the billing service. Retry plans before deploying.",
			};
		}
		if (freeSlotUsed) {
			return {
				tone: "muted",
				message:
					"You already have an active Free agent. Stop or delete it to reuse Free, or deploy a Performance agent.",
			};
		}
		if (freeSlotPending) {
			return {
				tone: "muted",
				message: "Checking whether your Free slot is available before deployment.",
			};
		}
		return null;
	}

	if (perfOffer && perfOffer.billing_term_months !== 1) {
		return {
			tone: "muted",
			message: `You’ll be sent to checkout. Billed ${formatCentsCompact(
				perfOffer.price_cents,
			)}${billingTermSuffix(
				perfOffer.billing_term_months,
			)}; each Performance agent uses its own subscription.`,
		};
	}
	return {
		tone: "muted",
		message: "You’ll be sent to checkout. Each Performance agent uses its own subscription.",
	};
}

export function DeployWizard() {
	const router = useRouter();
	const searchStr = useLocation({ select: (location) => location.searchStr });
	const plans = usePlans();
	const deployments = useHostedDeployments();
	const aiProviders = useAiProviders();
	const channels = useChannels();
	const createDeployment = useCreateDeployment();
	const checkout = useCheckout();
	const refreshCheckoutReturn = useCheckoutReturnRefresh();
	const runAction = useActionLock();
	const checkoutAttemptRef = useRef<IdempotencyAttempt | null>(null);
	const deployAttemptRef = useRef<IdempotencyAttempt | null>(null);
	const checkoutReturnRef = useRef<string | null>(null);
	const createdProviderGuardRef = useRef<{ providerId: string; dataUpdatedAt: number } | null>(
		null,
	);

	const [runtime, setRuntime] = useState<HostedRuntime>("openclaw");
	const [aiProviderChoices, setAiProviderChoices] = useState<string[]>([MANAGED_AI_CHOICE]);
	const [primaryProviderChoice, setPrimaryProviderChoice] = useState(MANAGED_AI_CHOICE);
	const [primaryModel, setPrimaryModel] = useState(MANAGED_PRIMARY_MODEL_FALLBACK);
	const [compute, setCompute] = useState<Compute>("free");
	const [language, setLanguage] = useState("");
	const [timezone, setTimezone] = useState("");
	const [addProviderOpen, setAddProviderOpen] = useState(false);
	const [term, setTerm] = useState(1);
	const [submitting, setSubmitting] = useState(false);

	// Default the timezone to the browser's after mount (avoids an SSR mismatch).
	useEffect(() => {
		setTimezone((tz) => tz || browserTimezone());
	}, []);
	const tzOptions = useMemo(() => {
		const all = supportedTimezones();
		if (timezone && !all.includes(timezone)) return [timezone, ...all];
		return all;
	}, [timezone]);

	const freePlan = resolveFreePlan(plans.data);
	const perfPlan = resolvePerformancePlan(plans.data);
	const freeSlotUsed = usesActiveFreeComputeSlot(deployments.data);
	const freeSlotPending = deployments.isLoading;
	const freeSlotUnavailable = freeSlotUsed || freeSlotPending || !!deployments.error;
	const perfOfferSelection = useMemo(
		() => (perfPlan ? selectOfferForTerm(perfPlan, term) : null),
		[perfPlan, term],
	);
	const perfOffer = perfOfferSelection?.offer ?? null;
	const perfBillingTermMonths = perfOfferSelection?.billingTermMonths ?? term;
	const perfOffers = perfPlan ? planOffers(perfPlan) : [];

	const providerList = useMemo(
		() =>
			(aiProviders.data?.providers ?? []).filter(
				(provider) => !isFirstPartyManagedAiProvider(provider),
			),
		[aiProviders.data?.providers],
	);
	const channelList = channels.data ?? [];
	const computePlanReady =
		compute === "performance"
			? !!perfPlan && !!perfOfferSelection
			: !!freePlan && !freeSlotUnavailable;
	const planReady = !plans.isLoading && computePlanReady;
	const canSubmit = planReady && !submitting;

	function selectCreatedProvider(providerId: string) {
		createdProviderGuardRef.current = {
			providerId,
			dataUpdatedAt: aiProviders.dataUpdatedAt,
		};
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
		setCompute("free");
	}, [compute, plans.isSuccess, perfPlan]);

	useEffect(() => {
		if (
			compute !== "performance" ||
			!perfOfferSelection ||
			term === perfOfferSelection.billingTermMonths
		) {
			return;
		}
		setTerm(perfOfferSelection.billingTermMonths);
	}, [compute, perfOfferSelection, term]);

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

	useEffect(() => {
		if (compute !== "free" || !freeSlotUsed || !perfPlan) return;
		setCompute("performance");
	}, [compute, freeSlotUsed, perfPlan]);

	function setComputeTier(next: Compute) {
		setCompute(next);
	}

	function providerUnavailable(description = "Refresh providers or choose Managed by Clawdi.") {
		toast.error("Provider unavailable", { description });
	}

	function setPrimaryProvider(choice: string) {
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

	function aiDeployFields(): Partial<DeployRequest> | null {
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
		const body: Partial<DeployRequest> = {
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

	function buildDeployRequest(aiFields: Partial<DeployRequest>): DeployRequest {
		const computePlanSlug: ComputePlanSlug =
			compute === "performance" ? COMPUTE_PERFORMANCE_SLUG : COMPUTE_FREE_SLUG;
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

	async function onDeploy() {
		if (!canSubmit) return;
		setSubmitting(true);
		try {
			const aiFields = aiDeployFields();
			if (!aiFields) return;
			const deployConfig = buildDeployRequest(aiFields);

			if (compute === "performance" && perfPlan && perfOfferSelection) {
				const body: CheckoutRequest = {
					plan_slug: perfPlan.slug,
					billing_term_months: perfOfferSelection.billingTermMonths,
					ui_mode: "hosted",
					deploy_config: deployConfig,
				};
				checkoutAttemptRef.current = idempotencyAttemptFor(
					checkoutAttemptRef.current,
					"subscription-checkout",
					idempotencyFingerprint(body),
					newIdempotencyKey,
				);
				const result = await checkout.mutateAsync({
					body,
					idempotencyKey: checkoutAttemptRef.current.key,
				});
				if (redirectTo(result.action_url || result.checkout_url)) return;
				toast.error("Couldn't start checkout", {
					description: "No checkout URL was returned. Please try again.",
				});
				return;
			}

			deployAttemptRef.current = idempotencyAttemptFor(
				deployAttemptRef.current,
				"deploy",
				idempotencyFingerprint(deployConfig),
				newIdempotencyKey,
			);
			const deployment = await createDeployment.mutateAsync({
				body: deployConfig,
				idempotencyKey: deployAttemptRef.current.key,
			});
			toast.success("Deploying your agent", {
				description: "It’ll appear in your agents in a moment.",
			});
			void router.navigate({
				href: agentSectionHref(deployment.id, "overview", "source=on-clawdi"),
			});
		} catch (e) {
			toast.error("Couldn’t deploy", { description: normalizeBillingError(e) });
		} finally {
			setSubmitting(false);
		}
	}

	const deployLabel = compute === "performance" ? "Continue to checkout" : "Deploy agent";
	const selectedProviderCount = normalizeSelectedProviderIds(
		aiProviderChoices,
		primaryProviderChoice,
	).length;
	const aiSummary = `${providerChoiceLabel(primaryProviderChoice, providerList)}${
		selectedProviderCount > 1 ? ` +${selectedProviderCount - 1}` : ""
	}`;
	const runtimeSummary = runtimeDisplayName(runtime);
	const summaryLine = [
		`${compute === "performance" ? "Performance" : "Free"} compute`,
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

				<SettingsSection
					title="Runtimes"
					description="Choose one execution engine for this hosted compute."
				>
					<div className={RUNTIME_TILE_GRID_CLASS}>
						<EntityChoiceCard
							selected={runtime === "openclaw"}
							onClick={() => setRuntime("openclaw")}
							icon={
								<EntityIcon kind="framework" id="openclaw" label={runtimeDisplayName("openclaw")} />
							}
							title={runtimeDisplayName("openclaw")}
							description={runtimeBlurb("openclaw")}
						/>
						<EntityChoiceCard
							selected={runtime === "hermes"}
							onClick={() => setRuntime("hermes")}
							icon={
								<EntityIcon kind="framework" id="hermes" label={runtimeDisplayName("hermes")} />
							}
							title={runtimeDisplayName("hermes")}
							description={runtimeBlurb("hermes")}
						/>
					</div>
				</SettingsSection>

				<SettingsSection
					title="AI providers"
					description="Bind the provider pool and choose the primary model for the deployment."
				>
					<div className={TWO_TILE_GRID_CLASS}>
						<EntityChoiceCard
							selected={aiProviderChoices.includes(MANAGED_AI_CHOICE)}
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
									{primaryProviderChoice === MANAGED_AI_CHOICE ? "Primary" : "Managed"}
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
								selected={aiProviderChoices.includes(provider.provider_id)}
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
					description="Free gives one active hosted deployment. Performance is billed per deployment with higher resources."
				>
					<div className="flex flex-col gap-3">
						<div className="grid gap-2 sm:grid-cols-2">
							<EntityChoiceCard
								selected={compute === "free"}
								onClick={!freeSlotUnavailable ? () => setComputeTier("free") : undefined}
								icon={
									<IconChip tint="bg-identity-3-bg text-identity-3-fg">
										<Cpu />
									</IconChip>
								}
								title="Free"
								description={
									freeSlotUsed
										? "Free slot already in use"
										: freeSlotPending
											? "Checking Free slot…"
											: deployments.error
												? "Free slot check unavailable"
												: freePlan
													? `${freePlan.vcpu} vCPU / ${freePlan.ram_gb} GB burst · one active deployment`
													: "$0 · one active deployment"
								}
								badge={<Badge variant="secondary">$0</Badge>}
								disabled={freeSlotUnavailable}
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
						{compute === "performance" && perfOffers.length > 1 ? (
							<div className="flex flex-col gap-1.5 sm:max-w-xs">
								<span className="text-xs text-muted-foreground">Billing term</span>
								<TermSwitcher
									offers={perfOffers}
									value={perfBillingTermMonths}
									onChange={setTerm}
								/>
							</div>
						) : null}
						<ComputeStatusLine
							compute={compute}
							freeSlotPending={freeSlotPending}
							freeSlotUsed={freeSlotUsed}
							deploymentsError={deployments.error}
							freePlan={freePlan}
							perfOffer={perfOffer}
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
									<SelectItem value="default">Default</SelectItem>
									{LANGUAGE_OPTIONS.map((l) => (
										<SelectItem key={l.code} value={l.code}>
											{l.label}
										</SelectItem>
									))}
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
						{submitting ? <Spinner /> : <Rocket />}
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
								{catalogModelIds.map((model) => (
									<SelectItem key={model} value={model}>
										{model}
									</SelectItem>
								))}
								<SelectItem value={CUSTOM_MODEL_CHOICE}>Custom model</SelectItem>
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
