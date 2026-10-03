import type { components } from "@clawdi/shared/api";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { AppText, AppView } from "../ui/primitives";
import { InventoryList } from "./inventory-list";

type Memory = components["schemas"]["MemoryResponse"];

export function useCloudMemories() {
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useInfiniteQuery({
		queryKey: accountQueryKey(scope, "cloud-memories"),
		initialPageParam: 1,
		queryFn: ({ signal, pageParam }) =>
			read(
				(readSignal) => cloud.listMemories({ page: pageParam, page_size: 25 }, readSignal),
				signal,
			),
		getNextPageParam: (page) =>
			page.page * page.page_size < page.total ? page.page + 1 : undefined,
		enabled: scope.isReady,
		retry: false,
	});
}

export function MemoryRow({ memory }: { memory: Memory }) {
	const t = useI18n();
	return (
		<AppView className="gap-2 rounded-2xl bg-surface p-4">
			<AppText className="text-base leading-6 text-foreground">{memory.content}</AppText>
			<AppText className="text-xs text-muted">
				{memory.category || t("memories.unknown")} · {memory.source}
			</AppText>
			{memory.tags?.length ? (
				<AppText className="text-xs text-muted">{memory.tags.join(" · ")}</AppText>
			) : null}
		</AppView>
	);
}

export function MemoriesScreen() {
	const t = useI18n();
	const memories = useCloudMemories();
	const items = memories.data?.pages.flatMap((page) => page.items) ?? [];
	return (
		<InventoryList
			items={items}
			title={t("memories.title")}
			description={t("memories.description")}
			empty={t("memories.empty")}
			renderItem={(memory) => <MemoryRow memory={memory} />}
			refreshing={memories.isRefetching}
			onRefresh={() => {
				if (!memories.isFetching) void memories.refetch();
			}}
			error={memories.isError}
			onRetry={() => void memories.refetch()}
			busy={memories.isFetching}
			more={memories.hasNextPage}
			onMore={() => {
				if (!memories.isFetching) void memories.fetchNextPage();
			}}
		/>
	);
}
