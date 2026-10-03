import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useRef } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { LoadingScreen } from "../ui/feedback";
import { DetailRow } from "../ui/metadata-row";
import { NativeButton } from "../ui/native-controls";
import { AppScrollView, AppText } from "../ui/primitives";
import { ReadScreen } from "../ui/read-screen";
import { BackButton, formatDate, isNotFound } from "./cloud-inventory";
import { MemoryRow } from "./memories";
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
	if (id && query.isPending && scope.isReady) return <LoadingScreen />;
	return (
		<ReadScreen>
			<AppScrollView contentContainerClassName="gap-4 p-6">
				<BackButton />
				<AppText accessibilityRole="header" className="text-2xl font-semibold text-foreground">
					{t("memories.detail")}
				</AppText>
				<AppText>{t("memories.recallScope")}</AppText>
				{!id || query.isError || !memory ? (
					<ResourceError
						missing={!id || isNotFound(query.error)}
						onRetry={id && !query.isFetching ? () => void query.refetch() : undefined}
					/>
				) : (
					<>
						<MemoryRow memory={memory} />
						<DetailRow
							label={t("memories.savedAt")}
							value={formatDate(memory.created_at) ?? t("memories.notRecorded")}
						/>
						<DetailRow label={t("memories.recalled")} value={String(memory.access_count ?? 0)} />
						{memory.source_machine_name ? (
							<DetailRow label={t("memories.learnedOn")} value={memory.source_machine_name} />
						) : null}
						{memory.source_session_id ? (
							<NativeButton
								label={t("memories.sourceSession")}
								onPress={() => {
									if (scope.isCurrent() && !scope.signal.aborted && memory.source_session_id)
										router.push({
											pathname: "/sessions/[sessionId]",
											params: { sessionId: memory.source_session_id },
										});
								}}
							/>
						) : null}
						<NativeButton
							label={t("inventory.refresh")}
							disabled={query.isFetching || action.busy}
							onPress={() => void query.refetch()}
						/>
						<NativeButton
							label={t("memories.remove")}
							disabled={action.busy || query.isFetching}
							onPress={remove}
						/>
					</>
				)}
				{action.error ? (
					<AppText accessibilityRole="alert">{t("memories.mutationFailed")}</AppText>
				) : null}
			</AppScrollView>
		</ReadScreen>
	);
}
