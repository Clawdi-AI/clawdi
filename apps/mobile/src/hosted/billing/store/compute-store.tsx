import type { DeploymentRead, StoreComputeSlot, StorePlatform } from "@clawdi/shared/api";
import {
	agentDisplayName,
	billingTermLabel,
	CLAWDI_LEGAL_URLS,
	computeFundingMode,
	computeSubscriptionPlanLabel,
	resolveStoreSubscriptionActions,
	type StoreManagement,
	storeBillingNotice,
	storeProviderLabel,
	storeRenewalIssue,
	storeSubscriptionCopy,
	storeSubscriptionSchedule,
	storeSubscriptionStatus,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, RotateCcw, Settings, TriangleAlert } from "lucide-react-native";
import { useState } from "react";
import { Linking, Platform } from "react-native";
import type { PurchasesPackage } from "react-native-purchases";
import RevenueCatUI from "react-native-purchases-ui";
import { EntityCardChassis, EntityChoiceCard } from "@/components/entity-card";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RichConfirmAction } from "@/components/ui/confirm-action";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import type { Subscription } from "@/hosted/billing/format";
import {
	computePurchaseErrorNotice,
	computePurchaseNotice,
	restorePurchasesNotices,
	type StoreNotice,
	storeContractIdForRow,
} from "@/hosted/billing/store/store-presentation";
import { useMobileRuntimeConfig } from "@/lib/config/runtime";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { runComputePaywall } from "@/platform/store/compute-paywall";
import { computeProductPlan } from "@/platform/store/compute-subscription";
import { usePaywall } from "@/platform/store/paywall-host";
import type { PurchaseOutcome } from "@/platform/store/purchase-flow";
import { StorePurchaseError, storePurchaseError } from "@/platform/store/store-error";
import { resolveStoreManagement } from "@/platform/store/store-management";
import { computePurchaseAvailable } from "@/platform/store/store-policy";
import {
	type ComputeSubscriptionPurchaseRequest,
	useMobileStore,
} from "@/platform/store/store-provider";
import { useForegroundLease } from "@/platform/use-foreground-lease";

/** The store that bills purchases made on this device. */
export function currentStorePlatform(): StorePlatform | null {
	return Platform.OS === "ios" ? "app_store" : Platform.OS === "android" ? "play_store" : null;
}

function storeName(platform: StorePlatform | null): string {
	return platform
		? storeSubscriptionCopy.providers[platform]
		: storeSubscriptionCopy.unknownProvider;
}

export function StoreNoticeText({ notice }: { notice: StoreNotice }) {
	const t = useI18n();
	return (
		<Text
			accessibilityRole={notice.tone === "warning" ? "alert" : undefined}
			className={
				notice.tone === "success" ? "text-success-muted-foreground" : "text-muted-foreground"
			}
		>
			{t(notice.key, notice.values)}
		</Text>
	);
}

/** Store data that may change after a compute purchase, restore or plan change. */
function useRefreshCompute() {
	const cache = useQueryClient();
	const scope = useAccountScope();
	return () =>
		Promise.all(
			(["billing-subscriptions", "deployments", "deployment", "creation-reusable"] as const).map(
				(key) => cache.invalidateQueries({ queryKey: accountQueryKey(scope, key) }),
			),
		);
}

/**
 * M1 gate for new compute purchases: a store build, the hosted switch, an available
 * store slot, the loaded `compute` offering and the Paywall host.
 */
export function useComputePurchaseGate() {
	const store = useMobileStore();
	const present = usePaywall();
	const config = useMobileRuntimeConfig();
	const platform = currentStorePlatform();
	const available = Boolean(
		config.ok &&
			platform &&
			store.flow &&
			present &&
			store.computeOffering &&
			computePurchaseAvailable(config.value, {
				compute_subscriptions_enabled: store.computeSubscriptionsEnabled,
				compute_slot: store.computeSlot,
			}),
	);
	return { available, platform, storeName: storeName(platform) };
}

/**
 * Runs the official Paywall for the `compute` offering through the M1 purchase flow.
 * `target` turns the Paywall-selected package into the attempt target (and may persist
 * a draft first); it runs before the attempt is created.
 */
export function useComputePaywallPurchase() {
	const store = useMobileStore();
	const present = usePaywall();
	const scope = useAccountScope();
	return async (
		target: (
			selected: PurchasesPackage,
		) => Promise<Omit<ComputeSubscriptionPurchaseRequest, "selection" | "store_product_id">>,
	): Promise<PurchaseOutcome | null> => {
		const offering = store.computeOffering;
		if (!present || !offering) throw new StorePurchaseError("store_offering_unavailable");
		return runComputePaywall({
			offering,
			present,
			signal: scope.signal,
			purchase: async (selected, paywall) =>
				store.purchaseComputeSubscription({
					...(await target(selected)),
					store_product_id: selected.product.identifier,
					selection: { kind: "paywall", package: selected, purchase: paywall },
				}),
		});
	};
}

/** Agent → Compute on Included Basic: upgrade through the store Paywall. */
export function StoreUpgradeAction({ deployment }: { deployment: DeploymentRead }) {
	const t = useI18n();
	const scope = useAccountScope();
	const gate = useComputePurchaseGate();
	const purchase = useComputePaywallPurchase();
	const refresh = useRefreshCompute();
	const action = useAuthAction(scope);
	const [notice, setNotice] = useState<StoreNotice | null>(null);
	const subscription = deployment.commercial_display?.compute_subscription;
	// Card/Wallet and store-funded Agents never see this entry; the server would refuse it.
	if (computeFundingMode(deployment.current_plan_slug, subscription) !== "included_basic")
		return null;
	if (!gate.available && !notice) return null;
	const upgrade = () =>
		action.run(async (owns) => {
			setNotice(null);
			let next: StoreNotice | null;
			try {
				const outcome = await purchase(async () => ({
					target_deployment_id: deployment.resource.id,
				}));
				next = outcome ? computePurchaseNotice(outcome, null, "upgrade", gate.storeName) : null;
			} catch (error) {
				next = computePurchaseErrorNotice(
					storePurchaseError(error).code,
					"upgrade",
					gate.storeName,
				);
			}
			if (!owns()) return;
			setNotice(next);
			if (next?.refresh) await refresh();
		});
	return (
		<AppView className="gap-2">
			<Text className="text-muted-foreground">
				{t("storeCompute.upgradeDescription", { store: gate.storeName })}
			</Text>
			<Button
				size="sm"
				disabled={!gate.available || action.busy}
				onPress={() => void upgrade()}
				accessibilityLabel={t("storeCompute.upgrade", { store: gate.storeName })}
			>
				<Icon as={ArrowUp} />
				<Text>
					{action.busy
						? t("storeCompute.purchasing")
						: t("storeCompute.upgrade", { store: gate.storeName })}
				</Text>
			</Button>
			{notice ? <StoreNoticeText notice={notice} /> : null}
		</AppView>
	);
}

function openUrl(url: string | null) {
	return url ? Linking.openURL(url).then(() => undefined) : Promise.resolve();
}

/** Customer Center when enabled, otherwise the official store management page. */
function ManageStoreSubscriptionAction({ management }: { management: StoreManagement }) {
	const t = useI18n();
	const scope = useAccountScope();
	const store = useMobileStore();
	const capture = useForegroundLease();
	const action = useAuthAction(scope);
	const platform = currentStorePlatform();
	if (!platform) return null;
	const controller = store.management;
	const resolution = resolveStoreManagement(
		management,
		platform,
		store.customerCenterEnabled && controller !== null,
	);
	if (!resolution.canManageInApp && !resolution.managementUrl) return null;
	const manage = () => {
		const visible = capture();
		return action.run(async (owns) => {
			if (!owns() || !visible()) return;
			const link = () => openUrl(resolution.managementUrl);
			if (resolution.canManageInApp && controller)
				await controller.openCustomerCenter(
					() => RevenueCatUI.presentCustomerCenter(),
					link,
					scope.signal,
				);
			else if (platform === "app_store" && controller)
				await controller.openAppleManagement(link, scope.signal);
			else await link();
		});
	};
	return (
		<Button variant="outline" size="sm" disabled={action.busy} onPress={() => void manage()}>
			<Icon as={Settings} />
			<Text>{t("storeCompute.manage")}</Text>
		</Button>
	);
}

/** Plan change on the billing store: the other compute products at store-local prices. */
function StoreChangePlanAction({
	management,
	contractId,
}: {
	management: StoreManagement;
	contractId: string;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const store = useMobileStore();
	const refresh = useRefreshCompute();
	const action = useAuthAction(scope);
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [notice, setNotice] = useState<StoreNotice | null>(null);
	const platform = currentStorePlatform();
	const name = storeName(platform);
	const products = store.computeProducts.filter(
		(product) => product.productIdentifier !== management.product_id,
	);
	if (!store.flow || !store.computeSubscriptionsEnabled || !products.length) return null;
	const change = (productIdentifier: string) =>
		action.run(async (owns) => {
			const product = products.find((item) => item.productIdentifier === productIdentifier);
			if (!product) return;
			setNotice(null);
			let next: StoreNotice | null;
			try {
				const outcome = await store.purchaseComputeSubscription({
					store_product_id: product.productIdentifier,
					target_contract_id: contractId,
					selection: { kind: "product", productIdentifier: product.productIdentifier },
					oldProductIdentifier: management.product_id,
				});
				next = computePurchaseNotice(outcome, null, "change", name);
			} catch (error) {
				next = computePurchaseErrorNotice(storePurchaseError(error).code, "change", name);
			}
			if (!owns()) return;
			setNotice(next);
			if (next?.refresh) await refresh();
		});
	return (
		<AppView className="gap-2">
			<RichConfirmAction
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) setSelected(null);
				}}
				title={t("storeCompute.changePlan")}
				description={
					<AppView className="gap-3">
						<Text>{t("storeCompute.changePlanDescription", { store: name })}</Text>
						<AppView accessibilityRole="radiogroup" className="gap-2">
							{products.map((product) => {
								const plan = computeProductPlan(product.productIdentifier);
								const label = plan
									? `${computeSubscriptionPlanLabel(plan.planSlug)} · ${billingTermLabel(plan.billingTermMonths)}`
									: product.productIdentifier;
								return (
									<EntityChoiceCard
										key={product.productIdentifier}
										variant="compact"
										selected={selected === product.productIdentifier}
										onClick={() => setSelected(product.productIdentifier)}
										icon={null}
										title={label}
										details={<Text>{product.priceString}</Text>}
										detailsPlacement="trailing"
									/>
								);
							})}
						</AppView>
						<Text className="text-muted-foreground">
							{t("storeCompute.autoRenew", { store: name })}
						</Text>
						{/* App Review requires the EULA and privacy links with the purchase. */}
						<AppView className="flex-row flex-wrap gap-x-4 gap-y-1">
							<Text
								accessibilityRole="link"
								className="text-primary underline"
								onPress={() => void openUrl(CLAWDI_LEGAL_URLS.termsOfUse)}
							>
								{t("storeCompute.termsOfUse")}
							</Text>
							<Text
								accessibilityRole="link"
								className="text-primary underline"
								onPress={() => void openUrl(CLAWDI_LEGAL_URLS.privacyPolicy)}
							>
								{t("storeCompute.privacyPolicy")}
							</Text>
						</AppView>
					</AppView>
				}
				confirmLabel={t("storeCompute.changePlan")}
				onConfirm={() => (selected ? change(selected) : undefined)}
			/>
			<Button
				variant="outline"
				size="sm"
				disabled={action.busy}
				onPress={() => {
					setNotice(null);
					setOpen(true);
				}}
			>
				<Icon as={ArrowUp} />
				<Text>{action.busy ? t("storeCompute.purchasing") : t("storeCompute.changePlan")}</Text>
			</Button>
			{notice ? <StoreNoticeText notice={notice} /> : null}
		</AppView>
	);
}

/** Read-only store billing lines shared with Web (#1767), for the card's notice area. */
export function StoreSubscriptionNotice({
	management,
}: {
	management: StoreManagement | null | undefined;
}) {
	return (
		<AppView className="gap-1">
			<Text className="text-xs text-muted-foreground">{storeBillingNotice(management)}</Text>
			{storeRenewalIssue(management) ? (
				<Text
					accessibilityRole="alert"
					className="text-xs font-medium text-warning-muted-foreground"
				>
					{storeSubscriptionCopy.renewalIssue}
				</Text>
			) : null}
		</AppView>
	);
}

/**
 * Store-funded subscription details: grace/lapse banner and the platform-aware store
 * actions. Stripe actions never apply to these rows.
 */
export function StoreSubscriptionPanel({ item }: { item: Subscription }) {
	const store = useMobileStore();
	const platform = currentStorePlatform();
	const management = item.store_management;
	const resolved =
		store.storeBuild && platform && management
			? resolveStoreSubscriptionActions({ management, platform })
			: { actions: [], managedElsewhere: null };
	const contractId = storeContractIdForRow(item, store.computeSlot);
	return (
		<AppView className="gap-3">
			{storeRenewalIssue(management) ? (
				<Alert
					icon={TriangleAlert}
					title={storeSubscriptionStatus(management, { label: "", tone: "warning" }).label}
				>
					{storeSubscriptionCopy.renewalIssue}
				</Alert>
			) : null}
			<Text className="text-muted-foreground">{storeBillingNotice(management)}</Text>
			{resolved.managedElsewhere ? (
				<Text className="text-muted-foreground">
					{storeSubscriptionCopy.managedElsewhere[resolved.managedElsewhere]}
				</Text>
			) : null}
			{management && resolved.actions.length ? (
				<AppView className="gap-2">
					{resolved.actions.includes("change_store_plan") && contractId ? (
						<StoreChangePlanAction management={management} contractId={contractId} />
					) : null}
					{resolved.actions.includes("manage_store_subscription") ? (
						<ManageStoreSubscriptionAction management={management} />
					) : null}
				</AppView>
			) : null}
		</AppView>
	);
}

/** Billing screen: the store slot and "Restore purchases", only while the switch is on. */
export function StoreComputeBillingSection() {
	const t = useI18n();
	const scope = useAccountScope();
	const store = useMobileStore();
	const refresh = useRefreshCompute();
	const action = useAuthAction(scope);
	const [notices, setNotices] = useState<StoreNotice[]>([]);
	const platform = currentStorePlatform();
	const name = storeName(platform);
	if (!store.storeBuild || !store.computeSubscriptionsEnabled) return null;
	const restore = () =>
		action.run(async (owns) => {
			setNotices([]);
			let next: StoreNotice[];
			try {
				next = restorePurchasesNotices(await store.restorePurchases(), name);
			} catch {
				next = [{ key: "storeCompute.restoreFailed", tone: "warning", refresh: false }];
			}
			if (!owns()) return;
			setNotices(next);
			if (next.some((notice) => notice.refresh)) await refresh();
		});
	return (
		<AppView className="gap-3">
			{store.computeSlot && !store.computeSlot.available ? (
				<StoreSlotCard slot={store.computeSlot} />
			) : null}
			<Button
				variant="outline"
				size="sm"
				disabled={!store.flow || action.busy}
				onPress={() => void restore()}
			>
				<Icon as={RotateCcw} />
				<Text>{t(action.busy ? "storeCompute.restoring" : "storeCompute.restore")}</Text>
			</Button>
			{notices.map((notice) => (
				<StoreNoticeText key={notice.key} notice={notice} />
			))}
		</AppView>
	);
}

function StoreSlotCard({ slot }: { slot: StoreComputeSlot }) {
	const t = useI18n();
	const { inventory } = useDashboardAgents();
	const management = slot.store_management;
	const plan = management ? computeProductPlan(management.product_id) : null;
	const deployment = slot.agent_id
		? inventory.data?.find((item) => item.resource.id === slot.agent_id)
		: undefined;
	const status = storeSubscriptionStatus(management, { label: "", tone: "neutral" });
	return (
		<EntityCardChassis variant="compact" className="gap-2">
			<AppView className="flex-row items-center justify-between gap-2">
				<Text className="font-medium text-foreground">
					{t("storeCompute.slotTitle", { store: storeProviderLabel(management) })}
				</Text>
				{status.label ? (
					<StatusBadge status={status.tone} withDot>
						<Text>{status.label}</Text>
					</StatusBadge>
				) : null}
			</AppView>
			{plan ? (
				<Text className="text-muted-foreground">
					{`${computeSubscriptionPlanLabel(plan.planSlug)} · ${billingTermLabel(plan.billingTermMonths)} · ${storeSubscriptionSchedule(management)}`}
				</Text>
			) : null}
			<Text>
				{slot.agent_id
					? t("storeCompute.slotBound", {
							agent: deployment
								? agentDisplayName({
										name: deployment.resource.name,
										agent_type: deployment.resource.spec.runtime,
									})
								: t("billing.unknown"),
						})
					: t("storeCompute.slotAvailable")}
			</Text>
		</EntityCardChassis>
	);
}
