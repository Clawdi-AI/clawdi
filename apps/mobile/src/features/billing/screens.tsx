import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useMobileApi } from "../../providers/api-provider";
import { ErrorState, LoadingScreen } from "../../ui/feedback";
import { DetailRow } from "../../ui/metadata-row";
import { NativeButton, NativePicker } from "../../ui/native-controls";
import { AppPressable, AppScrollView, AppText, AppView } from "../../ui/primitives";
import { ReadScreen } from "../../ui/read-screen";
import { BackButton, formatDate } from "../cloud-inventory";
import { InventoryList } from "../inventory-list";
import { ResourceError } from "../resource-error";
import {
	exactUsd,
	nextBillingCursor,
	type Subscription,
	subscriptionPrice,
	type Transaction,
	uniqueBillingItems,
	validSubscriptionId,
} from "./helpers";

function initialCursor(): string | undefined {
	return undefined;
}

function useSubscriptions(enabled = true) {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useInfiniteQuery({
		queryKey: accountQueryKey(scope, "billing-subscriptions"),
		initialPageParam: initialCursor(),
		queryFn: ({ signal, pageParam }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getSubscriptions({ limit: 25, cursor: pageParam }, s);
			}, signal),
		getNextPageParam: nextBillingCursor,
		enabled: scope.isReady && Boolean(compute) && enabled,
		retry: false,
	});
}

type Section = "subscriptions" | "transactions";
type BillingRow =
	| { id: string; kind: "subscription"; item: Subscription }
	| { id: string; kind: "transaction"; item: Transaction };

export function BillingScreen() {
	const scope = useAccountScope();
	return <BillingView key={`${scope.accountKey}:${scope.generation}`} />;
}

function BillingView() {
	const t = useI18n();
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const [section, setSection] = useState<Section>("subscriptions");
	const wallet = useQuery({
		queryKey: accountQueryKey(scope, "billing-wallet"),
		queryFn: ({ signal }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getWallet(s);
			}, signal),
		enabled: scope.isReady && Boolean(compute),
		retry: false,
	});
	const subscriptions = useSubscriptions(section === "subscriptions");
	const transactions = useInfiniteQuery({
		queryKey: accountQueryKey(scope, "billing-transactions"),
		initialPageParam: initialCursor(),
		queryFn: ({ signal, pageParam }) =>
			read((s) => {
				if (!compute) throw new Error("Compute API unavailable");
				return compute.getWalletTransactions({ limit: 25, cursor: pageParam }, s);
			}, signal),
		getNextPageParam: nextBillingCursor,
		enabled: scope.isReady && Boolean(compute) && section === "transactions",
		retry: false,
	});
	if (!compute)
		return (
			<ReadScreen>
				<AppView className="gap-4 p-6">
					<BackButton />
					<AppText>{t("billing.unavailable")}</AppText>
				</AppView>
			</ReadScreen>
		);
	const active = section === "subscriptions" ? subscriptions : transactions;
	const subscriptionItems = uniqueBillingItems(
		subscriptions.data?.pages.flatMap((page) => page.items ?? []) ?? [],
		(item) => item.subscription_id,
	);
	const transactionItems = uniqueBillingItems(
		transactions.data?.pages.flatMap((page) => page.items) ?? [],
		(item) => item.id,
	);
	const rows: BillingRow[] =
		section === "subscriptions"
			? subscriptionItems.map((item) => ({ id: item.subscription_id, kind: "subscription", item }))
			: transactionItems.map((item) => ({ id: item.id, kind: "transaction", item }));
	const refresh = () => {
		if (!wallet.isFetching) void wallet.refetch();
		if (!active.isFetching) void active.refetch();
	};
	return (
		<InventoryList
			items={rows}
			title={t("billing.title")}
			description={t("billing.independent")}
			empty={active.isPending ? t("loading.app") : t("billing.empty")}
			header={
				<AppView className="gap-3">
					<AppText className="text-sm text-muted">{t("billing.balance")}</AppText>
					<AppText className="text-2xl font-semibold text-foreground">
						{wallet.isPending
							? t("loading.app")
							: (exactUsd(wallet.data?.balance_usd) ?? t("billing.unknown"))}
					</AppText>
					{wallet.isError ? (
						<ErrorState onRetry={wallet.isFetching ? undefined : () => void wallet.refetch()} />
					) : null}
					<AppText className="text-sm text-muted">{t("billing.noStore")}</AppText>
					<AppText>{t("billing.section")}</AppText>
					<NativePicker
						value={section}
						options={[
							{ value: "subscriptions", label: t("billing.subscriptions") },
							{ value: "transactions", label: t("billing.transactions") },
						]}
						onValueChange={setSection}
					/>
				</AppView>
			}
			renderItem={(row) =>
				row.kind === "subscription" ? (
					<SubscriptionRow item={row.item} />
				) : (
					<TransactionRow item={row.item} />
				)
			}
			refreshing={wallet.isRefetching || active.isRefetching}
			onRefresh={refresh}
			error={active.isError}
			onRetry={refresh}
			busy={active.isFetching}
			more={active.hasNextPage}
			onMore={() => {
				if (!active.isFetching) void active.fetchNextPage();
			}}
		/>
	);
}

function SubscriptionRow({ item }: { item: Subscription }) {
	const t = useI18n();
	const router = useRouter();
	const scope = useAccountScope();
	return (
		<AppPressable
			accessibilityRole="button"
			className="gap-2 rounded-2xl bg-surface p-4"
			onPress={() => {
				if (scope.isCurrent() && !scope.signal.aborted)
					router.push(`/billing/subscriptions/${encodeURIComponent(item.subscription_id)}`);
			}}
		>
			<AppText className="text-lg font-semibold text-foreground">
				{item.agent_name ?? item.plan_slug}
			</AppText>
			<AppText className="text-muted">
				{item.status} · {subscriptionPrice(item) ?? t("billing.unknown")}
			</AppText>
			<AppText className="text-primary">{t("inventory.viewDetails")}</AppText>
		</AppPressable>
	);
}

function SubscriptionRecovery({ item }: { item: Subscription }) {
	const t = useI18n();
	const recovery = computeSubscriptionRecoveryPresentation(
		item,
		{ label: item.status, tone: "neutral" },
		{
			updating: t("billing.updating"),
			processing: t("billing.processing"),
			unpaid: t("billing.unpaid"),
			actionRequired: t("billing.actionRequired"),
			pastDue: t("billing.pastDue"),
			paymentProcessing: t("billing.paymentProcessing"),
			attention: t("billing.attention"),
			awaitingPayment: t("billing.awaitingPayment"),
			support: t("billing.support"),
			ended: t("billing.ended"),
			paymentAttention: t("billing.paymentAttention"),
		},
	);
	return (
		<AppView className="gap-2">
			{recovery.status.label !== item.status ? (
				<AppText
					accessibilityRole={recovery.hasPaymentIssue ? "alert" : undefined}
					className="text-foreground"
				>
					{recovery.status.label}
				</AppText>
			) : null}
			{recovery.schedule?.at ? (
				<DetailRow
					label={t("billing.retries")}
					value={formatDate(recovery.schedule.at) ?? t("billing.unknown")}
				/>
			) : recovery.schedule?.fallback ? (
				<AppText className="text-muted">{recovery.schedule.fallback}</AppText>
			) : null}
			{item.cancel_at_period_end ? (
				<AppText className="text-muted">{t("billing.cancellation")}</AppText>
			) : null}
			{item.pending_plan_slug ? (
				<DetailRow label={t("billing.pendingPlan")} value={item.pending_plan_slug} />
			) : null}
			{recovery.recoveryTarget ? (
				<AppText className="text-muted">{t("billing.providerRecovery")}</AppText>
			) : null}
		</AppView>
	);
}

function TransactionRow({ item }: { item: Transaction }) {
	const t = useI18n();
	return (
		<AppView className="gap-2 rounded-2xl bg-surface p-4">
			<AppText className="font-semibold text-foreground">
				{item.direction === "credit" ? "+" : "−"}
				{exactUsd(item.amount) ?? t("billing.unknown")}
			</AppText>
			<AppText className="text-muted">
				{item.kind} · {item.status}
			</AppText>
			<AppText className="text-muted">
				{formatDate(item.occurred_at) ?? t("billing.unknown")}
			</AppText>
		</AppView>
	);
}

export function SubscriptionDetailScreen({
	subscriptionId,
}: {
	subscriptionId: string | undefined;
}) {
	const t = useI18n();
	const router = useRouter();
	const scope = useAccountScope();
	const { compute } = useMobileApi();
	const validId = validSubscriptionId(subscriptionId);
	const query = useSubscriptions(validId);
	const item = query.data?.pages
		.flatMap((page) => page.items ?? [])
		.find((candidate) => candidate.subscription_id === subscriptionId);
	if (!compute)
		return (
			<ReadScreen>
				<AppView className="gap-4 p-6">
					<BackButton />
					<AppText>{t("billing.unavailable")}</AppText>
				</AppView>
			</ReadScreen>
		);
	if (!validId)
		return (
			<ReadScreen>
				<AppView className="gap-4 p-6">
					<BackButton />
					<ResourceError missing />
				</AppView>
			</ReadScreen>
		);
	if (query.isPending) return <LoadingScreen />;
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName="gap-4 p-6">
				<BackButton />
				<AppText className="text-2xl font-semibold text-foreground">{t("billing.details")}</AppText>
				<NativeButton
					disabled={query.isFetching}
					label={t("inventory.refresh")}
					onPress={() => {
						void query.refetch();
					}}
				/>
				{query.isError ? (
					<ErrorState onRetry={query.isFetching ? undefined : () => void query.refetch()} />
				) : null}
				{item ? (
					<AppView className="gap-3 rounded-2xl bg-surface p-5">
						<DetailRow label={t("billing.agent")} value={item.agent_name ?? t("billing.unknown")} />
						<DetailRow label={t("billing.plan")} value={item.plan_slug} />
						<DetailRow label={t("billing.status")} value={item.status} />
						<SubscriptionRecovery item={item} />
						<DetailRow
							label={t("billing.price")}
							value={subscriptionPrice(item) ?? t("billing.unknown")}
						/>
						<DetailRow label={t("billing.term")} value={String(item.billing_term_months)} />
						<DetailRow
							label={t("billing.source")}
							value={
								item.subscription_kind === "included_basic"
									? t("billing.included")
									: item.funding_source === "wallet"
										? t("billing.wallet")
										: item.funding_source === "stripe"
											? t("billing.stripe")
											: t("billing.unknown")
							}
						/>
						<DetailRow
							label={t("billing.periodEnd")}
							value={formatDate(item.current_period_end) ?? t("billing.unknown")}
						/>
						{item.funding_source === "wallet" ? (
							<AppText>{t("billing.walletNotice")}</AppText>
						) : null}
						<AppText className="text-muted">{t("billing.management")}</AppText>
						{item.deployment_id ? (
							<NativeButton
								label={t("billing.deployment")}
								onPress={() => {
									if (scope.isCurrent() && !scope.signal.aborted && item.deployment_id)
										router.push(`/deployments/${encodeURIComponent(item.deployment_id)}`);
								}}
							/>
						) : null}
					</AppView>
				) : !query.isError ? (
					query.hasNextPage ? (
						<>
							<AppText>{t("billing.moreToSearch")}</AppText>
							<NativeButton
								disabled={query.isFetching}
								label={t("inventory.loadMore")}
								onPress={() => {
									void query.fetchNextPage();
								}}
							/>
						</>
					) : (
						<ResourceError missing />
					)
				) : null}
			</AppScrollView>
		</ReadScreen>
	);
}

import { computeSubscriptionRecoveryPresentation } from "@clawdi/shared/api";
