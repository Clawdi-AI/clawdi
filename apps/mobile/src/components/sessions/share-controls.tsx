import {
	buildSessionShareRequest,
	type components,
	publicSessionInput,
	type SessionShareTarget,
	safeShareUrl,
	sessionShareExportUrl,
	sessionShareIdentity,
	sessionShareMatchesTarget,
} from "@clawdi/shared/api";
import {
	shareControlsClasses as dialogStyles,
	inputClassName,
	sharedSessionLinksClasses as styles,
} from "@clawdi/shared/ui";
import {
	relativeTime,
	sessionShareDialogCopy,
	shareDetail,
	shareLabel,
	shareScopeLabel,
} from "@clawdi/shared/view";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import MoreHorizontal from "lucide-react-native/icons/ellipsis";
import ExternalLink from "lucide-react-native/icons/external-link";
import Link2 from "lucide-react-native/icons/link-2";
import Share2 from "lucide-react-native/icons/share-2";
import Trash2 from "lucide-react-native/icons/trash";
import { useState } from "react";
import { Share } from "react-native";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { SheetPage } from "@/components/ui/sheet-page";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webText, webView } from "@/components/ui/web-layout";
import { useCloudSession } from "@/hooks/cloud-inventory";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeHeader } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

type SessionShare = components["schemas"]["SessionShareListItemResponse"];

export function SessionShareActions({
	sessionId,
	title,
	hasContent,
}: {
	sessionId: string;
	title: string;
	hasContent: boolean;
}) {
	const t = useI18n(),
		scope = useAccountScope(),
		read = useAccountRead(),
		capture = useForegroundLease(),
		cache = useQueryClient();
	const { sessionSharing } = useMobileApi();
	const action = useAuthAction(scope);
	const exportMarkdown = () => {
		const visible = capture();
		void action.run(async (current) => {
			if (!hasContent || !visible()) return;
			const text = await read((signal) => sessionSharing.exportMarkdown(sessionId, signal));
			if (current() && visible())
				await Share.share({ title: t("sessionDetail.export"), message: text });
		});
	};
	const [deleting, setDeleting] = useState(false);
	return (
		<>
			<NativeHeader
				title={title}
				actions={[
					{
						id: "share",
						label: t("sessionDetail.share"),
						onPress: () =>
							router.push({ pathname: "/sessions/[id]/sharing", params: { id: sessionId } }),
					},
				]}
				menu={{
					label: t("sessionDetail.more"),
					items: [
						{
							id: "export",
							label: t("sessionDetail.export"),
							disabled: action.busy || !hasContent,
							onPress: exportMarkdown,
						},
						{
							id: "delete",
							label: t("sessionDetail.delete"),
							destructive: true,
							onPress: () => setDeleting(true),
						},
					],
				}}
			/>
			<ConfirmAction
				open={deleting}
				onOpenChange={setDeleting}
				title={t("sessionDetail.deleteTitle")}
				description={t("sessionDetail.deleteDescription")}
				confirmLabel={t("sessionDetail.deleteConfirm")}
				destructive
				onConfirm={async () => {
					const visible = capture();
					if (!scope.isCurrent() || !visible()) return;
					await read((signal) => sessionSharing.deleteSession(sessionId, signal));
					if (!scope.isCurrent()) return;
					await Promise.all([
						cache.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-sessions") }),
						cache.invalidateQueries({ queryKey: accountQueryKey(scope, "session-shares") }),
					]);
					if (scope.isCurrent() && visible()) router.replace("/sessions");
				}}
			/>
			{action.error ? <ApiErrorPanel error={undefined} title={t("sessionDetail.failed")} /> : null}
		</>
	);
}

export function SessionSharesScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{
		sessionId?: string | string[];
		id?: string | string[];
		scope?: string | string[];
		position?: string | string[];
	}>();
	const sessionId = routeParam(params.sessionId ?? params.id),
		kind = params.scope === undefined ? "session" : routeParam(params.scope),
		position = routeParam(params.position);
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
	const t = useI18n(),
		scope = useAccountScope(),
		read = useAccountRead(),
		cache = useQueryClient(),
		capture = useForegroundLease();
	const { sessionSharing } = useMobileApi();
	const action = useAuthAction(scope),
		session = useCloudSession(invalid ? undefined : sessionId);
	const [createdId, setCreatedId] = useState<string | null>(null),
		[older, setOlder] = useState(false);
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
	const snapshotsKey = accountQueryKey(scope, "session-share-snapshots", sessionId);
	const snapshots = useQuery({
		queryKey: snapshotsKey,
		queryFn: ({ signal }) =>
			read((s) => {
				if (!sessionId) throw new Error("Session id is required");
				return sessionSharing.shares(sessionId, s);
			}, signal),
		enabled: scope.isReady && !invalid && Boolean(sessionId),
		gcTime: 0,
		retry: false,
	});
	const items = Array.from(
		new Map(
			(inventory.data?.pages.flatMap((page) => page.items) ?? []).map((share) => [
				sessionShareIdentity(share),
				share,
			]),
		).values(),
	);
	const refresh = async () => {
		await Promise.all([
			cache.invalidateQueries({ queryKey: snapshotsKey }),
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "session-shares") }),
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-session") }),
			cache.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-sessions") }),
		]);
	};
	const present = (value: string) => {
		const visible = capture();
		void action.run(async () => {
			const url = safeShareUrl(value);
			if (visible() && scope.isCurrent() && url)
				await Share.share({ title: t("sessionDetail.share"), message: url });
		});
	};
	const create = async () => {
		const visible = capture();
		if (
			invalid ||
			!target ||
			!sessionId ||
			!session.data?.has_content ||
			session.isError ||
			action.busy ||
			!scope.isCurrent() ||
			!visible()
		)
			return;
		const created = await read((s) => sessionSharing.create(sessionId, target, s));
		if (!scope.isCurrent()) return;
		const url = safeShareUrl(created.share_url);
		if (!url) throw new Error("Invalid Session share URL");
		setCreatedId(created.id);
		cache.setQueryData<{ shares: components["schemas"]["SessionShareResponse"][] }>(
			snapshotsKey,
			(current) => ({
				shares: [created, ...(current?.shares.filter((share) => share.id !== created.id) ?? [])],
			}),
		);
		await refresh();
	};
	const revoke = async (share: SessionShare) => {
		const visible = capture();
		if (!scope.isCurrent() || !visible()) return;
		await read((signal) => sessionSharing.revoke(share.id, share.kind, signal));
		if (scope.isCurrent()) await refresh();
	};
	const row = (share: SessionShare, compact = false) => (
		<WebView recipe={compact ? dialogStyles.link : styles.row} key={sessionShareIdentity(share)}>
			<WebView recipe={compact ? dialogStyles.linkHeader : styles.content}>
				<WebView recipe={styles.content}>
					<WebView recipe={styles.titleRow}>
						<WebText
							recipe={compact ? dialogStyles.linkTitle : styles.title}
							numberOfLines={1}
							onPress={() =>
								router.push({
									pathname: "/sessions/[id]",
									params: { id: share.session_id },
								})
							}
						>
							{compact
								? share.kind === "live"
									? t("sessionDetailMobile.liveLink")
									: shareLabel(share)
								: share.session_title}
						</WebText>
						{!compact ? (
							<Badge variant="outline">
								<Text>
									{t(share.kind === "live" ? "sessionDetail.live" : "sessionDetail.snapshot")}
								</Text>
							</Badge>
						) : null}
					</WebView>
					<WebText recipe={compact ? dialogStyles.linkMeta : styles.meta}>
						{compact
							? shareDetail(share)
							: t("labels.shareDetails", {
									scope: shareScopeLabel(share),
									count: share.message_count,
									unit: share.message_count === 1 ? t("labels.message") : t("labels.messages"),
									time: relativeTime(share.created_at),
								})}
					</WebText>
					{share.kind === "live" ? (
						<WebText recipe={styles.meta}>{t("sessionDetail.liveDescription")}</WebText>
					) : null}
				</WebView>
				{compact ? (
					<ConfirmAction
						title={t("sessionDetail.revokeTitle")}
						description={t("sessionDetail.revokeDescription")}
						confirmLabel={t("sessionDetail.revoke")}
						destructive
						onConfirm={() => revoke(share)}
					>
						<Button
							variant="ghost"
							size="icon-sm"
							className={webView(styles.revoke)}
							accessibilityLabel={t("sessionDetail.revoke")}
						>
							<Icon as={Trash2} />
						</Button>
					</ConfirmAction>
				) : null}
			</WebView>
			<WebView recipe={compact ? dialogStyles.linkActions : styles.actions}>
				{compact ? (
					<WebView
						recipe={inputClassName}
						className={`${webView(dialogStyles.url)} flex-1 justify-center`}
					>
						<WebText
							recipe={webText(dialogStyles.url)}
							selectable
							numberOfLines={1}
							accessibilityLabel={t("sessionDetail.link")}
						>
							{share.share_url}
						</WebText>
					</WebView>
				) : null}
				<Button
					variant="outline"
					size="sm"
					className={compact ? webView(dialogStyles.copy) : undefined}
					disabled={action.busy || !safeShareUrl(share.share_url)}
					onPress={() => present(share.share_url)}
				>
					<Icon as={Share2} />
					<Text>{t("sessionDetail.share")}</Text>
				</Button>
				{!compact ? (
					<Button
						variant="outline"
						size="sm"
						disabled={action.busy || !publicSessionInput(share.share_url)}
						onPress={() => {
							const id = publicSessionInput(share.share_url);
							if (id) router.push({ pathname: "/s/[id]", params: { id: id } });
						}}
					>
						<Icon as={ExternalLink} />
						<Text>{t("sessionDetail.open")}</Text>
					</Button>
				) : null}
				{!compact ? (
					<ConfirmAction
						title={t("sessionDetail.revokeTitle")}
						description={t("sessionDetail.revokeDescription")}
						confirmLabel={t("sessionDetail.revoke")}
						destructive
						onConfirm={() => revoke(share)}
					>
						<Button
							variant="ghost"
							size="icon-sm"
							className={webView(styles.revoke)}
							accessibilityLabel={t("sessionDetail.revoke")}
						>
							<Icon as={Trash2} />
						</Button>
					</ConfirmAction>
				) : null}
				{!compact ? (
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button variant="ghost" size="icon-sm" accessibilityLabel={t("sessionDetail.more")}>
									<Icon as={MoreHorizontal} />
								</Button>
							}
						/>
						<DropdownMenuContent>
							{(["md", "json"] as const).map((format) => (
								<DropdownMenuItem
									key={format}
									label={t(format === "md" ? "sessionDetail.export" : "sessionDetail.exportJson")}
									disabled={action.busy || !sessionShareExportUrl(share.share_url, format)}
									onSelect={() => {
										const url = sessionShareExportUrl(share.share_url, format);
										if (url) present(url);
									}}
								/>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
			</WebView>
		</WebView>
	);
	const failure =
		invalid || inventory.isError || Boolean(sessionId && (session.isError || snapshots.isError));
	const errorPanel = failure ? (
		<ApiErrorPanel
			error={inventory.error ?? snapshots.error ?? session.error}
			title={t(sessionId ? "sessionDetail.linksError" : "sessionDetail.sharedError")}
			onRetry={
				invalid
					? undefined
					: () => {
							void inventory.refetch();
							if (sessionId) {
								void session.refetch();
								void snapshots.refetch();
							}
						}
			}
		/>
	) : action.error ? (
		<ApiErrorPanel error={undefined} title={t("sessionDetail.failed")} />
	) : null;
	const skeleton = (
		<WebView recipe={styles.skeleton}>
			{Array.from({ length: 4 }, (_, index) => (
				<WebView key={index} recipe={styles.skeletonRow}>
					<WebView recipe={styles.skeletonBody}>
						<Skeleton className={webView(styles.skeletonTitle)} />
						<Skeleton className={webView(styles.skeletonMeta)} />
					</WebView>
				</WebView>
			))}
		</WebView>
	);
	const pagination = inventory.hasNextPage ? (
		<Button
			variant="ghost"
			size="sm"
			disabled={inventory.isFetching}
			onPress={() => {
				if (scope.isCurrent()) void inventory.fetchNextPage().catch(() => undefined);
			}}
		>
			<Text>{t("inventory.loadMore")}</Text>
		</Button>
	) : null;
	if (sessionId && target) {
		const copy = sessionShareDialogCopy(target);
		const matching = (snapshots.data?.shares ?? [])
			.filter((share) => sessionShareMatchesTarget(share, target))
			.map((share) => ({
				...share,
				kind: "snapshot" as const,
				session_title: session.data?.summary || "Session",
			}));
		const latest = matching.find((share) => share.id === createdId) ?? matching[0];
		const others = items.filter(
			(share) =>
				share.id !== latest?.id &&
				(target.scope === "session" || matching.some((value) => value.id === share.id)),
		);
		return (
			<SheetPage
				title={copy.title}
				fallback={{ pathname: "/sessions/[id]", params: { id: sessionId } }}
				busy={action.busy}
				scroll={false}
			>
				<NativeList
					data={[...(latest ? [latest] : []), ...(older ? others : [])]}
					keyExtractor={sessionShareIdentity}
					renderItem={({ item }) => row(item, true)}
					refreshing={inventory.isRefetching || snapshots.isRefetching}
					onRefresh={() => {
						void inventory.refetch();
						void snapshots.refetch();
					}}
					hasMore={older && inventory.hasNextPage}
					loadingMore={inventory.isFetching}
					onLoadMore={() => void inventory.fetchNextPage().catch(() => undefined)}
					header={
						<WebView recipe={dialogStyles.body}>
							<WebText recipe={"text-sm text-muted-foreground"}>{copy.description}</WebText>
							{errorPanel}
							{inventory.isPending || snapshots.isPending ? skeleton : null}
							{others.length ? (
								<Button variant="ghost" size="sm" onPress={() => setOlder((value) => !value)}>
									<Text>
										{t("sessionDetail.older")} ({others.length})
									</Text>
								</Button>
							) : null}
						</WebView>
					}
					footer={
						<>
							<WebView recipe={dialogStyles.linkActions}>
								<ConfirmAction
									title={copy.title}
									description={copy.description}
									confirmLabel={t("sessionDetail.create")}
									onConfirm={() => action.runOrThrow(create)}
								>
									<Button
										variant={latest ? "outline" : "default"}
										disabled={
											failure ||
											inventory.isFetching ||
											snapshots.isFetching ||
											session.isFetching ||
											!session.data?.has_content
										}
									>
										<Icon as={Link2} />
										<Text>
											{t(matching.length ? "sessionDetail.createSnapshot" : "sessionDetail.create")}
										</Text>
									</Button>
								</ConfirmAction>
							</WebView>
						</>
					}
				/>
			</SheetPage>
		);
	}
	return (
		<SafeAreaScreen>
			<NativeList
				data={failure && !items.length ? [] : items}
				keyExtractor={sessionShareIdentity}
				contentContainerStyle={{ padding: 16, flexGrow: 1, gap: 0 }}
				refreshing={inventory.isRefetching && !inventory.isFetchingNextPage}
				onRefresh={() => {
					if (!inventory.isFetching) void inventory.refetch();
				}}
				ListHeaderComponentStyle={{ marginBottom: 20 }}
				header={
					<WebView recipe={styles.page} className="px-0">
						<PageHeader
							title={t("sessionDetail.sharedTitle")}
							description={t("sessionDetail.sharedDescription")}
						/>
						{errorPanel}
					</WebView>
				}
				renderItem={({ item, index }) => (
					<WebView
						recipe={`${styles.list} ${index ? "border-t" : ""}`}
						style={{
							borderTopLeftRadius: index ? 0 : undefined,
							borderTopRightRadius: index ? 0 : undefined,
							borderBottomLeftRadius: index < items.length - 1 ? 0 : undefined,
							borderBottomRightRadius: index < items.length - 1 ? 0 : undefined,
							borderTopWidth: index ? 0 : undefined,
						}}
					>
						{row(item)}
					</WebView>
				)}
				empty={
					inventory.isPending && !invalid ? (
						skeleton
					) : !failure ? (
						<EmptyState
							icon={Link2}
							title={t("sessionDetail.noLinks")}
							description={t("sessionDetail.noLinksDescription")}
							action={
								<Button variant="outline" onPress={() => router.replace("/sessions")}>
									<Text>{t("sessionDetail.browse")}</Text>
								</Button>
							}
						/>
					) : undefined
				}
				hasMore={inventory.hasNextPage}
				loadingMore={inventory.isFetching}
				onLoadMore={() => {
					if (scope.isCurrent()) void inventory.fetchNextPage().catch(() => undefined);
				}}
				footer={pagination}
			/>
		</SafeAreaScreen>
	);
}
