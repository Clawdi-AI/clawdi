import type { components } from "@clawdi/shared/api";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Alert, type FlatList } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../ui/primitives";
import { InventoryList } from "./inventory-list";
import { MemorySettings } from "./memory-settings";

type Memory = components["schemas"]["MemoryResponse"];

export function useCloudMemories(search = "") {
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useInfiniteQuery({
		queryKey: [...accountQueryKey(scope, "cloud-memories"), search],
		initialPageParam: 1,
		queryFn: ({ signal, pageParam }) =>
			read(
				(readSignal) =>
					cloud.listMemories(
						{ page: pageParam, page_size: 25, q: search || undefined },
						readSignal,
					),
				signal,
			),
		getNextPageParam: (page) =>
			!search && page.page * page.page_size < page.total ? page.page + 1 : undefined,
		enabled: scope.isReady,
		retry: false,
	});
}

export function MemoryRow({ memory, onOpen }: { memory: Memory; onOpen?: () => void }) {
	const t = useI18n();
	return (
		<AppView className="gap-2 rounded-2xl bg-surface p-4">
			<AppText selectable className="text-base leading-6 text-foreground">
				{memory.content}
			</AppText>
			<AppText className="text-xs text-muted">
				{memory.category || t("memories.unknown")} · {memory.source}
			</AppText>
			{memory.tags?.length ? (
				<AppText className="text-xs text-muted">{memory.tags.join(" · ")}</AppText>
			) : null}
			{onOpen ? <NativeButton label={t("memories.detail")} onPress={onOpen} /> : null}
		</AppView>
	);
}

export function MemoriesScreen() {
	const scope = useAccountScope();
	return <MemoriesView key={`${scope.accountKey}:${scope.generation}`} />;
}

function MemoriesView() {
	const t = useI18n();
	const router = useRouter();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { cloud } = useMobileApi();
	const action = useAuthAction(scope);
	const [content, setContent] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [searchDraft, setSearchDraft] = useState("");
	const [search, setSearch] = useState("");
	const listRef = useRef<FlatList<Memory>>(null);
	const memories = useCloudMemories(search);
	const items = [
		...new Map(
			(memories.data?.pages.flatMap((page) => page.items) ?? []).map((memory) => [
				memory.id,
				memory,
			]),
		).values(),
	];
	const save = () =>
		action.run(async (isCurrent) => {
			if (!content.trim()) return;
			await read(async (signal) => {
				if (editing) await cloud.updateMemory(editing, content.trim(), signal);
				else
					await cloud.createMemory(
						{ content: content.trim(), category: "fact", source: "manual" },
						signal,
					);
			});
			if (!isCurrent()) return;
			setContent("");
			setEditing(null);
			await memories.refetch();
		});
	const remove = (memory: Memory) => {
		const signal = scope.signal;
		Alert.alert(t("memories.remove"), t("memories.removeWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("memories.remove"),
				style: "destructive",
				onPress: () => {
					if (signal.aborted || !scope.isCurrent()) return;
					void action.run(async (isCurrent) => {
						await read((requestSignal) => cloud.deleteMemory(memory.id, requestSignal));
						if (!isCurrent()) return;
						if (editing === memory.id) {
							setEditing(null);
							setContent("");
						}
						await memories.refetch();
					});
				},
			},
		]);
	};
	return (
		<InventoryList
			listRef={listRef}
			header={
				<AppView className="gap-3">
					<MemorySettings />
					<AppTextInput
						accessibilityLabel={t("memories.search")}
						value={searchDraft}
						onChangeText={setSearchDraft}
						onSubmitEditing={() => setSearch(searchDraft.trim())}
						className="rounded-xl bg-surface p-3 text-foreground"
					/>
					<NativeButton
						label={t("memories.search")}
						onPress={() => setSearch(searchDraft.trim())}
					/>
					{search ? <AppText>{t("memories.searchLimit")}</AppText> : null}
					<AppText>{t(editing ? "memories.edit" : "memories.create")}</AppText>
					<AppTextInput
						multiline
						accessibilityLabel={t("memories.content")}
						value={content}
						onChangeText={setContent}
						editable={!action.busy}
						className="rounded-xl bg-surface p-3 text-foreground"
					/>
					<NativeButton
						label={t("memories.saveContent")}
						disabled={action.busy || !content.trim()}
						onPress={() => void save()}
					/>
					{editing ? (
						<NativeButton
							label={t("account.cancel")}
							disabled={action.busy}
							onPress={() => {
								setEditing(null);
								setContent("");
							}}
						/>
					) : null}
					{action.error ? (
						<AppText accessibilityRole="alert">{t("memories.mutationFailed")}</AppText>
					) : null}
				</AppView>
			}
			items={items}
			title={t("memories.title")}
			description={t("memories.description")}
			empty={t(memories.isPending ? "loading.app" : "memories.empty")}
			renderItem={(memory) => (
				<AppView className="gap-2">
					<MemoryRow
						memory={memory}
						onOpen={() => {
							if (scope.isCurrent() && !scope.signal.aborted)
								router.push({ pathname: "/memories/[memoryId]", params: { memoryId: memory.id } });
						}}
					/>
					<NativeButton
						label={t("memories.edit")}
						disabled={action.busy}
						onPress={() => {
							setEditing(memory.id);
							setContent(memory.content);
							listRef.current?.scrollToOffset({ offset: 0, animated: true });
						}}
					/>
					<NativeButton
						label={t("memories.remove")}
						disabled={action.busy}
						onPress={() => remove(memory)}
					/>
				</AppView>
			)}
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
