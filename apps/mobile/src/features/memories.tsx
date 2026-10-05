import { findLikelySecret, formatSecretMemoryWarning } from "@clawdi/shared";
import type { components } from "@clawdi/shared/api";
import { isSearchQueryReady } from "@clawdi/shared/consts";
import { ENTITY_CARD_MASONRY_CLASS, memoriesSurfaceClasses } from "@clawdi/shared/ui";
import {
	memoryFormCopy as copy,
	getProjectResourceDefinition,
	MEMORY_CATEGORIES,
} from "@clawdi/shared/view";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react-native";
import { useEffect, useState } from "react";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { ApiErrorPanel } from "../ui/api-error-panel";
import { Button } from "../ui/button";
import { LibraryPage } from "../ui/detail/layout";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { EmptyState } from "../ui/empty-state";
import { HeroCardSkeleton } from "../ui/entity-card";
import { Icon } from "../ui/icon";
import { Input, Label } from "../ui/input";
import { ListToolbar } from "../ui/list-toolbar";
import { MemoryCard } from "../ui/memories/memory-card";
import { PageHeader } from "../ui/page-header";
import { SearchInput } from "../ui/search-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Text } from "../ui/text";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { useConfirmation } from "../ui/use-confirmation";
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
	const confirmationDialog = useConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { cloud } = useMobileApi();
	const action = useAuthAction(scope);
	const [content, setContent] = useState("");
	const [addCategory, setAddCategory] = useState("fact");
	const secretFinding = findLikelySecret(content);
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
			if (!content.trim() || secretFinding) return;
			await read(async (signal) => {
				if (editing) await cloud.updateMemory(editing, content.trim(), signal);
				else
					await cloud.createMemory(
						{ content: content.trim(), category: addCategory, source: "manual" },
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
		confirmationDialog.show(copy.deleteTitle, copy.deleteDescription, [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: copy.delete,
				style: "destructive",
				onPress: () => {
					if (signal.aborted || !scope.isCurrent()) return;
					return action.run(async (isCurrent) => {
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
								searchQuery={searchQuery}
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
				<DialogContent
					className={webView(memoriesSurfaceClasses.dialog)}
					showCloseButton={!action.busy}
				>
					<DialogHeader>
						<DialogTitle>{editing ? t("memories.edit") : copy.title}</DialogTitle>
						<DialogDescription>{copy.description}</DialogDescription>
					</DialogHeader>
					<Input
						multiline
						value={content}
						onChangeText={setContent}
						editable={!action.busy}
						accessibilityLabel={copy.content}
						placeholder={copy.placeholder}
						style={{ minHeight: 120 }}
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
					<DialogFooter>
						<Button variant="ghost" disabled={action.busy} onPress={() => setOpen(false)}>
							<Text>{copy.cancel}</Text>
						</Button>
						<Button
							disabled={action.busy || !content.trim() || Boolean(secretFinding)}
							onPress={() => void save()}
						>
							{!editing ? <Icon as={Plus} /> : null}
							<Text>{editing ? t("libraryPort.save") : copy.save}</Text>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{confirmationDialog.dialog}
		</LibraryPage>
	);
}
