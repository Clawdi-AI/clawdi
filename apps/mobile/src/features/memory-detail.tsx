import { memoryDetailClasses } from "@clawdi/shared/ui";
import { MEMORY_CATEGORY_COLORS, RESOURCE_TINT_CLASSES, relativeTime } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Brain, Laptop, Trash2 } from "lucide-react-native";
import { useRef } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { ApiErrorPanel } from "../ui/api-error-panel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DetailBackLink, DetailMeta, DetailPanel, LibraryPage } from "../ui/detail/layout";
import { Icon } from "../ui/icon";
import { IconChip } from "../ui/icon-chip";
import { PageHeader, PageHeaderSkeleton } from "../ui/page-header";
import { Text } from "../ui/text";
import { WebText, WebView, webBoth, webText, webView } from "../ui/web-layout";

import { isNotFound } from "./cloud-inventory";

import { routeParam } from "./read-helpers";
import { ResourceError } from "./resource-error";

export function MemoryDetailScreen() {
	const params = useLocalSearchParams<{ memoryId?: string | string[] }>();
	const id = typeof params.memoryId === "string" ? routeParam(params.memoryId) : undefined;
	const scope = useAccountScope();
	return <MemoryDetail key={`${scope.identity}:${scope.generation}:${id}`} id={id} />;
}

function MemoryDetail({ id }: { id: string | undefined }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { cloud } = useMobileApi();
	const router = useRouter();
	const queries = useQueryClient();
	const action = useAuthAction(scope.identity);
	const capture = useForegroundLease();
	const confirmation = useRef(0);
	const key = accountQueryKey(scope, "memory-detail", id);
	const query = useQuery({
		queryKey: key,
		enabled: scope.isReady && Boolean(id),
		retry: false,
		queryFn: ({ signal }) =>
			read((s) => {
				if (!id) throw new Error("Memory identifier missing");
				return cloud.getMemory(id, s);
			}, signal),
	});
	const memory = query.data;
	const remove = () => {
		if (!memory || !id || action.busy) return;
		const signal = scope.signal;
		const visible = capture();
		const ticket = ++confirmation.current;
		Alert.alert(t("memories.remove"), t("memories.removeWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("memories.remove"),
				style: "destructive",
				onPress: () => {
					if (ticket !== confirmation.current || signal.aborted || !scope.isCurrent() || !visible())
						return;
					confirmation.current++;
					void action.run(async (current) => {
						await read((s) => cloud.deleteMemory(id, s), signal);
						// Cache invalidation survives leaving this screen, but never crosses accounts.
						if (!scope.isCurrent()) return;
						queries.removeQueries({ queryKey: key, exact: true });
						await queries.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-memories") });
						if (current() && visible() && scope.isCurrent()) router.replace("/memories");
					});
				},
			},
		]);
	};
	return (
		<LibraryPage detail>
			<DetailBackLink href="/memories" label={t("memories.title")} />
			{id && query.isPending ? (
				<PageHeaderSkeleton icon actions />
			) : !id || query.isError || !memory ? (
				<ResourceError
					missing={!id || isNotFound(query.error)}
					onRetry={id && !query.isFetching ? () => void query.refetch() : undefined}
				/>
			) : (
				<>
					<PageHeader
						title={memory.content}
						icon={
							<IconChip tint={RESOURCE_TINT_CLASSES.memories}>
								<Icon as={Brain} />
							</IconChip>
						}
						status={
							<DetailMeta>
								<Badge
									variant="secondary"
									className={webBoth(MEMORY_CATEGORY_COLORS[memory.category] ?? "")}
								>
									<Text>{memory.category}</Text>
								</Badge>
								<Text>
									{memory.source} · Saved {relativeTime(memory.created_at)} ·{" "}
									{(memory.access_count ?? 0) > 0
										? `Recalled ${memory.access_count} ${memory.access_count === 1 ? "time" : "times"}`
										: "Never recalled yet"}
								</Text>
							</DetailMeta>
						}
						actions={
							<Button
								variant="outline"
								size="sm"
								className={webView(memoryDetailClasses.deleteAction)}
								textClassName={webText(memoryDetailClasses.deleteAction)}
								disabled={action.busy || query.isFetching}
								onPress={remove}
							>
								<Icon as={Trash2} />
								<Text>{t("libraryPort.delete")}</Text>
							</Button>
						}
					/>
					<DetailPanel className={webView(memoryDetailClasses.panel)}>
						<WebView recipe={memoryDetailClasses.headingStack}>
							<WebText recipe={memoryDetailClasses.heading}>{t("libraryPort.recallScope")}</WebText>
							<WebText recipe={memoryDetailClasses.subtitle}>
								{t("libraryPort.recallDescription")}
							</WebText>
						</WebView>
						<WebView recipe={memoryDetailClasses.tags}>
							<WebText recipe={memoryDetailClasses.subtitle}>Tags:</WebText>
							{memory.tags?.map((tag) => (
								<Badge key={tag} variant="outline">
									<Text>#{tag}</Text>
								</Badge>
							))}
						</WebView>
						{memory.source_session_id || memory.source_machine_name ? (
							<WebView recipe={memoryDetailClasses.provenance}>
								<Icon as={Laptop} className={webBoth(memoryDetailClasses.sourceIcon)} />
								<Text>
									{memory.source_machine_name
										? `Learned on ${memory.source_machine_name}`
										: "Learned from a session"}
								</Text>
								{memory.source_session_id ? (
									<Button
										variant="link"
										size="sm"
										onPress={() =>
											router.push({
												pathname: "/sessions/[sessionId]",
												params: { sessionId: memory.source_session_id ?? "" },
											})
										}
									>
										<Text>View session</Text>
									</Button>
								) : null}
							</WebView>
						) : null}
					</DetailPanel>
				</>
			)}
			{action.error ? <ApiErrorPanel error={action.error} /> : null}
		</LibraryPage>
	);
}
