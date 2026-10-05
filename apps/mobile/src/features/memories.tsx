import type { components } from "@clawdi/shared/api";
import { isSearchQueryReady } from "@clawdi/shared/consts";
import { ENTITY_CARD_MASONRY_CLASS, memoriesSurfaceClasses } from "@clawdi/shared/ui";
import { getProjectResourceDefinition, MEMORY_CATEGORIES } from "@clawdi/shared/view";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Plus } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { ApiErrorPanel } from "../ui/api-error-panel";
import { Button } from "../ui/button";
import { LibraryPage } from "../ui/detail/layout";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { EmptyState } from "../ui/empty-state";
import { HeroCardSkeleton } from "../ui/entity-card";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { ListToolbar } from "../ui/list-toolbar";
import { MemoryCard } from "../ui/memories/memory-card";
import { PageHeader } from "../ui/page-header";
import { SearchInput } from "../ui/search-input";
import { Text } from "../ui/text";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { WebView, webView } from "../ui/web-layout";

import { MemorySettings } from "./memory-settings";

type Memory = components["schemas"]["MemoryResponse"];

export function useCloudMemories(search = "", category = "all") {
	const { cloud } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useInfiniteQuery({
		queryKey: [...accountQueryKey(scope, "cloud-memories"), search, category],
		initialPageParam: 1,
		queryFn: ({ signal, pageParam }) =>
			read(
				(readSignal) =>
					cloud.listMemories(
						{
							page: pageParam,
							page_size: 25,
							q: search || undefined,
							category: category === "all" ? undefined : category,
						},
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

export function MemoryRow({ memory }: { memory: Memory; onOpen?: () => void }) {
	return <MemoryCard memory={memory} />;
}
export function MemoriesScreen() {
	const scope = useAccountScope();
	return <MemoriesView key={`${scope.accountKey}:${scope.generation}`} />;
}

function MemoriesView() {
	const t = useI18n();
	const _router = useRouter();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { cloud } = useMobileApi();
	const action = useAuthAction(scope);
	const [content, setContent] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [category, setCategory] = useState("all");
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");

	const [debouncedSearch, setDebouncedSearch] = useState(search);
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedSearch(search), 250);
		return () => clearTimeout(timer);
	}, [search]);
	const searchQuery = isSearchQueryReady(debouncedSearch.trim()) ? debouncedSearch.trim() : "";
	const memories = useCloudMemories(searchQuery, category);
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
			setOpen(false);
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
							setOpen(false);
							setContent("");
						}
						await memories.refetch();
					});
				},
			},
		]);
	};
	return (
		<LibraryPage>
			<PageHeader
				title={t("memories.title")}
				description={getProjectResourceDefinition("memories").managementDescription}
				actions={
					<>
						<MemorySettings />
						<Button
							size="sm"
							onPress={() => {
								setEditing(null);
								setContent("");
								setOpen(true);
							}}
						>
							<Icon as={Plus} />
							<Text>{t("libraryPort.createMemory")}</Text>
						</Button>
					</>
				}
			/>
			<ListToolbar
				search={
					<SearchInput
						value={search}
						onChange={setSearch}
						placeholder={t("libraryPort.searchMemories")}
					/>
				}
				filters={
					<ToggleGroup
						value={[category]}
						onValueChange={(v) => {
							if (v[0]) setCategory(v[0]);
						}}
						variant="outline"
						size="sm"
						spacing={1}
						className={webView(memoriesSurfaceClasses.filters)}
					>
						{MEMORY_CATEGORIES.map((c) => (
							<ToggleGroupItem key={c.value} value={c.value}>
								{c.label}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				}
			/>
			{memories.error ? (
				<ApiErrorPanel error={memories.error} onRetry={() => void memories.refetch()} />
			) : null}
			<WebView recipe={ENTITY_CARD_MASONRY_CLASS}>
				{memories.isPending
					? [0, 1, 2].map((i) => <HeroCardSkeleton key={i} />)
					: items.map((memory) => (
							<MemoryCard
								key={memory.id}
								memory={memory}
								onDelete={() => remove(memory)}
								onEdit={() => {
									setEditing(memory.id);
									setContent(memory.content);
									setOpen(true);
								}}
							/>
						))}
			</WebView>
			{!memories.isPending && !memories.error && !items.length ? (
				<EmptyState
					description={t(
						search || category !== "all" ? "libraryPort.noMemoryMatches" : "libraryPort.noMemories",
					)}
				/>
			) : null}
			{memories.hasNextPage ? (
				<Button
					variant="outline"
					disabled={memories.isFetching}
					onPress={() => void memories.fetchNextPage()}
				>
					<Text>{t("inventory.loadMore")}</Text>
				</Button>
			) : null}
			<Dialog
				open={open}
				onOpenChange={(v) => {
					if (!action.busy) setOpen(v);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t(editing ? "memories.edit" : "libraryPort.createMemory")}</DialogTitle>
					</DialogHeader>
					<Input
						multiline
						value={content}
						onChangeText={setContent}
						editable={!action.busy}
						accessibilityLabel={t("libraryPort.content")}
					/>
					{action.error ? <ApiErrorPanel error={action.error} /> : null}
					<DialogFooter>
						<Button disabled={action.busy || !content.trim()} onPress={() => void save()}>
							<Text>{t(editing ? "libraryPort.save" : "libraryPort.createMemory")}</Text>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</LibraryPage>
	);
}
