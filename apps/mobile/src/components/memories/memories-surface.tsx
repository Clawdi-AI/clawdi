import { findLikelySecret, formatSecretMemoryWarning } from "@clawdi/shared";
import type { components } from "@clawdi/shared/api";
import { isSearchQueryReady } from "@clawdi/shared/consts";
import { memoriesSurfaceClasses } from "@clawdi/shared/ui";
import {
	memoryFormCopy as copy,
	getProjectResourceDefinition,
	MEMORY_CATEGORIES,
} from "@clawdi/shared/view";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Plus } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { HeroCardSkeleton } from "@/components/entity-card";
import { MemoryCard } from "@/components/memories/memory-card";
import { MemorySettings } from "@/components/memories/memory-settings";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { NativeList } from "@/components/ui/native-list";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { WebView, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useHeaderSearch } from "@/platform/navigation/native-header";
import { useSheet } from "@/platform/navigation/use-sheet";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

type Memory = components["schemas"]["MemoryResponse"];

function useCloudMemories(search = "", category = "all") {
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

export function MemoriesScreen() {
	const scope = useAccountScope();
	return <MemoriesView key={`${scope.accountKey}:${scope.generation}`} />;
}

function MemoriesView() {
	const t = useI18n();
	const confirmationDialog = useConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { cloud } = useMobileApi();
	const action = useAuthAction(scope);
	const [category, setCategory] = useState("all");
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
	const remove = (memory: Memory) => {
		const signal = scope.signal;
		confirmationDialog.show(copy.deleteTitle, copy.deleteDescription, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: copy.delete,
				style: "destructive",
				onPress: () => {
					if (signal.aborted || !scope.isCurrent()) return;
					return action.runOrThrow(async (isCurrent) => {
						await read((requestSignal) => cloud.deleteMemory(memory.id, requestSignal));
						if (!isCurrent()) return;
						await memories.refetch();
					});
				},
			},
		]);
	};

	const searchOptions = useHeaderSearch({
		value: search,
		onChange: setSearch,
		placeholder: t("libraryPort.searchMemories"),
	});
	return (
		<SafeAreaScreen>
			<Stack.Screen
				options={{ headerSearchBarOptions: searchOptions, headerLargeTitleEnabled: true }}
			/>
			<NativeList
				data={items}
				keyExtractor={(memory) => memory.id}
				refreshing={memories.isRefetching && !memories.isFetchingNextPage}
				onRefresh={() => void memories.refetch()}
				hasMore={memories.hasNextPage}
				loadingMore={memories.isFetching}
				onLoadMore={() => void memories.fetchNextPage().catch(() => undefined)}
				header={
					<>
						<PageHeader
							title={t("memories.title")}
							description={getProjectResourceDefinition("memories").managementDescription}
							headerMenu={{
								label: t("memories.title"),
								items: [
									{
										id: "create",
										label: t("libraryPort.createMemory"),
										onPress: () => router.push("/memories/new"),
									},
								],
								// Six categories exceed an iPhone segmented control; a single-choice menu fits.
								sections: [
									{
										id: "category",
										title: copy.category,
										items: MEMORY_CATEGORIES.map((c) => ({
											id: `category-${c.value}`,
											label: c.label,
											selected: c.value === category,
											onPress: () => setCategory(c.value),
										})),
									},
								],
							}}
						/>
						{memories.error ? (
							<ApiErrorPanel error={memories.error} onRetry={() => void memories.refetch()} />
						) : null}
						<MemorySettings />
					</>
				}
				renderItem={({ item: memory }) => (
					<MemoryCard
						key={memory.id}
						memory={memory}
						searchQuery={searchQuery}
						onDelete={() => remove(memory)}
						onEdit={() => {
							router.push({ pathname: "/memories/[id]/edit", params: { id: memory.id } });
						}}
					/>
				)}
				empty={
					memories.isPending ? (
						<HeroCardSkeleton />
					) : !memories.error ? (
						<EmptyState
							description={t(
								search || category !== "all"
									? "libraryPort.noMemoryMatches"
									: "libraryPort.noMemories",
							)}
						/>
					) : null
				}
			/>
			{confirmationDialog.dialog}
		</SafeAreaScreen>
	);
}

export function MemoryEditorScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ id?: string }>();
	return (
		<MemoryEditor
			key={`${scope.identity}:${scope.generation}:${params.id ?? "new"}`}
			id={routeParam(params.id)}
		/>
	);
}
function MemoryEditor({ id: editing }: { id?: string }) {
	const t = useI18n(),
		scope = useAccountScope(),
		read = useAccountRead(),
		capture = useForegroundLease();
	const { cloud } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [content, setContent] = useState("");
	const [addCategory, setAddCategory] = useState("fact");
	const [closeError, setCloseError] = useState<unknown>();
	const secretFinding = findLikelySecret(content);
	const memory = useQuery({
		queryKey: accountQueryKey(scope, "memory-detail", editing),
		queryFn: ({ signal }) => read((s) => cloud.getMemory(editing ?? "", s), signal),
		enabled: scope.isReady && Boolean(editing),
		retry: false,
	});
	const initialized = useRef(false);
	useEffect(() => {
		if (memory.data && !initialized.current) {
			initialized.current = true;
			setContent(memory.data.content);
		}
	}, [memory.data]);
	const sheet = useSheet<boolean>({ fallback: "/memories", busy: action.busy });
	const save = () =>
		action.run(async (current) => {
			const visible = capture();
			if (!content.trim() || secretFinding || !visible()) return;
			await read(async (s) => {
				if (editing) await cloud.updateMemory(editing, content.trim(), s);
				else
					await cloud.createMemory(
						{ content: content.trim(), category: addCategory, source: "manual" },
						s,
					);
			});
			if (!current()) return;
			setContent("");
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
			if (current() && visible()) await sheet.close(true);
		});
	return (
		<SheetPage
			title={editing ? t("memories.edit") : copy.title}
			description={copy.description}
			fallback="/memories"
			busy={action.busy}
			sheet={sheet}
		>
			{editing && (memory.isPending || memory.isError) ? (
				memory.isPending ? (
					<HeroCardSkeleton />
				) : (
					<ApiErrorPanel error={memory.error} onRetry={() => void memory.refetch()} />
				)
			) : (
				<WebView recipe={memoriesSurfaceClasses.section}>
					<Input
						multiline
						value={content}
						onChangeText={setContent}
						editable={!action.busy}
						accessibilityLabel={copy.content}
						placeholder={copy.placeholder}
					/>
					{secretFinding ? (
						<ApiErrorPanel error={formatSecretMemoryWarning(secretFinding)} title={copy.secrets} />
					) : null}
					{!editing ? (
						<WebView recipe={memoriesSurfaceClasses.fieldRow} className="flex-row">
							<Label>{copy.category}</Label>
							<Select
								value={addCategory}
								onValueChange={(value) => {
									if (value) setAddCategory(value);
								}}
								disabled={action.busy}
							>
								<SelectTrigger size="sm" className={webView(memoriesSurfaceClasses.categorySelect)}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{MEMORY_CATEGORIES.filter((c) => c.value !== "all").map((c) => (
										<SelectItem key={c.value} value={c.value}>
											{c.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</WebView>
					) : null}
					{action.error ? <ApiErrorPanel error={action.error} /> : null}
					<WebView recipe={memoriesSurfaceClasses.section}>
						<Button
							variant="ghost"
							disabled={action.busy}
							onPress={() => void sheet.close().catch(setCloseError)}
						>
							<Text>{copy.cancel}</Text>
						</Button>
						<Button
							disabled={action.busy || !content.trim() || Boolean(secretFinding)}
							onPress={() => void save()}
						>
							{!editing ? <Icon as={Plus} /> : null}
							<Text>{editing ? t("libraryPort.save") : copy.save}</Text>
						</Button>
					</WebView>
				</WebView>
			)}
			{closeError ? <ApiErrorPanel error={closeError} /> : null}
		</SheetPage>
	);
}
