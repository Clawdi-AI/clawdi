import {
	buildSessionShareRequest,
	type components,
	type SessionShareTarget,
	safeShareUrl,
	sessionShareExportUrl,
	sessionShareIdentity,
	sessionShareScope,
} from "@clawdi/shared/api";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, Share } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppView } from "../ui/primitives";
import { formatDate, useCloudSession } from "./cloud-inventory";
import { InventoryList } from "./inventory-list";
import { routeParam } from "./read-helpers";

type SessionShare = components["schemas"]["SessionShareListItemResponse"];

export function SessionShareActions({
	sessionId,
	hasContent,
}: {
	sessionId: string;
	hasContent: boolean;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { sessionSharing } = useMobileApi();
	const action = useAuthAction(scope);
	const capture = useForegroundLease();
	const exportMarkdown = () => {
		const visible = capture();
		void action.run(async (isCurrent) => {
			if (!hasContent || !visible()) return;
			const text = await read((signal) => sessionSharing.exportMarkdown(sessionId, signal));
			if (!isCurrent() || !visible()) return;
			await Share.share({ title: t("sessionShares.export"), message: text });
		});
	};
	return (
		<AppView className="gap-2">
			<NativeButton
				label={t("sessionShares.title")}
				onPress={() => router.push({ pathname: "/sessions/shared", params: { sessionId } })}
			/>
			<NativeButton
				disabled={action.busy || !hasContent}
				label={t("sessionShares.export")}
				onPress={exportMarkdown}
			/>
			{action.error ? (
				<AppText accessibilityRole="alert" className="text-danger">
					{t("sessionShares.failed")}
				</AppText>
			) : null}
		</AppView>
	);
}

export function SessionSharesScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{
		sessionId?: string | string[];
		scope?: string | string[];
		position?: string | string[];
	}>();
	const sessionId = routeParam(params.sessionId);
	const kind = params.scope === undefined ? "session" : routeParam(params.scope);
	const position = routeParam(params.position);
	let target: SessionShareTarget | null = null;
	try {
		if (kind === "session" && params.position === undefined) target = { scope: "session" };
		else if (
			(kind === "through" || kind === "response") &&
			position &&
			/^(0|[1-9]\d*)$/.test(position)
		)
			target = { scope: kind, position: Number(position) };
		if (target) buildSessionShareRequest(target);
	} catch {
		target = null;
	}
	const invalid = Boolean(
		(params.sessionId && !sessionId) ||
			!target ||
			(!sessionId && (params.scope || params.position)),
	);
	return (
		<SharesView
			key={`${scope.identity}:${scope.generation}:${sessionId}:${kind}:${position}`}
			sessionId={sessionId}
			target={target}
			invalid={invalid}
		/>
	);
}

function SharesView({
	sessionId,
	target,
	invalid,
}: {
	sessionId?: string;
	target: SessionShareTarget | null;
	invalid: boolean;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const cache = useQueryClient();
	const { sessionSharing } = useMobileApi();
	const action = useAuthAction(scope);
	const capture = useForegroundLease();
	const session = useCloudSession(invalid ? undefined : sessionId);
	const inventory = useInfiniteQuery({
		queryKey: accountQueryKey(scope, "session-shares", sessionId ?? "all"),
		initialPageParam: 1,
		queryFn: ({ pageParam, signal }) =>
			read(
				(s) => sessionSharing.list({ page: pageParam, page_size: 25, session_id: sessionId }, s),
				signal,
			),
		getNextPageParam: (page) =>
			page.items.length && page.page * page.page_size < page.total ? page.page + 1 : undefined,
		enabled: scope.isReady && !invalid,
		gcTime: 0,
		retry: false,
	});
	const items = Array.from(
		new Map(
			(inventory.data?.pages.flatMap((page) => page.items) ?? []).map((share) => [
				sessionShareIdentity(share),
				{ id: sessionShareIdentity(share), share },
			]),
		).values(),
	);
	const refresh = async () => {
		await Promise.all([
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "session-shares") }),
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-session") }),
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-sessions") }),
		]);
	};
	const present = (value: string) => {
		const visible = capture();
		void action.run(async () => {
			const url = safeShareUrl(value);
			if (!visible() || !scope.isCurrent() || !url) return;
			await Share.share({ title: t("sessionShares.title"), message: url });
		});
	};
	const create = () => {
		const visible = capture();
		if (
			invalid ||
			!target ||
			!sessionId ||
			!session.data?.has_content ||
			session.isError ||
			action.busy
		)
			return;
		const selected = target;
		Alert.alert(
			t("sessionShares.create"),
			t(selected.scope === "session" ? "sessionShares.warning" : "sessionShares.rangeWarning"),
			[
				{ text: t("account.cancel"), style: "cancel" },
				{
					text: t("sessionShares.create"),
					onPress: () => {
						if (!visible() || !scope.isCurrent()) return;
						void action.run(async (isCurrent) => {
							const created = await read((s) => sessionSharing.create(sessionId, selected, s));
							if (!isCurrent()) return;
							await refresh();
							if (!isCurrent() || !visible()) return;
							const url = safeShareUrl(created.share_url);
							if (!url) throw new Error("Invalid Session share URL");
							await Share.share({ title: t("sessionShares.title"), message: url });
						});
					},
				},
			],
		);
	};
	const revoke = (share: SessionShare) => {
		const visible = capture();
		Alert.alert(t("sessionShares.revoke"), t("sessionShares.revokeWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("sessionShares.revoke"),
				style: "destructive",
				onPress: () => {
					if (!visible() || !scope.isCurrent()) return;
					void action.run(async (isCurrent) => {
						await read((signal) => sessionSharing.revoke(share.id, share.kind, signal));
						if (isCurrent()) await refresh();
					});
				},
			},
		]);
	};
	return (
		<InventoryList
			title={t("sessionShares.title")}
			description={t("sessionShares.description")}
			items={invalid ? [] : items}
			empty={t(inventory.isPending && !invalid ? "loading.app" : "sessionShares.empty")}
			refreshing={inventory.isRefetching && !inventory.isFetchingNextPage}
			onRefresh={() => {
				if (!inventory.isFetching) void inventory.refetch();
			}}
			error={invalid || inventory.isError || Boolean(sessionId && session.isError)}
			onRetry={() => {
				if (!invalid) {
					void inventory.refetch();
					if (sessionId) void session.refetch();
				}
			}}
			more={inventory.hasNextPage}
			busy={inventory.isFetching}
			onMore={() => {
				if (!inventory.isFetching) void inventory.fetchNextPage();
			}}
			header={
				<AppView className="gap-3">
					{sessionId && target ? (
						<>
							<AppText className="text-foreground">
								{t(`sessionShares.${target.scope}`)}
								{"position" in target ? ` · #${target.position + 1}` : ""}
							</AppText>
							<NativeButton
								label={t("sessionShares.create")}
								disabled={
									invalid ||
									action.busy ||
									session.isFetching ||
									session.isError ||
									!session.data?.has_content
								}
								onPress={create}
							/>
						</>
					) : null}
					{action.error ? (
						<AppText accessibilityRole="alert" className="text-danger">
							{t("sessionShares.failed")}
						</AppText>
					) : null}
				</AppView>
			}
			renderItem={({ share }) => (
				<AppView className="gap-3 rounded-2xl bg-surface p-4">
					<AppText className="text-lg text-foreground">{share.session_title}</AppText>
					<AppText className="text-muted">
						{t(`sessionShares.${sessionShareScope(share)}`)} · {share.message_count} ·{" "}
						{formatDate(share.created_at)}
					</AppText>
					<NativeButton
						label={t("sessionShares.openSession")}
						disabled={action.busy}
						onPress={() =>
							router.push({
								pathname: "/sessions/[sessionId]",
								params: { sessionId: share.session_id },
							})
						}
					/>
					<NativeButton
						label={t("sessionShares.share")}
						disabled={action.busy || !safeShareUrl(share.share_url)}
						onPress={() => present(share.share_url)}
					/>
					{(["md", "json"] as const).map((format) => {
						const url = sessionShareExportUrl(share.share_url, format);
						return (
							<NativeButton
								key={format}
								disabled={action.busy || !url}
								label={t(
									format === "md" ? "sessionShares.shareMarkdown" : "sessionShares.shareJson",
								)}
								onPress={() => {
									if (url) present(url);
								}}
							/>
						);
					})}
					<NativeButton
						label={t("sessionShares.revoke")}
						disabled={action.busy}
						onPress={() => revoke(share)}
					/>
				</AppView>
			)}
		/>
	);
}
