import {
	ApiClientError,
	type components,
	type PublicSessionView,
	publicSessionId,
	publicSessionInput,
} from "@clawdi/shared/api";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import { useEffect, useRef, useState } from "react";
import { AppState, Share } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { Markdown } from "../ui/markdown";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton, formatDate } from "./cloud-inventory";
import { InventoryList } from "./inventory-list";
import { routeParam } from "./read-helpers";

export function OpenShareScreen() {
	const t = useI18n();
	const router = useRouter();
	const [value, setValue] = useState("");
	const id = publicSessionInput(value);
	return (
		<ReadScreen>
			<AppView className="gap-4 p-6">
				<BackButton />
				<AppText accessibilityRole="header" className="text-2xl text-foreground">
					{t("publicSession.open")}
				</AppText>
				<AppText>{t("publicSession.inputHelp")}</AppText>
				<AppTextInput
					accessibilityLabel={t("publicSession.link")}
					value={value}
					onChangeText={setValue}
					autoCapitalize="none"
					autoCorrect={false}
					maxLength={2048}
					className="rounded-xl bg-surface p-3 text-foreground"
				/>
				<NativeButton
					label={t("publicSession.open")}
					disabled={!id}
					onPress={() => {
						if (id) router.push({ pathname: "/s/[shareId]", params: { shareId: id } });
					}}
				/>
			</AppView>
		</ReadScreen>
	);
}

type Page = components["schemas"]["SessionMessagesPage"];
export function PublicSessionScreen() {
	const params = useLocalSearchParams<{ shareId?: string | string[] }>();
	const id = publicSessionId(routeParam(params.shareId) ?? "");
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
	const items = (currentView?.pages.flatMap((page) => page.items) ?? []).map((item, index) => ({
		...item,
		id: String(index),
	}));
	const last = currentView?.pages.at(-1);
	const more = Boolean(last?.items.length && items.length < last.total);
	const status = error instanceof ApiClientError ? error.status : 0;
	const title =
		currentView?.metadata.source === "snapshot"
			? currentView.metadata.detail.title
			: currentView?.metadata.detail.summary;
	return (
		<InventoryList
			title={title || t("publicSession.title")}
			description={t(
				currentView?.metadata.source === "live" ? "publicSession.live" : "publicSession.snapshot",
			)}
			items={items}
			empty={t(loading ? "loading.session" : "publicSession.empty")}
			refreshing={loading}
			onRefresh={refresh}
			onRetry={refresh}
			busy={loading || action.busy}
			error={Boolean(error && ![401, 403, 404, 409, 410].includes(status))}
			more={more}
			onMore={next}
			header={
				<AppView className="gap-3">
					{!id || error ? (
						<AppText accessibilityRole="alert">
							{t(
								!id || status === 404
									? "publicSession.missing"
									: status === 410
										? "publicSession.revoked"
										: status === 401
											? "publicSession.signIn"
											: status === 403
												? "publicSession.forbidden"
												: status === 409
													? "publicSession.changed"
													: "publicSession.failed",
							)}
						</AppText>
					) : null}
					{status === 401 && id ? (
						<NativeButton
							label={t("publicSession.signIn")}
							onPress={() =>
								router.push({ pathname: "/(auth)/sign-in", params: { publicShareId: id } })
							}
						/>
					) : null}
					{[401, 403, 404, 409, 410].includes(status) ? (
						<NativeButton
							label={t("publicSession.refresh")}
							disabled={loading || action.busy}
							onPress={refresh}
						/>
					) : null}
					{currentView ? (
						<>
							<AppText>
								{currentView.metadata.detail.agent_type} · {currentView.metadata.detail.model} ·{" "}
								{formatDate(currentView.metadata.detail.started_at)}
							</AppText>
							<AppText>
								{currentView.metadata.source === "snapshot"
									? t(`publicSession.${currentView.metadata.detail.scope}`)
									: t("publicSession.session")}
							</AppText>
							<NativeButton
								label={t("sessionShares.export")}
								disabled={action.busy}
								onPress={() => exportText("md")}
							/>
							<NativeButton
								label={t("publicSession.exportJson")}
								disabled={action.busy}
								onPress={() => exportText("json")}
							/>
						</>
					) : null}
				</AppView>
			}
			renderItem={(item) => (
				<AppView className="gap-2 rounded-2xl bg-surface p-4">
					<AppText className="font-semibold text-foreground">
						{t(item.role === "user" ? "sessions.user" : "sessions.assistant")}
					</AppText>
					<AppText className="text-muted">{formatDate(item.timestamp)}</AppText>
					<Markdown content={item.content} />
				</AppView>
			)}
		/>
	);
}
