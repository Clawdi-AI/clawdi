import {
	buildHostedDeploySubscriptionQuoteRequest,
	HOSTED_DEPLOY_LANGUAGE_OPTIONS,
	type HostedDeploySubscriptionQuote,
	type HostedDeploySubscriptionSelection,
	type HostedDeployWizardDraft,
	hostedDeployAgentNameAfterRuntimeChange,
	hostedDeployRuntimeLabel,
	projectHostedDeployRequest,
	validateAndBuildHostedDeployRequest,
} from "@clawdi/shared/api";
import {
	agentsIndexClasses,
	hostedAgentOverviewClasses,
	deployWizardClasses as styles,
	subscriptionSourcePickerClasses,
	termSwitcherClasses,
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
	firstModelForProvider,
	modelDisplayName,
	modelOptionsForProvider,
	providerDisplayLabel,
	runtimeBlurb,
	subscriptionSourceCopy,
} from "@clawdi/shared/view";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { useRouter } from "expo-router";
import { Cpu, CreditCard, Plus, Rocket, WalletCards, Zap } from "lucide-react-native";
import { useEffect, useState } from "react";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useMobileApi } from "../../providers/api-provider";
import { AddAgentSetup } from "../../ui/agents/add-agent-setup";
import { AiBindingChoices } from "../../ui/agents/ai-binding-choices";
import {
	ActionButton as NativeButton,
	ChoiceSelect as NativePicker,
	NativeSwitch,
} from "../../ui/agents/controls";
import { SettingsSection } from "../../ui/agents/settings-section";
import { ApiErrorPanel } from "../../ui/api-error-panel";
import { Badge } from "../../ui/badge";
import { EmptyState } from "../../ui/empty-state";
import { ENTITY_CHOICE_GRID_CLASS, EntityAddCard, EntityChoiceCard } from "../../ui/entity-card";
import { EntityIcon } from "../../ui/entity-icon";
import { Icon } from "../../ui/icon";
import { IconChip } from "../../ui/icon-chip";
import { Input as AppTextInput } from "../../ui/input";
import { PageHeader } from "../../ui/page-header";
import { AppText } from "../../ui/primitives";
import { ReadScreen } from "../../ui/read-screen";
import { Tabs, TabsList, TabsTrigger } from "../../ui/tabs";
import { AppScrollView, AppView } from "../../ui/view";
import { WebText, WebView, webView } from "../../ui/web-layout";
import { nextBillingCursor, subscriptionPrice, uniqueBillingItems } from "../billing/helpers";
import { formatDate } from "../cloud-inventory";
import { operationIdFromName } from "../deployments/state";
import { ProviderCreate } from "../provider-create";
import { ResourceError } from "../resource-error";
import {
	type CreationAttempt,
	canDiscardCreationAttempt,
	isDefinitiveAdmissionRejection,
	offeredQuoteSelections,
	serverAllowsEntitledCreation,
	validationTranslationKeys,
} from "./state";
import { clearAttempt, readSavedAttempt, replaceAttempt, saveAttempt } from "./storage";

export { creationEn } from "./en";

const initialDraft: HostedDeployWizardDraft = {
	runtime: "hermes",
	computePlanSlug: "compute_basic",
	agentName: "Hermes",
	language: "en",
	timezone: "UTC",
	ai: { mode: "managed", model: "" },
};

export function CreateAgentScreen() {
	const scope = useAccountScope();
	const [tab, setTab] = useState("connect");
	return (
		<ReadScreen>
			<WebView recipe={agentsIndexClasses.page}>
				<PageHeader title={tab === "deploy" ? agentSurfaceCopy.deployAnAgent : "Add an Agent"} />
				<Tabs value={tab} onValueChange={setTab}>
					<TabsList variant="default">
						<TabsTrigger value="connect">Connect an Agent</TabsTrigger>
						<TabsTrigger value="deploy">{agentSurfaceCopy.deployAnAgent}</TabsTrigger>
					</TabsList>
				</Tabs>
			</WebView>
			{tab === "deploy" ? (
				<CreationForm key={`${scope.accountKey}:${scope.generation}`} />
			) : (
				<AppScrollView contentContainerClassName={webView(agentsIndexClasses.page)}>
					<AddAgentSetup key={`${scope.accountKey}:${scope.generation}`} />
				</AppScrollView>
			)}
		</ReadScreen>
	);
}

function CreationForm() {
	const { compute, hosted, aiProviders } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const t = useI18n();
	const router = useRouter();
	const action = useAuthAction(scope);
	const [draft, setDraft] = useState(initialDraft);
	const [source, setSource] = useState<"included" | "existing" | "new" | null>(null);
	const [providerChoice, setProviderChoice] = useState("__managed__");
	const [previewTerm, setPreviewTerm] = useState(1);
	const [attempt, setAttempt] = useState<CreationAttempt | null>(null);
	const [storageKey, setStorageKey] = useState<string | null>(null);
	const [storageReady, setStorageReady] = useState(false);
	const [storageError, setStorageError] = useState(false);
	const [confirmed, setConfirmed] = useState(false);
	const [message, setMessage] = useState("");
	const [quote, setQuote] = useState<HostedDeploySubscriptionQuote | null>(null);
	const [quoteSelection, setQuoteSelection] = useState<HostedDeploySubscriptionSelection | null>(
		null,
	);
	const [resolved, setResolved] = useState(false);
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
					setProviderChoice(saved.draft.ai.mode === "managed" ? "__managed__" : "__unmanaged__");
					setSource("existing");
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
	const selectedPlan = inventory.data?.plans.find((plan) => plan.slug === draft.computePlanSlug);
	const eligible = serverAllowsEntitledCreation(
		inventory.data?.capabilities,
		inventory.data?.included,
		selectedPlan,
		{ reusable: reusableItems, hasSavedAttempt: Boolean(attempt) },
	);
	const quoteOptions = offeredQuoteSelections(inventory.data?.plans ?? []);
	const quoteAvailable =
		quoteSelection &&
		quoteOptions.some(
			(option) =>
				option.planSlug === quoteSelection.planSlug &&
				option.billingTermMonths === quoteSelection.billingTermMonths,
		);
	const current = (owns: () => boolean) => owns() && scope.isCurrent() && !scope.signal.aborted;
	const navigateRequest = async (id: string, owns: () => boolean) => {
		if (!hosted) throw new Error("Hosted API unavailable");
		const status = await read((s) => hosted.getDeploymentByRequest(id, s));
		if (!current(owns)) return;
		const projection = projectHostedDeployRequest(status);
		if (projection.kind === "terminal" || projection.kind === "deployment") setResolved(true);
		if (projection.kind === "deployment") {
			router.push(`/deployments/${encodeURIComponent(projection.deploymentId)}`);
		} else if (projection.kind === "operation" || projection.kind === "operation_name") {
			const operationId = operationIdFromName(
				projection.kind === "operation" ? projection.operation.name : projection.operationName,
			);
			if (!operationId) throw new Error("Invalid operation name");
			const operation =
				projection.kind === "operation"
					? projection.operation
					: await read((s) => hosted.getOperation(operationId, s));
			if (current(owns))
				router.push(`/deployments/${encodeURIComponent(operation.metadata.deploymentId)}`);
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
				!confirmed ||
				(providerChoice !== "__managed__" && providerChoice !== "__unmanaged__") ||
				(source !== "included" && source !== "existing") ||
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
			const refreshedReusable = attempt
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
						hasSavedAttempt: Boolean(attempt),
					},
				)
			) {
				if (current(owns)) setMessage(t("creation.blocked"));
				return;
			}
			// A saved request is already validated. Catalog changes must not rewrite
			// or prevent same-key replay of an uncertain, previously admitted POST.
			let saved = attempt;
			if (!saved) {
				const validated = validateAndBuildHostedDeployRequest(draft, models);
				if (!validated.ok) {
					setMessage(
						validated.issues.map((issue) => t(validationTranslationKeys[issue.field])).join("\n"),
					);
					return;
				}
				const ai = draft.ai;
				if (ai.mode === "managed" && !models.some((model) => model.id === ai.model)) return;
				const id = Crypto.randomUUID();
				saved = {
					version: 1,
					submission: "prepared",
					id,
					draft,
					request: { ...validated.request, deploy_request_id: id },
				};
			}
			// Persist before POST. A failed write must never fall through to creation.
			if (!attempt) await saveAttempt(storageKey, saved, () => current(owns));
			if (!current(owns)) return;
			setAttempt(saved);
			// Persist uncertainty BEFORE any POST, including an app crash or account switch.
			const submitting: CreationAttempt = { ...saved, submission: "uncertain" };
			await replaceAttempt(storageKey, saved, submitting, () => current(owns));
			if (!current(owns)) return;
			setAttempt(submitting);
			try {
				await read((s) => compute.createEntitledDeployment(submitting.request, submitting.id, s));
			} catch (error) {
				if (current(owns) && isDefinitiveAdmissionRejection(saved, error)) {
					const rejected: CreationAttempt = { ...saved, submission: "entitlement_rejected" };
					await replaceAttempt(storageKey, submitting, rejected, () => current(owns));
					if (current(owns)) {
						setAttempt(rejected);
						setMessage(t("creation.notAdmitted"));
					}
				}
				throw error;
			}
			if (current(owns)) await navigateRequest(saved.id, owns);
		});
	const update = (patch: Partial<HostedDeployWizardDraft>) => {
		setDraft((previous) => ({ ...previous, ...patch }));
		setMessage("");
		setQuote(null);
		setConfirmed(false);
	};
	const locked = action.busy || Boolean(attempt) || !storageReady;

	const comparison = computePlanComparisonView(inventory.data?.plans ?? [], previewTerm);
	const selectedOffer =
		draft.computePlanSlug === "compute_performance"
			? comparison.performanceOffer
			: comparison.basicOffer;
	const amount = selectedOffer ? cardDeployAmountPresentation(selectedOffer) : null;
	const aiSelection = draft.ai;
	const selectedModel =
		aiSelection.mode === "managed" && models.some((model) => model.id === aiSelection.model)
			? aiSelection.model
			: "";
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
						<SettingsSection title={agentSurfaceCopy.agentSoftware}>
							<WebView recipe={ENTITY_CHOICE_GRID_CLASS}>
								{(["hermes", "openclaw"] as const).map((runtime) => (
									<EntityChoiceCard
										key={runtime}
										selected={draft.runtime === runtime}
										disabled={locked}
										onClick={() =>
											update({
												runtime,
												agentName: hostedDeployAgentNameAfterRuntimeChange({
													currentName: draft.agentName,
													hasBeenEdited:
														draft.agentName !== hostedDeployRuntimeLabel(draft.runtime),
													runtime,
												}),
											})
										}
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
									setConfirmed(false);
									if (choice === "__managed__")
										update({
											ai: { mode: "managed", model: firstModelForProvider(choice, [], models) },
										});
									else if (choice === "__unmanaged__") update({ ai: { mode: "unmanaged" } });
								}}
								onModel={(model) => update({ ai: { mode: "managed", model } })}
								onAdd={() => router.push("/ai-providers")}
								addProvider={
									<ProviderCreate
										providers={inventory.data?.providers}
										refresh={async () => {
											const result = await inventory.refetch();
											if (result.isError) throw new Error("Provider inventory unavailable");
										}}
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
							{providerChoice !== "__managed__" && providerChoice !== "__unmanaged__" ? (
								<AppText>{t("creation.savedProviderBoundary")}</AppText>
							) : null}
						</SettingsSection>
						<SettingsSection title={agentSurfaceCopy.compute}>
							<WebView recipe={styles.compute}>
								<WebView recipe={subscriptionSourcePickerClasses.grid}>
									{inventory.data?.included.available_slots ? (
										<EntityChoiceCard
											selected={source === "included"}
											disabled={locked}
											onClick={() => {
												setSource("included");
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
											details={<AppText>{subscriptionSourceCopy.dueNow}</AppText>}
											className={webView(subscriptionSourcePickerClasses.choice)}
										/>
									) : null}
									{reusableItems.length ? (
										<EntityChoiceCard
											selected={source === "existing"}
											disabled={locked}
											onClick={() => {
												setSource("existing");
												update({
													computePlanSlug:
														reusableItems[0]?.plan_slug === "compute_performance"
															? "compute_performance"
															: "compute_basic",
												});
											}}
											icon={
												<IconChip>
													<Icon as={Cpu} />
												</IconChip>
											}
											title={t("creation.reusable")}
											description={t("creation.selectionNotice")}
										/>
									) : null}
									<EntityChoiceCard
										selected={source === "new"}
										disabled={locked || inventory.isPending || reusable.isPending}
										onClick={() => {
											setSource("new");
											setConfirmed(false);
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
									<NativeButton
										label={t("inventory.loadMore")}
										disabled={reusable.isFetching || action.busy}
										onPress={() => void reusable.fetchNextPage()}
									/>
								) : null}
								{source === "new" ? (
									<WebView recipe={styles.compute}>
										<WebView recipe={styles.billingTerm}>
											<WebText recipe={styles.fieldLabel}>{deployFormCopy.billingTerm}</WebText>
											<Tabs
												value={String(previewTerm)}
												onValueChange={(value) => {
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
															fundingSource: quoteSelection?.fundingSource ?? "stripe",
														});
														setQuote(null);
													}
												}}
											>
												<TabsList variant="default">
													{[1, 12].map((term) => (
														<TabsTrigger
															key={term}
															value={String(term)}
															className={webView(termSwitcherClasses.item)}
														>
															{billingTermLabel(term)}
														</TabsTrigger>
													))}
												</TabsList>
											</Tabs>
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
													title={slug === "compute_basic" ? "Basic" : agentSurfaceCopy.performance}
													icon={
														<IconChip
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
														plan
															? deployComputeResourceLabels(
																	plan.vcpu,
																	plan.ram_gb,
																	plan.disk_size,
																).join(" · ")
															: agentSurfaceCopy.unavailable
													}
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
																fundingSource: quoteSelection?.fundingSource ?? "stripe",
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
												).map((payment) => (
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
																setQuote(null);
															}
														}}
													/>
												))}
											</WebView>
										</WebView>
										<AppText>{t("creation.quoteNotice")}</AppText>
										<NativeButton
											label={t("creation.quote")}
											disabled={action.busy || !quoteAvailable || inventory.isError}
											onPress={() => {
												void action.run(async (owns) => {
													if (!quoteSelection || !quoteAvailable) return;
													const result = await read((s) =>
														compute.quoteSubscription(
															buildHostedDeploySubscriptionQuoteRequest(quoteSelection),
															s,
														),
													);
													if (current(owns)) setQuote(result);
												});
											}}
										/>
										{quote ? (
											<AppText>
												{t("creation.preview")}:{" "}
												{subscriptionPrice({
													price_cents: quote.term_price_cents,
													currency: quote.currency,
												}) ?? t("billing.unknown")}{" "}
												· {formatDate(quote.expires_at) ?? t("billing.unknown")}
											</AppText>
										) : null}
									</WebView>
								) : null}
							</WebView>
						</SettingsSection>
						<SettingsSection title={agentSurfaceCopy.personalize}>
							<WebView recipe={styles.personalize}>
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
									options={HOSTED_DEPLOY_LANGUAGE_OPTIONS.map((language) => ({
										value: language.code,
										label: language.label,
									}))}
									disabled={locked}
									onValueChange={(language) => {
										if (HOSTED_DEPLOY_LANGUAGE_OPTIONS.some((option) => option.code === language))
											update({ language });
									}}
								/>
								<AppText>{deployFormCopy.timezone}</AppText>
								<AppTextInput
									accessibilityLabel={deployFormCopy.timezone}
									value={draft.timezone}
									editable={!locked}
									autoCapitalize="none"
									onChangeText={(timezone) => update({ timezone })}
								/>
							</WebView>
						</SettingsSection>
						<NativeSwitch
							label={t("creation.confirm")}
							value={confirmed}
							disabled={action.busy || !eligible}
							onValueChange={setConfirmed}
						/>
						{message ? <AppText>{message}</AppText> : null}
						{attempt ? (
							<>
								<AppText>{t("creation.saved")}</AppText>
								<AppText selectable>{attempt.id}</AppText>
								<NativeButton
									label={t("creation.recover")}
									disabled={action.busy}
									onPress={() => {
										void action.run((owns) => navigateRequest(attempt.id, owns));
									}}
								/>
								{resolved || canDiscardCreationAttempt(attempt) ? (
									<NativeButton
										label={t(resolved ? "creation.clear" : "creation.discard")}
										disabled={action.busy}
										onPress={() => {
											void action.run(async (owns) => {
												if (!storageKey) return;
												await clearAttempt(storageKey, attempt, () => current(owns));
												if (current(owns)) {
													setAttempt(null);
													setDraft(initialDraft);
													setSource(null);
													setProviderChoice("__managed__");
													setResolved(false);
													setConfirmed(false);
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
				<WebView recipe={styles.actionBar.replace(/(?:^|\s)-mx-4(?=\s|$)/g, " ")}>
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
								: "Basic",
						)}
					</WebText>

					{source === "new" && quoteSelection?.fundingSource === "stripe" && amount ? (
						<WebView recipe={styles.amount}>
							<WebText recipe={styles.amountValue}>{amount.amount}</WebText>
							{amount.caption ? (
								<WebText recipe={styles.amountCaption}>{amount.caption}</WebText>
							) : null}
						</WebView>
					) : null}
					{source === "included" || source === "existing" ? (
						<WebText recipe={styles.amountValue}>
							{source === "included" ? "Free" : subscriptionSourceCopy.dueNow}
						</WebText>
					) : null}

					<NativeButton
						label={attempt ? t("creation.retry") : deployFormCopy.deploy}
						icon={<Icon as={Rocket} />}
						variant="default"
						disabled={
							action.busy ||
							resolved ||
							!confirmed ||
							(providerChoice !== "__managed__" && providerChoice !== "__unmanaged__") ||
							(source !== "included" && source !== "existing") ||
							!eligible ||
							!storageReady ||
							storageError ||
							inventory.isError
						}
						onPress={() => {
							void create();
						}}
					/>
					{source === null ? (
						<WebText recipe={`${styles.blockingReason} ${styles.configurationSummary}`}>
							{deployFormCopy.chooseSource}
						</WebText>
					) : !eligible ? (
						<AppText>{t("creation.blocked")}</AppText>
					) : null}
				</WebView>
			) : null}
		</AppView>
	);
}
