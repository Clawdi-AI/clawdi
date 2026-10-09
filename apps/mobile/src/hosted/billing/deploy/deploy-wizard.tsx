import {
	buildHostedDeploySubscriptionQuoteRequest,
	HOSTED_DEPLOY_LANGUAGE_OPTIONS,
	type HostedDeploySubscriptionSelection,
	type HostedDeployWizardDraft,
	hostedDeployAgentNameAfterRuntimeChange,
	hostedDeployRuntimeLabel,
	projectHostedDeployRequest,
	validateAndBuildHostedDeployRequest,
	validateHostedDeployPersona,
} from "@clawdi/shared/api";
import {
	agentsIndexClasses,
	hostedAgentOverviewClasses,
	deployWizardClasses as styles,
	subscriptionSourcePickerClasses,
} from "@clawdi/shared/ui";
import {
	agentSurfaceCopy,
	aiBindingCopy,
	billingTermLabel,
	cardDeployAmountPresentation,
	computePlanComparisonView,
	deployComputeResourceLabels,
	deployConfigurationSummary,
	deployFormCopy,
	explicitPlanOffers,
	firstModelForProvider,
	formatUsdExact,
	hostedDeployLanguageFromLocales,
	isValidTimezone,
	mergeTimezoneOptions,
	modelDisplayName,
	modelOptionsForProvider,
	planOffers,
	providerAvailabilityIssue,
	providerDisplayLabel,
	resolvedLocale,
	resolvedTimezone,
	reusableSubscriptionChoiceView,
	runtimeBlurb,
	subscriptionSourceCopy,
	supportedTimezones,
	timezoneLabel,
	type WalletDebitSummary,
	walletDebitShortfallUsd,
	walletDeployAmountPresentation,
} from "@clawdi/shared/view";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
	Cpu,
	CreditCard,
	Plus,
	Rocket,
	Smartphone,
	Store,
	WalletCards,
	Zap,
} from "lucide-react-native";
import { useEffect, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { AddAgentSetup } from "@/components/dashboard/add-agent-setup";
import { ActionButton, ChoiceSelect as NativePicker } from "@/components/dashboard/controls";
import { EmptyState } from "@/components/empty-state";
import {
	ENTITY_CHOICE_GRID_CLASS,
	EntityAddCard,
	EntityChoiceCard,
} from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { IconChip } from "@/components/icon-chip";
import { PageHeader } from "@/components/page-header";
import { ResourceError } from "@/components/resource-error";
import { SettingsSection } from "@/components/settings-section";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input as AppTextInput } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSub,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text as AppText } from "@/components/ui/text";
import { AppScrollView, AppView } from "@/components/ui/view";
import { WebIcon, WebText, WebView, webView } from "@/components/ui/web-layout";
import { formatDate } from "@/hooks/cloud-inventory";
import { WalletDebitEquation } from "@/hosted/billing/components/wallet-debit-equation";
import {
	admitWithStoreSlotRefresh,
	type CreationAttempt,
	canAdmitCreationAttempt,
	canDiscardCreationAttempt,
	canStartStorePurchase,
	finishReservedRequest,
	isDefinitiveAdmissionRejection,
	offeredQuoteSelections,
	type ReservedDeployResume,
	type ReusableSubscriptionChoice,
	reservedDeployResume,
	retryStoreAdmission,
	reusableSubscriptionChoice,
	serverAllowsEntitledCreation,
	storeAdmissionMessageKey,
	storeAdmissionRecoveryAttempt,
	storeFundingHoldsAttempt,
	validationTranslationKeys,
} from "@/hosted/billing/deploy/deploy-request";
import { readHostedStoreFunding } from "@/hosted/billing/deploy/store-funding";
import { nextBillingCursor, uniqueBillingItems } from "@/hosted/billing/format";
import { AddCreditsAction } from "@/hosted/billing/store/add-credits";
import {
	useComputePaywallPurchase,
	useComputePurchaseGate,
} from "@/hosted/billing/store/compute-store";
import { StoreNoticeText } from "@/hosted/billing/store/store-notice";
import {
	computePurchaseErrorNotice,
	computePurchaseNotice,
	creditPrice,
	formatCreditCents,
	formatCredits,
	type StoreNotice,
} from "@/hosted/billing/store/store-presentation";
import { operationIdFromName } from "@/hosted/deployment-status";
import { ProviderCreate } from "@/hosted/v2/ai-providers/add-provider-dialog";
import { AiBindingChoices } from "@/hosted/v2/ai-providers/ai-binding-choices";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import {
	clearAttempt,
	readSavedAttempt,
	replaceAttempt,
	saveAttempt,
} from "@/platform/creation-storage";
import { NativeSegments } from "@/platform/navigation/segmented-control";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { computeProductPlan } from "@/platform/store/compute-subscription";
import type { PurchaseOutcome } from "@/platform/store/purchase-flow";
import { StorePurchaseError, storePurchaseError } from "@/platform/store/store-error";
import { currentStorePlatform } from "@/platform/store/store-platform";
import { useMobileStore, useStoreSurfaces } from "@/platform/store/store-provider";

/** A new draft seeded like Web: the device language and timezone, when supported. */
function newDraft(): HostedDeployWizardDraft {
	return {
		runtime: "hermes",
		computePlanSlug: "compute_basic",
		agentName: "Hermes",
		language: hostedDeployLanguageFromLocales([resolvedLocale()]),
		timezone: resolvedTimezone(),
		ai: { mode: "managed", model: "" },
	};
}

/** IANA zones grouped by region for a two-level native menu; "UTC" stays top-level. */
function timezoneMenuGroups(options: readonly string[]) {
	const groups = new Map<string, string[]>();
	for (const timezone of options) {
		const slash = timezone.indexOf("/");
		const region = slash > 0 ? timezone.slice(0, slash) : "";
		groups.set(region, [...(groups.get(region) ?? []), timezone]);
	}
	return [...groups.entries()];
}

function providerChoiceFor(ai: HostedDeployWizardDraft["ai"]): string {
	return ai.mode === "managed"
		? "__managed__"
		: ai.mode === "unmanaged"
			? "__unmanaged__"
			: ai.providerId;
}

export function CreateAgentScreen() {
	const t = useI18n();
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ tab?: string }>();
	const [tab, setTab] = useState(params.tab === "connect" ? "connect" : "deploy");
	return (
		<SafeAreaScreen>
			<WebView recipe={agentsIndexClasses.page}>
				<PageHeader title={tab === "deploy" ? agentSurfaceCopy.deployAnAgent : t("agents.add")} />
				<NativeSegments
					value={tab}
					onChange={setTab}
					options={[
						{ value: "deploy", label: agentSurfaceCopy.deployAnAgent },
						{ value: "connect", label: t("agents.connect") },
					]}
				/>
			</WebView>
			{tab === "deploy" ? (
				<CreationForm key={`${scope.accountKey}:${scope.generation}`} />
			) : (
				<AppScrollView
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName={webView(agentsIndexClasses.page)}
				>
					<AddAgentSetup key={`${scope.accountKey}:${scope.generation}`} />
				</AppScrollView>
			)}
		</SafeAreaScreen>
	);
}

function CreationForm() {
	const cache = useQueryClient();
	const { compute, hosted, aiProviders, store: storeClient } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const t = useI18n();
	const router = useRouter();
	const action = useAuthAction(scope);
	// Store builds fund new compute only from Wallet credits; card checkout is hidden.
	const surfaces = useStoreSurfaces();
	const credits = t("store.credits");
	const fundingDefault: HostedDeploySubscriptionSelection["fundingSource"] = surfaces.cardBilling
		? "stripe"
		: "wallet";
	const [draft, setDraft] = useState(newDraft);
	const [source, setSource] = useState<"included" | "existing" | "new" | "store" | null>(null);
	// The reusable subscription row chosen for `existing`.
	const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
	// Store builds: subscribe through the official Paywall when the M1 gate allows it.
	const storeGate = useComputePurchaseGate();
	const purchaseCompute = useComputePaywallPurchase();
	const { flow: storeFlow, refresh: refreshStore, computeSlot } = useMobileStore();
	const [storeNotice, setStoreNotice] = useState<StoreNotice | null>(null);
	const [providerChoice, setProviderChoice] = useState("__managed__");
	const [previewTerm, setPreviewTerm] = useState(1);
	const [attempt, setAttempt] = useState<CreationAttempt | null>(null);
	const [storageKey, setStorageKey] = useState<string | null>(null);
	const [storageReady, setStorageReady] = useState(false);
	const [storageError, setStorageError] = useState(false);
	const [message, setMessage] = useState("");
	const [quoteSelection, setQuoteSelection] = useState<HostedDeploySubscriptionSelection | null>(
		null,
	);
	const [resolved, setResolved] = useState(false);
	// The reserved store request the user chose to finish on this device.
	const [resume, setResume] = useState<ReservedDeployResume | null>(null);
	const inventory = useQuery({
		queryKey: accountQueryKey(scope, "creation-inventory"),
		queryFn: ({ signal }) =>
			read(async (s) => {
				if (!compute) throw new Error("Compute API unavailable");
				const [plans, catalog, included, capabilities, providers] = await Promise.all([
					compute.listPlans(s),
					compute.getManagedModels(s),
					compute.getIncludedBasicAvailability(s),
					compute.getProductCapabilities(s),
					aiProviders.list(s),
				]);
				return { plans, catalog, included, capabilities, providers: providers.providers };
			}, signal),
		enabled: scope.isReady && Boolean(compute),
		retry: false,
	});
	const reusable = useInfiniteQuery({
		queryKey: accountQueryKey(scope, "creation-reusable"),
		initialPageParam: undefined as string | undefined,
		queryFn: ({ signal, pageParam }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getReusableSubscriptions({ limit: 25, cursor: pageParam }, s);
			}, signal),
		getNextPageParam: nextBillingCursor,
		enabled: scope.isReady && Boolean(compute),
		retry: false,
	});
	const reusableItems = uniqueBillingItems(
		reusable.data?.pages.flatMap((page) => page.items ?? []) ?? [],
		(item) => item.subscription_id,
	);

	useEffect(() => {
		let mounted = true;
		const current = () => mounted && scope.isCurrent() && !scope.signal.aborted;
		const restore = async () => {
			if (!scope.accountKey || !scope.isReady) return;
			try {
				const digest = await Crypto.digestStringAsync(
					Crypto.CryptoDigestAlgorithm.SHA256,
					scope.accountKey,
				);
				if (!current()) return;
				const key = `clawdi.creation.v1.${digest}`;
				const saved = await readSavedAttempt(key);
				if (!current()) return;
				setStorageKey(key);
				setAttempt(saved);
				if (saved) {
					setDraft(saved.draft);
					setProviderChoice(providerChoiceFor(saved.draft.ai));
					// A store-funded request stays on the store path until its purchase is funded.
					// Other saved requests replay as saved; only an exact subscription is shown.
					setSource(saved.storeFunding ? "store" : saved.subscription ? "existing" : null);
					setSubscriptionId(saved.subscription?.id ?? null);
				}
				setStorageReady(true);
			} catch {
				if (current()) setStorageError(true);
			}
		};
		void restore();
		return () => {
			mounted = false;
		};
	}, [scope]);

	const models = inventory.data?.catalog.models ?? [];
	useEffect(() => {
		if (!storageReady || attempt || !inventory.data) return;
		setDraft((previous) =>
			previous.ai.mode === "managed" && !previous.ai.model
				? {
						...previous,
						ai: {
							mode: "managed",
							model: firstModelForProvider("__managed__", [], inventory.data.catalog.models),
						},
					}
				: previous,
		);
	}, [storageReady, attempt, inventory.data]);
	const productPlan = (productId: string) => computeProductPlan(productId)?.planSlug ?? null;
	const reserved =
		storageReady && !storageError ? reservedDeployResume(computeSlot, attempt, productPlan) : null;
	const resuming = resume && reserved?.id === resume.id ? resume : null;
	// A reserved store request is admitted by its own slot, like a saved request.
	const hasRequest = Boolean(attempt) || resuming !== null;
	const selectedPlan = inventory.data?.plans.find((plan) => plan.slug === draft.computePlanSlug);
	const eligible = serverAllowsEntitledCreation(
		inventory.data?.capabilities,
		inventory.data?.included,
		selectedPlan,
		{ reusable: reusableItems, hasSavedAttempt: hasRequest },
	);
	const quoteOptions = offeredQuoteSelections(inventory.data?.plans ?? []).map((option) => ({
		...option,
		fundingSource: fundingDefault,
	}));
	const quoteAvailable =
		quoteSelection &&
		quoteOptions.some(
			(option) =>
				option.planSlug === quoteSelection.planSlug &&
				option.billingTermMonths === quoteSelection.billingTermMonths,
		);
	const selectedReusable =
		source === "existing"
			? (reusableItems.find((item) => item.subscription_id === subscriptionId) ?? null)
			: null;
	// Like Web, only a Wallet subscription is quoted (exact debit); card shows the plan price.
	const walletQuoteSelection =
		source === "new" && quoteAvailable && quoteSelection?.fundingSource === "wallet"
			? quoteSelection
			: null;
	const quote = useQuery({
		queryKey: accountQueryKey(
			scope,
			"creation-quote",
			walletQuoteSelection?.planSlug,
			walletQuoteSelection?.billingTermMonths,
		),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!compute || !walletQuoteSelection) throw new Error("Quote unavailable");
				return compute.quoteSubscription(
					buildHostedDeploySubscriptionQuoteRequest(walletQuoteSelection),
					s,
				);
			}, signal),
		enabled: scope.isReady && Boolean(compute) && walletQuoteSelection !== null,
		staleTime: 30_000,
		retry: false,
	});
	const walletDebit: WalletDebitSummary | null =
		walletQuoteSelection &&
		quote.data?.funding_source === "wallet" &&
		quote.data.balance_before_usd &&
		quote.data.debit_amount_usd &&
		quote.data.balance_after_usd
			? {
					balanceBeforeUsd: quote.data.balance_before_usd,
					debitAmountUsd: quote.data.debit_amount_usd,
					balanceAfterUsd: quote.data.balance_after_usd,
				}
			: null;
	const formatWalletAmount = (usd: string) =>
		surfaces.creditUnits ? formatCredits(usd, credits) : formatUsdExact(usd);
	const personaIssues = validateHostedDeployPersona({
		agentName: draft.agentName,
		language: draft.language,
		timezone: draft.timezone,
	});
	const timezoneOptions = mergeTimezoneOptions(
		supportedTimezones(),
		draft.timezone ? [draft.timezone] : [],
	);
	const current = (owns: () => boolean) => owns() && scope.isCurrent() && !scope.signal.aborted;
	// The store purchase for the saved or reserved request exists; admission selects its store row.
	const storeAdmission =
		source === "store" && (attempt?.storeFunding === "funded" || resuming !== null);
	const navigateDeployment = async (deploymentId: string, owns: () => boolean) => {
		if (!hosted) throw new Error("Hosted API unavailable");
		const deployment = await read((lease) => hosted.getDeployment(deploymentId, lease));
		if (!current(owns)) return;
		if (deployment.resource.id !== deploymentId || !deployment.agent_id)
			throw new Error("Agent identity unavailable");
		cache.setQueryData(
			accountQueryKey(scope, "deployments"),
			(existing: (typeof deployment)[] | undefined) => [
				...(existing ?? []).filter((item) => item.resource.id !== deploymentId),
				deployment,
			],
		);
		router.push(`/agents/${encodeURIComponent(deployment.agent_id)}`);
	};
	const navigateRequest = async (id: string, owns: () => boolean) => {
		if (!hosted) throw new Error("Hosted API unavailable");
		const status = await read((s) => hosted.getDeploymentByRequest(id, s));
		if (!current(owns)) return;
		const projection = projectHostedDeployRequest(status);
		if (projection.kind === "terminal" || projection.kind === "deployment") setResolved(true);
		if (projection.kind === "deployment") {
			await navigateDeployment(projection.deploymentId, owns);
		} else if (projection.kind === "operation" || projection.kind === "operation_name") {
			const operationId = operationIdFromName(
				projection.kind === "operation" ? projection.operation.name : projection.operationName,
			);
			if (!operationId) throw new Error("Invalid operation name");
			const operation =
				projection.kind === "operation"
					? projection.operation
					: await read((s) => hosted.getOperation(operationId, s));
			if (current(owns)) await navigateDeployment(operation.metadata.deploymentId, owns);
		} else
			setMessage(
				t(
					projection.kind === "terminal" || projection.kind === "invalid_success"
						? "creation.failed"
						: "creation.wait",
				),
			);
	};
	const create = () =>
		action.run(async (owns) => {
			if (
				!compute ||
				!hosted ||
				!storageReady ||
				!storageKey ||
				(!attempt &&
					source !== "included" &&
					!(source === "existing" && selectedReusable) &&
					!storeAdmission) ||
				!eligible ||
				!current(owns)
			)
				return;
			// Refresh authorization at the explicit mutation boundary, never rely on a stale query.
			const [capabilities, included, plans] = await read((s) =>
				Promise.all([
					compute.getProductCapabilities(s),
					compute.getIncludedBasicAvailability(s),
					compute.listPlans(s),
				]),
			);
			if (!current(owns)) return;
			const refreshedReusable = hasRequest
				? undefined
				: await reusable.refetch({ throwOnError: true });
			if (
				!current(owns) ||
				!serverAllowsEntitledCreation(
					capabilities,
					included,
					plans.find((p) => p.slug === draft.computePlanSlug),
					{
						reusable: refreshedReusable?.data?.pages.flatMap((page) => page.items ?? []),
						hasSavedAttempt: hasRequest,
					},
				)
			) {
				if (current(owns)) setMessage(t("creation.blocked"));
				return;
			}
			if (!attempt && resuming) {
				await finishReserved(resuming, owns);
				return;
			}
			const chosen =
				!attempt && selectedReusable ? reusableSubscriptionChoice(selectedReusable) : null;
			if (
				chosen &&
				!refreshedReusable?.data?.pages.some((page) =>
					page.items?.some((item) => item.subscription_id === chosen.id),
				)
			) {
				setSubscriptionId(null);
				setMessage(t("creation.subscriptionUnavailable"));
				return;
			}
			// A saved request is already validated. Catalog changes must not rewrite
			// or prevent same-key replay of an uncertain, previously admitted POST.
			const saved = attempt ?? prepareAttempt(draft, undefined, chosen ?? undefined);
			if (saved) await submit(saved, saved === attempt, owns);
		});
	const finishReserved = (reservedRequest: ReservedDeployResume, owns: () => boolean) =>
		finishReservedRequest({
			readStatus: async () => {
				if (!hosted) throw new Error("Hosted API unavailable");
				return read((s) => hosted.getDeploymentByRequest(reservedRequest.id, s));
			},
			observe: () => navigateRequest(reservedRequest.id, owns),
			admit: async () => {
				const prepared = prepareAttempt(
					{ ...draft, computePlanSlug: reservedRequest.planSlug },
					reservedRequest.id,
				);
				if (prepared) await submit({ ...prepared, storeFunding: "funded" }, false, owns);
			},
			current: () => current(owns),
		});
	const prepareAttempt = (
		next: HostedDeployWizardDraft,
		id: string = Crypto.randomUUID(),
		subscription?: ReusableSubscriptionChoice,
	): CreationAttempt | null => {
		const validated = validateAndBuildHostedDeployRequest(
			next,
			models,
			inventory.data?.providers ?? [],
		);
		if (!validated.ok) {
			setMessage(
				validated.issues.map((issue) => t(validationTranslationKeys[issue.field])).join("\n"),
			);
			return null;
		}
		const ai = next.ai;
		if (ai.mode === "managed" && !models.some((model) => model.id === ai.model)) return null;
		return {
			version: 1,
			submission: "prepared",
			id,
			draft: next,
			request: { ...validated.request, deploy_request_id: id },
			...(subscription ? { subscription } : {}),
		};
	};
	/** Explicit admission of a persisted request; the server is the final permission boundary. */
	const submit = async (saved: CreationAttempt, persisted: boolean, owns: () => boolean) => {
		if (!compute || !storageKey || !canAdmitCreationAttempt(saved)) return;
		// Persist before POST. A failed write must never fall through to creation.
		if (!persisted) await saveAttempt(storageKey, saved, () => current(owns));
		if (!current(owns)) return;
		setAttempt(saved);
		// Persist uncertainty BEFORE any POST, including an app crash or account switch.
		const submitting: CreationAttempt = { ...saved, submission: "uncertain" };
		await replaceAttempt(storageKey, saved, submitting, () => current(owns));
		if (!current(owns)) return;
		setAttempt(submitting);
		setMessage("");
		const readSlot = async () => {
			const platform = currentStorePlatform();
			if (!storeClient || !platform) return null;
			const bootstrap = await read((s) => storeClient.bootstrap(platform, s));
			return current(owns) ? bootstrap.compute_slot : null;
		};
		try {
			const subscription = submitting.subscription;
			// The same request id and payload: hosted admits it at most once.
			if (subscription)
				await read((s) => {
					if (!current(owns)) throw new Error("Creation action expired");
					return compute.assignReusableSubscription(
						submitting.request,
						submitting.id,
						{
							subscriptionId: subscription.id,
							planSlug: subscription.planSlug,
							billingTermMonths: subscription.billingTermMonths,
							fundingSource: subscription.fundingSource,
						},
						s,
					);
				});
			else
				await admitWithStoreSlotRefresh(
					submitting,
					() =>
						read((signal) =>
							retryStoreAdmission(
								submitting,
								(s) => {
									if (!current(owns)) throw new Error("Creation action expired");
									return compute.createEntitledDeployment(submitting.request, submitting.id, s, {
										computeSource: submitting.storeFunding ? "store" : undefined,
									});
								},
								signal,
							),
						),
					readSlot,
					productPlan,
				);
		} catch (error) {
			const storeMessage = storeAdmissionMessageKey(saved, error);
			if (current(owns) && storeMessage) {
				const recovered = storeAdmissionRecoveryAttempt(saved, error);
				if (recovered) {
					await replaceAttempt(storageKey, submitting, recovered, () => current(owns));
					if (!current(owns)) return;
					setAttempt(recovered);
				}
				setMessage(t(storeMessage));
				return;
			}
			if (current(owns) && isDefinitiveAdmissionRejection(saved, error)) {
				const rejected: CreationAttempt = { ...saved, submission: "entitlement_rejected" };
				await replaceAttempt(storageKey, submitting, rejected, () => current(owns));
				if (current(owns)) {
					setAttempt(rejected);
					setMessage(
						t(saved.subscription ? "creation.subscriptionUnavailable" : "creation.notAdmitted"),
					);
					if (saved.subscription) void reusable.refetch();
				}
			}
			throw error;
		}
		// The admitted request no longer holds a store reservation.
		if (saved.storeFunding) void refreshStore({ recover: false });
		if (current(owns)) await navigateRequest(saved.id, owns);
	};
	/** Read hosted funding for the exact saved request without starting recovery. */
	const readStoreFunding = async (saved: CreationAttempt, owns: () => boolean) => {
		const platform = currentStorePlatform();
		if (!saved.storeFunding || !storeClient || !platform) return null;
		const funding = await read((s) =>
			readHostedStoreFunding(storeClient, platform, saved, productPlan, s),
		);
		return current(owns) ? funding : null;
	};
	/**
	 * Design §5.1: persist the deploy draft for the plan the Paywall selected, buy it with
	 * that `deploy_request_id`, then run the same explicit admission. Pending and cancelled
	 * purchases never deploy; a cancel returns here with the draft intact.
	 */
	const subscribe = () =>
		action.run(async (owns) => {
			if (
				!compute ||
				!hosted ||
				!storageReady ||
				!storageKey ||
				source !== "store" ||
				!storeGate.available ||
				!canStartStorePurchase(attempt) ||
				!current(owns)
			)
				return;
			if (!attempt && !prepareAttempt(draft)) return;
			setMessage("");
			setStoreNotice(null);
			// The persisted journal value; every change is a compare-and-set against it.
			let saved = attempt;
			const persist = async (next: CreationAttempt) => {
				if (!saved) return;
				await replaceAttempt(storageKey, saved, next, () => current(owns));
				saved = next;
				if (current(owns)) setAttempt(next);
			};
			let mismatch: string | null = null;
			let outcome: PurchaseOutcome | null = null;
			let purchaseFailed = false;
			let notice: StoreNotice | null;
			try {
				outcome = await purchaseCompute(async (selected) => {
					const plan = computeProductPlan(selected.product.identifier);
					if (!plan) throw new StorePurchaseError("store_offering_unavailable");
					// Admission binds the store row by request and plan, so they must match.
					if (saved && saved.draft.computePlanSlug !== plan.planSlug) {
						mismatch = saved.draft.computePlanSlug;
						throw new StorePurchaseError("invalid_purchase_request");
					}
					if (!saved) {
						const prepared = prepareAttempt({ ...draft, computePlanSlug: plan.planSlug });
						if (!prepared) throw new StorePurchaseError("invalid_purchase_request");
						const next: CreationAttempt = { ...prepared, storeFunding: "awaiting_purchase" };
						await saveAttempt(storageKey, next, () => current(owns));
						saved = next;
						if (current(owns)) {
							setAttempt(next);
							setDraft(next.draft);
						}
					} else if (saved.storeFunding !== "awaiting_purchase")
						await persist({ ...saved, storeFunding: "awaiting_purchase" });
					return { pending_deploy_request_id: saved.id };
				});
				notice = outcome
					? computePurchaseNotice(outcome, null, "deploy", storeGate.storeName)
					: null;
			} catch (error) {
				const failure = storePurchaseError(error);
				purchaseFailed = true;
				notice = mismatch
					? null
					: computePurchaseErrorNotice(
							failure.code,
							"deploy",
							storeGate.storeName,
							formatDate(failure.retryAt),
						);
			}
			if (!current(owns)) return;
			if (saved?.storeFunding && !mismatch) {
				let funding: CreationAttempt["storeFunding"];
				if (outcome?.status === "funding_applied") funding = "funded";
				else if (!purchaseFailed && (!outcome || outcome.status === "cancelled"))
					funding = "awaiting_purchase";
				else {
					// Persist possible payment before another network read, including read failures.
					await persist({ ...saved, storeFunding: "purchase_pending" });
					if (!saved || !current(owns)) return;
					funding = (await readStoreFunding(saved, owns)) ?? undefined;
					if (!funding || !current(owns)) return;
				}
				if (funding !== saved.storeFunding) await persist({ ...saved, storeFunding: funding });
				// The persistent waiting line and Check status cover unfinished purchases.
				if (funding === "purchase_pending" && notice?.key !== "store.reviewRequired") notice = null;
				// Only this request's own funded purchase may run admission.
				if (funding === "funded") {
					await submit(saved, true, owns);
					return;
				}
			}
			if (!current(owns)) return;
			if (mismatch)
				setMessage(
					t("storeCompute.planMismatch", {
						plan:
							mismatch === "compute_performance"
								? agentSurfaceCopy.performance
								: t("billingParity.basic"),
					}),
				);
			setStoreNotice(notice);
		});
	/** Explicit status check: reconcile store purchases, then read this request's attempts. */
	const checkStoreFunding = () =>
		action.run(async (owns) => {
			const saved = attempt;
			if (!saved?.storeFunding || saved.storeFunding === "funded" || !storageKey) return;
			setStoreNotice(null);
			if (storeFlow && !storeFlow.isBusy()) await storeFlow.recover().catch(() => []);
			if (!current(owns)) return;
			const funding = await readStoreFunding(saved, owns);
			if (!funding || !current(owns)) return;
			if (funding !== saved.storeFunding) {
				const next: CreationAttempt = { ...saved, storeFunding: funding };
				await replaceAttempt(storageKey, saved, next, () => current(owns));
				if (!current(owns)) return;
				setAttempt(next);
			}
			setStoreNotice(
				funding === "funded"
					? { key: "storeCompute.fundingConfirmed", tone: "success", refresh: false }
					: funding === "awaiting_purchase"
						? { key: "storeCompute.notCompleted", tone: "neutral", refresh: false }
						: funding === "review_required"
							? null
							: { key: "storeCompute.stillWaiting", tone: "neutral", refresh: false },
			);
			await refreshStore({ recover: false });
		});
	// A Wallet quote below the debit can be funded through the store, then re-quoted.
	const shortfall = walletDebitShortfallUsd(walletDebit);
	const update = (patch: Partial<HostedDeployWizardDraft>) => {
		setDraft((previous) => ({ ...previous, ...patch }));
		setMessage("");
	};
	const locked = action.busy || Boolean(attempt) || !storageReady;

	const comparison = computePlanComparisonView(
		inventory.data?.plans ?? [],
		previewTerm,
		surfaces.creditUnits ? (cents) => formatCreditCents(cents, credits) : undefined,
	);
	const previewPlan =
		draft.computePlanSlug === "compute_performance" ? comparison.performance : comparison.basic;
	const billingOffers = previewPlan
		? draft.computePlanSlug === "compute_performance"
			? planOffers(previewPlan)
			: explicitPlanOffers(previewPlan)
		: [];
	const selectedOffer =
		draft.computePlanSlug === "compute_performance"
			? comparison.performanceOffer
			: comparison.basicOffer;
	const amount = selectedOffer ? cardDeployAmountPresentation(selectedOffer) : null;
	const aiSelection = draft.ai;
	const selectedModel =
		aiSelection.mode === "configured" ||
		(aiSelection.mode === "managed" && models.some((model) => model.id === aiSelection.model))
			? aiSelection.model
			: "";
	const walletAmount =
		walletQuoteSelection !== null
			? walletDeployAmountPresentation({
					billingTermMonths: walletQuoteSelection.billingTermMonths,
					state: quote.isError ? "error" : walletDebit ? "ready" : "loading",
					walletDebit,
					format: formatWalletAmount,
				})
			: null;
	const personaIssue = personaIssues[0];
	const blockingReason =
		attempt || resuming
			? null
			: source === null || (source === "existing" && !selectedReusable)
				? deployFormCopy.chooseSource
				: personaIssue
					? t(validationTranslationKeys[personaIssue.field])
					: source === "new"
						? t("creation.newUnavailable")
						: source !== "store" && !eligible
							? t("creation.blocked")
							: null;
	return (
		<AppView className="flex-1">
			<AppScrollView
				contentContainerClassName={webView(`${styles.form} ${agentsIndexClasses.page}`)}
			>
				{!compute || !hosted ? (
					<EmptyState
						title={agentSurfaceCopy.unavailable}
						description={t("creation.unavailable")}
					/>
				) : (
					<>
						{storageError ? (
							<AppText className="text-destructive">{t("creation.storageError")}</AppText>
						) : null}
						{action.error ? (
							<AppText className="text-destructive">{t("creation.error")}</AppText>
						) : null}
						{inventory.isError ? <ResourceError missing={false} /> : null}
						{reserved && !resuming ? (
							<Alert icon={Store} title={t("creation.reservedTitle")}>
								<AppText>
									{t("creation.reservedDescription", { store: storeGate.storeName })}
								</AppText>
								<ActionButton
									label={t("creation.reservedAction")}
									className="mt-2 self-start"
									disabled={action.busy}
									onPress={() => {
										setResume(reserved);
										setSource("store");
										setStoreNotice(null);
										update({ computePlanSlug: reserved.planSlug });
									}}
								/>
							</Alert>
						) : null}
						<SettingsSection title={agentSurfaceCopy.agentSoftware}>
							<WebView recipe={ENTITY_CHOICE_GRID_CLASS}>
								{(["hermes", "openclaw"] as const).map((runtime) => (
									<EntityChoiceCard
										key={runtime}
										selected={draft.runtime === runtime}
										disabled={locked}
										onClick={() => {
											const provider =
												draft.ai.mode === "configured"
													? inventory.data?.providers.find(
															(item) =>
																draft.ai.mode === "configured" &&
																item.provider_id === draft.ai.providerId,
														)
													: undefined;
											// Like Web, a saved provider this runtime can't use falls back to Clawdi AI.
											const providerUnusable =
												draft.ai.mode === "configured" &&
												(!provider ||
													providerAvailabilityIssue(provider, {
														runtime,
														environmentId: null,
													}) !== null);
											if (providerUnusable) setProviderChoice("__managed__");
											update({
												runtime,
												agentName: hostedDeployAgentNameAfterRuntimeChange({
													currentName: draft.agentName,
													hasBeenEdited:
														draft.agentName !== hostedDeployRuntimeLabel(draft.runtime),
													runtime,
												}),
												...(providerUnusable
													? {
															ai: {
																mode: "managed" as const,
																model: firstModelForProvider("__managed__", [], models),
															},
														}
													: {}),
											});
										}}
										title={hostedDeployRuntimeLabel(runtime)}
										description={runtimeBlurb(runtime)}
										icon={
											<EntityIcon
												kind="framework"
												id={runtime}
												label={hostedDeployRuntimeLabel(runtime)}
											/>
										}
										badge={
											runtime === "hermes" ? (
												<Badge variant="secondary">
													<AppText>{agentSurfaceCopy.recommended}</AppText>
												</Badge>
											) : undefined
										}
									/>
								))}
							</WebView>
						</SettingsSection>
						<SettingsSection title={agentSurfaceCopy.aIProviders2}>
							<AiBindingChoices
								providers={inventory.data?.providers ?? []}
								models={models}
								choice={providerChoice}
								model={selectedModel}
								disabled={locked || inventory.isPending}
								runtime={draft.runtime}
								recommended
								onChoice={(choice) => {
									setProviderChoice(choice);
									const providers = inventory.data?.providers ?? [];
									update({
										ai:
											choice === "__managed__"
												? { mode: "managed", model: firstModelForProvider(choice, [], models) }
												: choice === "__unmanaged__"
													? { mode: "unmanaged" }
													: {
															mode: "configured",
															providerId: choice,
															// Web binds a saved provider's first catalog model.
															model: firstModelForProvider(choice, providers, models),
														},
									});
								}}
								onModel={(model) => update({ ai: { mode: "managed", model } })}
								onAdd={() => router.push("/ai-providers")}
								addProvider={
									<ProviderCreate
										providers={inventory.data?.providers}
										renderTrigger={(open) => (
											<EntityAddCard
												title={aiBindingCopy.addProvider}
												description={aiBindingCopy.addProviderDescription}
												onClick={open}
											/>
										)}
									/>
								}
								onRetry={() => void inventory.refetch()}
								error={inventory.error}
							/>
						</SettingsSection>
						<SettingsSection title={agentSurfaceCopy.compute}>
							<WebView recipe={styles.compute}>
								<WebView recipe={subscriptionSourcePickerClasses.grid}>
									{inventory.data?.included.available_slots ? (
										<EntityChoiceCard
											selected={source === "included"}
											disabled={locked || resuming !== null}
											onClick={() => {
												setSource("included");
												setSubscriptionId(null);
												update({ computePlanSlug: "compute_basic" });
											}}
											icon={
												<IconChip tint={hostedAgentOverviewClasses.includedTint}>
													<Icon as={Cpu} />
												</IconChip>
											}
											title={subscriptionSourceCopy.includedTitle}
											description={subscriptionSourceCopy.includedDescription}
											badge={
												<Badge variant="secondary">
													<AppText>{subscriptionSourceCopy.included}</AppText>
												</Badge>
											}
											details={
												<AppText>
													{surfaces.creditUnits ? t("store.dueNow") : subscriptionSourceCopy.dueNow}
												</AppText>
											}
											className={webView(subscriptionSourcePickerClasses.choice)}
										/>
									) : null}
									{reusableItems.map((item) => {
										const view = reusableSubscriptionChoiceView(item);
										const performance = item.plan_slug === "compute_performance";
										return (
											<EntityChoiceCard
												key={item.subscription_id}
												selected={source === "existing" && subscriptionId === item.subscription_id}
												disabled={locked || resuming !== null}
												onClick={() => {
													setSource("existing");
													setSubscriptionId(item.subscription_id);
													update({ computePlanSlug: item.plan_slug });
												}}
												icon={
													<IconChip
														size="sm"
														tint={
															performance
																? styles.performanceTint
																: hostedAgentOverviewClasses.includedTint
														}
													>
														<Icon as={performance ? Zap : Cpu} />
													</IconChip>
												}
												title={
													performance ? agentSurfaceCopy.performance : t("billingParity.basic")
												}
												// Web says store rows are "available in the Clawdi app"; here every row is.
												description={
													surfaces.creditUnits ? t("store.dueNow") : subscriptionSourceCopy.dueNow
												}
												badge={
													<StatusBadge status={view.status.tone}>
														<AppText>{view.status.label}</AppText>
													</StatusBadge>
												}
												detailsPlacement="responsive"
												details={
													// Web's two-column grid: RN has no CSS grid, so facts wrap at just under
													// half width (the column gap counts toward each line).
													<WebView
														recipe={subscriptionSourcePickerClasses.existingFacts}
														className="flex-row flex-wrap"
													>
														{view.facts.map((fact) => (
															<WebView
																key={fact.id}
																recipe={subscriptionSourcePickerClasses.fact}
																className="basis-[45%] grow"
															>
																<WebText recipe={subscriptionSourcePickerClasses.factLabel}>
																	{fact.label}
																</WebText>
																{fact.id === "payment" ? (
																	<WebView
																		recipe={subscriptionSourcePickerClasses.payment}
																		className="flex-row"
																	>
																		<WebIcon
																			as={
																				view.payment.kind === "store"
																					? Smartphone
																					: view.payment.kind === "wallet"
																						? WalletCards
																						: CreditCard
																			}
																			recipe={subscriptionSourcePickerClasses.paymentIcon}
																		/>
																		<WebText recipe={subscriptionSourcePickerClasses.price}>
																			{fact.value}
																		</WebText>
																	</WebView>
																) : (
																	<WebText
																		recipe={
																			fact.id === "price"
																				? subscriptionSourcePickerClasses.nowrap
																				: subscriptionSourcePickerClasses.factValue
																		}
																	>
																		{fact.id === "price" && surfaces.creditUnits
																			? (creditPrice(item, credits) ?? fact.value)
																			: fact.value}
																	</WebText>
																)}
															</WebView>
														))}
													</WebView>
												}
												className={webView(subscriptionSourcePickerClasses.choice)}
											/>
										);
									})}
									{storeGate.available || source === "store" ? (
										<EntityChoiceCard
											selected={source === "store"}
											disabled={locked || !storeGate.available}
											onClick={() => {
												setSource("store");
												setSubscriptionId(null);
												setStoreNotice(null);
											}}
											icon={
												<IconChip tint={hostedAgentOverviewClasses.browserTint}>
													<Icon as={Store} />
												</IconChip>
											}
											title={t(
												resuming ? "storeCompute.slotTitle" : "storeCompute.subscribeTitle",
												{
													store: storeGate.storeName,
												},
											)}
											description={
												resuming
													? t("storeCompute.slotAvailable")
													: t("storeCompute.subscribeDescription", { store: storeGate.storeName })
											}
											className={webView(subscriptionSourcePickerClasses.choice)}
										/>
									) : null}
									<EntityChoiceCard
										selected={source === "new"}
										disabled={
											locked || resuming !== null || inventory.isPending || reusable.isPending
										}
										onClick={() => {
											setSource("new");
											setSubscriptionId(null);
											setQuoteSelection(
												quoteOptions.find(
													(option) =>
														option.planSlug === draft.computePlanSlug &&
														option.billingTermMonths === 1,
												) ??
													quoteOptions[0] ??
													null,
											);
										}}
										icon={
											<IconChip>
												<Icon as={Plus} />
											</IconChip>
										}
										title={subscriptionSourceCopy.newTitle}
										description={subscriptionSourceCopy.newDescription}
										className={webView(subscriptionSourcePickerClasses.choice)}
									/>
								</WebView>
								{inventory.isError ? (
									<ApiErrorPanel error={inventory.error} onRetry={() => void inventory.refetch()} />
								) : null}
								{reusable.isError ? (
									<ApiErrorPanel error={reusable.error} onRetry={() => void reusable.refetch()} />
								) : null}
								{reusable.hasNextPage ? (
									<ActionButton
										label={t("inventory.loadMore")}
										disabled={reusable.isFetching || action.busy}
										onPress={() => void reusable.fetchNextPage()}
									/>
								) : null}
								{source === "store" ? (
									<WebView recipe={styles.compute}>
										<AppText>
											{resuming
												? t("creation.reservedNotice", { store: storeGate.storeName })
												: t("storeCompute.autoRenew", { store: storeGate.storeName })}
										</AppText>
										{attempt?.storeFunding === "purchase_pending" ? (
											<AppText accessibilityRole="alert">
												{t("storeCompute.waitingForApproval")}
											</AppText>
										) : attempt?.storeFunding === "review_required" ? (
											<AppText accessibilityRole="alert">{t("storeCompute.underReview")}</AppText>
										) : null}
										{storeNotice ? <StoreNoticeText notice={storeNotice} /> : null}
									</WebView>
								) : null}
								{source === "new" ? (
									<WebView recipe={styles.compute}>
										{/* Web caps the term switcher at max-w-xs; the native control spans the form like plan comparison. */}
										<WebView recipe={styles.billingTermLayout}>
											<WebText recipe={styles.fieldLabel}>{deployFormCopy.billingTerm}</WebText>
											<AppView className="w-full">
												<NativeSegments
													value={String(previewTerm)}
													options={billingOffers.map((offer) => ({
														value: String(offer.billing_term_months),
														label:
															offer.discount_percent > 0
																? `${billingTermLabel(offer.billing_term_months)} −${offer.discount_percent}%`
																: billingTermLabel(offer.billing_term_months),
													}))}
													onChange={(value) => {
														const term = Number(value);
														const option = quoteOptions.find(
															(option) =>
																option.planSlug === draft.computePlanSlug &&
																option.billingTermMonths === term,
														);
														if (option) {
															setPreviewTerm(term);
															setQuoteSelection({
																...option,
																fundingSource: quoteSelection?.fundingSource ?? fundingDefault,
															});
														}
													}}
												/>
											</AppView>
										</WebView>
										<WebView recipe={ENTITY_CHOICE_GRID_CLASS}>
											{(
												[
													{
														plan: comparison.basic,
														price: comparison.basicPrice,
														slug: "compute_basic",
														icon: Cpu,
													},
													{
														plan: comparison.performance,
														price: comparison.performancePrice,
														slug: "compute_performance",
														icon: Zap,
													},
												] as const
											).map(({ plan, price, slug, icon }) => (
												<EntityChoiceCard
													key={slug}
													selected={draft.computePlanSlug === slug}
													disabled={locked || !plan || !price}
													className={webView(styles.computeChoice)}
													title={
														slug === "compute_basic"
															? t("billingParity.basic")
															: agentSurfaceCopy.performance
													}
													icon={
														<IconChip
															size="sm"
															tint={
																slug === "compute_basic"
																	? hostedAgentOverviewClasses.includedTint
																	: styles.performanceTint
															}
														>
															<Icon as={icon} />
														</IconChip>
													}
													description={
														<WebText recipe={styles.specs}>
															{plan
																? deployComputeResourceLabels(
																		plan.vcpu,
																		plan.ram_gb,
																		plan.disk_size,
																	).join(" · ")
																: agentSurfaceCopy.unavailable}
														</WebText>
													}
													detailsPlacement="trailing"
													details={
														price ? (
															<WebView recipe={styles.planPrice}>
																<WebText recipe={styles.planPriceValue}>{price.primary}</WebText>
																<WebText recipe={styles.planPriceMeta}>
																	{price.secondary}
																	{price.savings ? ` · ${price.savings}` : ""}
																</WebText>
															</WebView>
														) : undefined
													}
													onClick={() => {
														const option = quoteOptions.find(
															(option) =>
																option.planSlug === slug &&
																option.billingTermMonths === previewTerm,
														);
														if (option) {
															update({ computePlanSlug: slug });
															setQuoteSelection({
																...option,
																fundingSource: quoteSelection?.fundingSource ?? fundingDefault,
															});
														}
													}}
												/>
											))}
										</WebView>
										<WebView recipe={styles.paymentMethods}>
											<WebText recipe={styles.fieldTitle}>{deployFormCopy.paymentMethod}</WebText>
											<WebView recipe={ENTITY_CHOICE_GRID_CLASS}>
												{(
													[
														{
															source: "stripe",
															title: deployFormCopy.cardTitle,
															description: deployFormCopy.cardDescription,
															icon: CreditCard,
														},
														{
															source: "wallet",
															title: deployFormCopy.walletTitle,
															description: deployFormCopy.walletDescription,
															icon: WalletCards,
														},
													] as const
												)
													.filter((payment) => surfaces.cardBilling || payment.source === "wallet")
													.map((payment) => (
														<EntityChoiceCard
															key={payment.source}
															selected={quoteSelection?.fundingSource === payment.source}
															disabled={locked || !quoteSelection}
															title={payment.title}
															description={payment.description}
															icon={
																<IconChip
																	tint={
																		payment.source === "stripe"
																			? hostedAgentOverviewClasses.mutedTint
																			: hostedAgentOverviewClasses.browserTint
																	}
																>
																	<Icon as={payment.icon} />
																</IconChip>
															}
															onClick={() => {
																if (quoteSelection) {
																	setQuoteSelection({
																		...quoteSelection,
																		fundingSource: payment.source,
																	});
																}
															}}
														/>
													))}
											</WebView>
										</WebView>
										{walletQuoteSelection && quote.isError ? (
											<ApiErrorPanel error={quote.error} onRetry={() => void quote.refetch()} />
										) : walletDebit ? (
											<WalletDebitEquation debit={walletDebit} format={formatWalletAmount} />
										) : null}
										{shortfall && surfaces.addCredits ? (
											<>
												<AppText>
													{t("store.shortfall", { amount: formatWalletAmount(shortfall) })}
												</AppText>
												<AddCreditsAction onFunded={() => void quote.refetch()} />
											</>
										) : null}
									</WebView>
								) : null}
							</WebView>
						</SettingsSection>
						<SettingsSection title={agentSurfaceCopy.personalize}>
							<WebView recipe={styles.personalize} className="items-stretch">
								<AppText>{deployFormCopy.name}</AppText>
								<AppTextInput
									accessibilityLabel={deployFormCopy.name}
									value={draft.agentName}
									editable={!locked}
									maxLength={64}
									onChangeText={(agentName) => update({ agentName })}
								/>
								<AppText>{t("creation.language")}</AppText>
								<NativePicker
									value={draft.language}
									options={[
										{ value: "", label: agentSurfaceCopy.default },
										...HOSTED_DEPLOY_LANGUAGE_OPTIONS.map((language) => ({
											value: language.code,
											label: language.label,
										})),
									]}
									disabled={locked}
									onValueChange={(language) => {
										if (
											language === "" ||
											HOSTED_DEPLOY_LANGUAGE_OPTIONS.some((option) => option.code === language)
										)
											update({ language });
									}}
								/>
								<AppText>{deployFormCopy.timezone}</AppText>
								{/* Hundreds of IANA zones: region submenus keep the native menu short. */}
								<Select
									value={draft.timezone}
									disabled={locked}
									onValueChange={(timezone) => {
										if (isValidTimezone(timezone)) update({ timezone });
									}}
								>
									<SelectTrigger className="w-full">
										<SelectValue placeholder={t("creation.selectTimezone")} />
									</SelectTrigger>
									<SelectContent>
										{timezoneMenuGroups(timezoneOptions).map(([region, zones]) =>
											region ? (
												<SelectSub key={region} label={region}>
													{zones.map((zone) => (
														<SelectItem key={zone} value={zone} label={timezoneLabel(zone)}>
															{timezoneLabel(zone)}
														</SelectItem>
													))}
												</SelectSub>
											) : (
												zones.map((zone) => (
													<SelectItem key={zone} value={zone} label={timezoneLabel(zone)}>
														{timezoneLabel(zone)}
													</SelectItem>
												))
											),
										)}
									</SelectContent>
								</Select>
							</WebView>
						</SettingsSection>
						{message ? <AppText>{message}</AppText> : null}
						{attempt ? (
							<>
								<AppText>{t("creation.saved")}</AppText>
								{/* Only a sent admission can be recovered; store funding uses the footer Check status. */}
								{attempt.submission === "uncertain" ? (
									<ActionButton
										label={t("creation.recover")}
										disabled={action.busy}
										onPress={() => {
											void action.run((owns) => navigateRequest(attempt.id, owns));
										}}
									/>
								) : null}
								{resolved ||
								(canDiscardCreationAttempt(attempt) && !storeFundingHoldsAttempt(attempt)) ? (
									<ActionButton
										label={t(resolved ? "creation.clear" : "creation.discard")}
										disabled={action.busy}
										onPress={() => {
											void action.run(async (owns) => {
												if (!storageKey) return;
												await clearAttempt(storageKey, attempt, () => current(owns));
												if (current(owns)) {
													setAttempt(null);
													setDraft(newDraft());
													setSource(null);
													setSubscriptionId(null);
													setProviderChoice("__managed__");
													setResolved(false);
													setMessage("");
												}
											});
										}}
									/>
								) : null}
							</>
						) : null}
					</>
				)}
			</AppScrollView>
			{compute && hosted ? (
				<WebView recipe={styles.actionBarSurface}>
					<WebText recipe={styles.configurationSummary}>
						{deployConfigurationSummary(
							hostedDeployRuntimeLabel(draft.runtime),
							providerChoice === "__unmanaged__"
								? aiBindingCopy.unmanaged
								: [
										providerChoice === "__managed__"
											? aiBindingCopy.managed
											: providerDisplayLabel(providerChoice, inventory.data?.providers ?? []),
										selectedModel
											? modelDisplayName(
													selectedModel,
													modelOptionsForProvider(
														providerChoice,
														inventory.data?.providers ?? [],
														models,
													),
												)
											: null,
									]
										.filter(Boolean)
										.join(" · "),
							draft.computePlanSlug === "compute_performance"
								? agentSurfaceCopy.performance
								: t("billingParity.basic"),
						)}
					</WebText>

					{source === "new" && quoteSelection?.fundingSource === "stripe" && amount ? (
						<WebView recipe={styles.amount}>
							<WebText recipe={styles.amountValue}>{amount.amount}</WebText>
							{amount.caption ? (
								<WebText recipe={styles.amountCaption}>{amount.caption}</WebText>
							) : null}
						</WebView>
					) : walletAmount ? (
						<WebView recipe={styles.amount} accessibilityLiveRegion="polite">
							<WebText recipe={styles.amountValue}>{walletAmount.amount}</WebText>
							{walletAmount.caption ? (
								<WebText recipe={styles.amountCaption}>{walletAmount.caption}</WebText>
							) : null}
							{walletAmount.detail ? (
								<WebText recipe={styles.amountError}>{walletAmount.detail}</WebText>
							) : null}
						</WebView>
					) : null}
					{source === "included" || source === "existing" ? (
						<WebText recipe={styles.amountValue}>
							{source === "included"
								? t("labels.free")
								: surfaces.creditUnits
									? t("store.dueNow")
									: subscriptionSourceCopy.dueNow}
						</WebText>
					) : null}

					{source === "store" &&
					(attempt?.storeFunding === "purchase_pending" ||
						attempt?.storeFunding === "review_required") ? (
						<ActionButton
							label={t(action.busy ? "storeCompute.checkingStatus" : "storeCompute.checkStatus")}
							icon={<Icon as={Store} />}
							variant="default"
							disabled={action.busy || !storageReady || storageError}
							onPress={() => {
								void checkStoreFunding();
							}}
						/>
					) : source === "store" && !storeAdmission ? (
						<ActionButton
							label={action.busy ? t("storeCompute.purchasing") : t("storeCompute.subscribeDeploy")}
							icon={<Icon as={Store} />}
							variant="default"
							disabled={
								action.busy ||
								resolved ||
								personaIssue !== undefined ||
								!storeGate.available ||
								!canStartStorePurchase(attempt) ||
								!storageReady ||
								storageError ||
								inventory.isError
							}
							onPress={() => {
								void subscribe();
							}}
						/>
					) : (
						<ActionButton
							label={
								attempt
									? t("creation.retry")
									: resuming
										? t("creation.reservedAction")
										: deployFormCopy.deploy
							}
							icon={<Icon as={Rocket} />}
							variant="default"
							disabled={
								action.busy ||
								resolved ||
								(!attempt &&
									(personaIssue !== undefined ||
										(source !== "included" &&
											!(source === "existing" && selectedReusable) &&
											!storeAdmission))) ||
								!eligible ||
								!storageReady ||
								storageError ||
								inventory.isError
							}
							onPress={() => {
								void create();
							}}
						/>
					)}
					{blockingReason ? (
						<WebText
							recipe={`${styles.blockingReason} ${styles.configurationSummary}`}
							accessibilityRole="text"
						>
							{blockingReason}
						</WebText>
					) : null}
				</WebView>
			) : null}
		</AppView>
	);
}
