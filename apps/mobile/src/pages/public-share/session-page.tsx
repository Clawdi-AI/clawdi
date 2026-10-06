import {
	ApiClientError,
	buildSessionTimelineRows,
	type components,
	type PublicSessionView,
	publicSessionId,
	publicSessionInput,
} from "@clawdi/shared/api";
import { detailLayoutClasses, publicSessionClasses as styles } from "@clawdi/shared/ui";
import { publicSessionScopeLabel, relativeTime } from "@clawdi/shared/view";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { ArrowLeft, Clock, Link2, MessageSquare, MoreHorizontal } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AppState, FlatList, Image, Share } from "react-native";
import { withUniwind } from "uniwind";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { PageHeader } from "@/components/page-header";
import { SessionTimelineRowView } from "@/components/sessions/message-list";
import { AgentInline, DetailMeta, DetailStats, ModelBadge, Stat } from "@/components/sessions/meta";
import { MessagesSkeleton } from "@/components/sessions/skeleton";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { AppScrollView } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useMobileRuntimeConfig } from "@/lib/config/runtime";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

const BrandImage = withUniwind(Image);

export function OpenShareScreen() {
	const t = useI18n();
	const router = useRouter();
	const [value, setValue] = useState("");
	const id = publicSessionInput(value);
	return (
		<SafeAreaScreen>
			<AppScrollView contentContainerStyle={{ padding: 16 }}>
				<WebView recipe={styles.page} className="px-0">
					<Button
						variant="ghost"
						size="sm"
						onPress={() => (router.canGoBack() ? router.back() : router.replace("/sessions"))}
					>
						<Icon as={ArrowLeft} />
						<Text>{t("sessionDetail.back")}</Text>
					</Button>
					<PageHeader
						title={t("sessionDetail.openShare")}
						description={t("sessionDetail.inputHelp")}
					/>
					<Input
						accessibilityLabel={t("sessionDetail.link")}
						value={value}
						onChangeText={setValue}
						autoCapitalize="none"
						autoCorrect={false}
						maxLength={2048}
						placeholder="clawdi://s/…"
					/>
					<Button
						disabled={!id}
						onPress={() => {
							if (id) router.push({ pathname: "/s/[id]", params: { id: id } });
						}}
					>
						<Text>{t("sessionDetail.openShare")}</Text>
					</Button>
				</WebView>
			</AppScrollView>
		</SafeAreaScreen>
	);
}

type Page = components["schemas"]["SessionMessagesPage"];
export function PublicSessionScreen() {
	const params = useLocalSearchParams<{ id?: string | string[] }>();
	const id = publicSessionId(routeParam(params.id) ?? "");
	const scope = useAccountScope();
	return <PublicSession key={`${scope.identity}:${scope.generation}:${id}`} id={id} />;
}
function PublicSession({ id }: { id: string | null }) {
	const t = useI18n();
	const router = useRouter();
	const scope = useAccountScope();
	const focused = useIsFocused();
	const capture = useForegroundLease();
	const { publicSessions: api } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const [active, setActive] = useState(AppState.currentState === "active");
	const [epoch, setEpoch] = useState(0);
	const [view, setView] = useState<{ metadata: PublicSessionView; pages: Page[] } | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [loading, setLoading] = useState(false);
	const request = useRef<AbortController | null>(null);
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") request.current?.abort();
			setActive(state === "active");
		});
		return () => listener.remove();
	}, []);
	useEffect(() => {
		const controller = new AbortController();
		request.current = controller;
		setView(null);
		setError(null);
		if (!id || !focused || !active) {
			setLoading(false);
			return () => controller.abort();
		}
		setLoading(true);
		void (async () => {
			try {
				const metadata = await api.resolve(id, controller.signal);
				const page = await api.messages(id, metadata.source, 0, controller.signal);
				if (!controller.signal.aborted && scope.isCurrent()) setView({ metadata, pages: [page] });
			} catch (failure) {
				if (!controller.signal.aborted && scope.isCurrent()) setError(failure);
			} finally {
				if (!controller.signal.aborted && scope.isCurrent()) setLoading(false);
			}
		})();
		return () => controller.abort();
	}, [id, focused, active, epoch, api, scope]);
	const currentView = focused && active ? view : null;
	const refresh = () => {
		if (!action.busy && !loading) setEpoch((value) => value + 1);
	};
	const next = () =>
		void action.run(async (current) => {
			const controller = request.current;
			if (!id || !currentView || !controller || controller.signal.aborted) return;
			const offset = currentView.pages.reduce((sum, page) => sum + page.items.length, 0);
			try {
				const page = await api.messages(id, currentView.metadata.source, offset, controller.signal);
				const first = currentView.pages[0];
				if (
					!first ||
					page.total !== first.total ||
					(page.content_revision ?? null) !== (first.content_revision ?? null)
				)
					throw new ApiClientError(409);
				if (current() && !controller.signal.aborted && request.current === controller)
					setView({ ...currentView, pages: [...currentView.pages, page] });
			} catch (failure) {
				if (current() && !controller.signal.aborted) {
					setView(null);
					setError(failure);
				}
			}
		});
	const exportText = (format: "md" | "json") =>
		void action.run(async (current) => {
			const foreground = capture();
			const controller = request.current;
			if (!id || !currentView || !controller || controller.signal.aborted) return;
			try {
				const content =
					format === "json"
						? JSON.stringify(
								await api.exportJson(id, currentView.metadata.source, controller.signal),
								null,
								2,
							)
						: await api.exportMarkdown(id, currentView.metadata.source, controller.signal);
				if (current() && foreground() && !controller.signal.aborted)
					await Share.share({ message: content });
			} catch (failure) {
				if (current() && !controller.signal.aborted) {
					setView(null);
					setError(failure);
				}
			}
		});
	const items = currentView?.pages.flatMap((page) => page.items) ?? [];
	const rows = buildSessionTimelineRows(
		items,
		items.map((_, index) => String(index)),
	);
	const last = currentView?.pages.at(-1);
	const more = Boolean(last?.items.length && items.length < last.total);
	const status = error instanceof ApiClientError ? error.status : 0;
	const title =
		currentView?.metadata.source === "snapshot"
			? currentView.metadata.detail.title
			: currentView?.metadata.detail.summary;
	const runtime = useMobileRuntimeConfig();
	const shareLink = () => {
		const visible = capture();
		void action.run(async (current) => {
			if (id && current() && visible() && scope.isCurrent())
				await Share.share({
					message:
						runtime.ok && runtime.value.linkHosts?.[0]
							? `https://${runtime.value.linkHosts[0]}/s/${id}`
							: `clawdi://s/${id}`,
				});
		});
	};
	const brand = (
		<WebView recipe={styles.header}>
			<WebView recipe={styles.headerRow}>
				<WebView recipe={styles.brand}>
					<BrandImage
						source={require("../../../../web/public/clawdi-logo-transparent.png")}
						className={webView(styles.brandImage)}
					/>
					<WebText recipe={styles.brandName} onPress={() => router.replace("/sessions")}>
						{t("sessionDetail.brand")}
					</WebText>
				</WebView>
			</WebView>
		</WebView>
	);
	const gate =
		error && ![401, 403, 404, 409, 410].includes(status) ? (
			<ApiErrorPanel error={error} onRetry={refresh} />
		) : !id || error ? (
			<WebView recipe={styles.gate} style={{ minHeight: 480 }}>
				<WebText recipe={styles.gateLabel}>
					{t(
						status === 401
							? "sessionDetail.gatePrivate"
							: status === 403
								? "sessionDetail.gateForbidden"
								: status === 410
									? "sessionDetail.gateExpired"
									: "sessionDetail.notFound",
					)}
				</WebText>
				<WebText recipe={styles.gateTitle}>
					{t(
						status === 401
							? "sessionDetail.gateSignIn"
							: status === 403
								? "sessionDetail.gateForbiddenTitle"
								: status === 410
									? "sessionDetail.gateExpiredTitle"
									: "sessionDetail.notFound",
					)}
				</WebText>
				<WebText recipe={styles.gateBody}>
					{t(
						status === 401
							? "sessionDetail.gatePrivateBody"
							: status === 403
								? "sessionDetail.gateForbiddenBody"
								: status === 410
									? "sessionDetail.gateExpiredBody"
									: status === 409
										? "publicSession.changed"
										: "sessionDetail.notFoundDescription",
					)}
				</WebText>
				{status === 401 && id ? (
					<Button
						onPress={() => router.push({ pathname: "/sign-in", params: { publicShareId: id } })}
					>
						<Text>{t("sessionDetail.signIn")}</Text>
					</Button>
				) : null}
				<WebText recipe={styles.gateLink} onPress={() => router.replace("/sessions")}>
					{t("sessionDetail.goHome")}
				</WebText>
				{id && [401, 403, 409, 410].includes(status) ? (
					<Button variant="ghost" size="sm" disabled={loading || action.busy} onPress={refresh}>
						<Text>{t("sessionDetail.refresh")}</Text>
					</Button>
				) : null}
				{error && ![401, 403, 404, 409, 410].includes(status) ? (
					<ApiErrorPanel error={error} onRetry={refresh} />
				) : null}
			</WebView>
		) : null;
	return (
		<SafeAreaScreen>
			{brand}
			{action.error ? <ApiErrorPanel error={null} title={t("sessionDetail.failed")} /> : null}
			<FlatList
				data={rows}
				keyExtractor={(row) => String(row.rowKey)}
				contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 24, flexGrow: 1 }}
				refreshing={loading}
				onRefresh={refresh}
				ListHeaderComponent={
					gate ??
					(currentView ? (
						<WebView recipe={styles.page} className="px-0 py-0">
							<WebView recipe={styles.heading}>
								<WebView recipe={styles.body}>
									<WebText recipe={detailLayoutClasses.title}>
										{title || t("publicSession.title")}
									</WebText>
									<DetailMeta>
										<AgentInline
											identity={{ agent_type: currentView.metadata.detail.agent_type }}
										/>
										<WebText recipe={detailLayoutClasses.meta}>·</WebText>
										<WebText recipe={detailLayoutClasses.meta}>
											Started {relativeTime(currentView.metadata.detail.started_at)}
										</WebText>
										<WebText recipe={detailLayoutClasses.meta}>·</WebText>
										<WebText recipe={detailLayoutClasses.meta}>
											{publicSessionScopeLabel(
												currentView.metadata.source === "snapshot"
													? currentView.metadata.detail.scope
													: "session",
											)}
										</WebText>
									</DetailMeta>
								</WebView>
								<WebView recipe={styles.brand}>
									<Button
										variant="outline"
										size="icon"
										accessibilityLabel={t("sessionDetail.share")}
										onPress={shareLink}
										disabled={action.busy}
									>
										<Icon as={Link2} />
									</Button>
									<DropdownMenu>
										<DropdownMenuTrigger
											render={
												<Button
													variant="outline"
													size="icon"
													accessibilityLabel={t("sessionDetail.more")}
												>
													<Icon as={MoreHorizontal} />
												</Button>
											}
										/>
										<DropdownMenuContent>
											<DropdownMenuItem
												label={t("sessionDetail.export")}
												disabled={action.busy}
												onSelect={() => exportText("md")}
											/>
											<DropdownMenuItem
												label={t("sessionDetail.exportJson")}
												disabled={action.busy}
												onSelect={() => exportText("json")}
											/>
										</DropdownMenuContent>
									</DropdownMenu>
								</WebView>
							</WebView>
							<DetailStats>
								<ModelBadge modelId={currentView.metadata.detail.model} />
								<Stat
									icon={MessageSquare}
									label={`${currentView.metadata.detail.message_count} messages`}
								/>
								{currentView.metadata.source === "snapshot" ? (
									<Stat
										icon={Clock}
										label={`Shared ${relativeTime(currentView.metadata.detail.created_at)}`}
									/>
								) : null}
							</DetailStats>
						</WebView>
					) : loading ? (
						<MessagesSkeleton />
					) : null)
				}
				renderItem={({ item }) => (
					<SessionTimelineRowView
						row={item}
						agentType={currentView?.metadata.detail.agent_type}
						userName="User"
						onShareText={(content) => {
							const visible = capture();
							void action.run(async (current) => {
								if (current() && visible() && scope.isCurrent())
									await Share.share({ message: content });
							});
						}}
					/>
				)}
				ListEmptyComponent={
					!loading && currentView ? (
						<WebText recipe={styles.empty}>{t("sessionDetail.emptyShare")}</WebText>
					) : undefined
				}
				ListFooterComponent={
					currentView ? (
						<WebView recipe={styles.page} className="px-0 py-0">
							{more ? (
								<Button variant="ghost" size="sm" disabled={loading || action.busy} onPress={next}>
									<Text>{t("inventory.loadMore")}</Text>
								</Button>
							) : null}
							<WebText recipe={styles.footer}>{t("sessionDetail.footer")}</WebText>
						</WebView>
					) : null
				}
			/>
		</SafeAreaScreen>
	);
}
