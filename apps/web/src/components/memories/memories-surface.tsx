"use client";

import { findLikelySecret, formatSecretMemoryWarning } from "@clawdi/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Brain, Database, Key, Laptop, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { EntityMeta, HERO_CARD_BASE } from "@/components/entity-card";
import { ListToolbar } from "@/components/list-toolbar";
import { memorySettingsForCache } from "@/components/memories/memory-settings-cache";
import { TimeTooltip } from "@/components/time-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchInput } from "@/components/ui/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import type { Memory } from "@/lib/api-schemas";
import { MEMORY_CATEGORY_COLORS } from "@/lib/memory-utils";
import { shouldBlockQueryError } from "@/lib/query-state";
import { useDebouncedValue } from "@/lib/use-debounced";
import { useSensitiveAction } from "@/lib/use-sensitive-action";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

const CATEGORIES = [
	{ value: "all", label: "All" },
	{ value: "fact", label: "Fact" },
	{ value: "preference", label: "Preference" },
	{ value: "pattern", label: "Pattern" },
	{ value: "decision", label: "Decision" },
	{ value: "context", label: "Context" },
] as const;

// "all" is a local UI sentinel; the API uses an empty category string to mean
// "no filter". Keep them separate so ToggleGroup can render a selected state
// for the All chip (Radix does not treat "" as a selected value).
const ALL = "all";
const ADD_CATEGORY_ITEMS = CATEGORIES.filter((category) => category.value !== ALL);

export function MemoriesSurface() {
	const api = useApi();
	const $api = useOpenApi();
	const queryClient = useQueryClient();
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState<string>(ALL);
	const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
	const debouncedSearch = useDebouncedValue(search, 250);
	const apiCategory = category === ALL ? "" : category;

	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: async () => memorySettingsForCache(unwrap(await api.GET("/v1/settings"))),
	});

	const provider =
		typeof settings?.memory_provider === "string" ? settings.memory_provider : "builtin";
	const hasMem0Key = settings?.mem0_api_key_configured === true;

	const updateSettings = useMutation({
		mutationFn: async (memoryProvider: "builtin" | "mem0") =>
			unwrap(
				await api.PATCH("/v1/settings", {
					body: { settings: { memory_provider: memoryProvider } },
				}),
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["settings"] });
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/memories"] });
		},
		onError: (e) => toast.error("Couldn't update settings", { description: errorMessage(e) }),
	});
	const saveMem0Key = useSensitiveAction(async (key: string) => {
		try {
			const result = unwrap(
				await api.PATCH("/v1/settings", { body: { settings: { mem0_api_key: key } } }),
			);
			queryClient.invalidateQueries({ queryKey: ["settings"] });
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/memories"] });
			return result;
		} catch (error) {
			toast.error("Couldn't update settings", { description: errorMessage(error) });
			throw error;
		}
	});

	const { data, isLoading, error, refetch } = $api.useQuery(
		"get",
		"/v1/memories",
		{
			params: {
				query: {
					page: pagination.pageIndex + 1,
					page_size: pagination.pageSize,
					q: debouncedSearch || undefined,
					category: apiCategory || undefined,
				},
			},
		},
		{ placeholderData: keepPreviousData },
	);

	const memories = data?.items;
	const total = data?.total ?? 0;

	const deleteMemory = $api.useMutation("delete", "/v1/memories/{memory_id}", {
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["get", "/v1/memories"] }),
		onError: (e) => toast.error("Couldn't delete memory", { description: errorMessage(e) }),
	});

	const requestDeleteMemory = useCallback(
		(id: string) => deleteMemory.mutate({ params: { path: { memory_id: id } } }),
		[deleteMemory],
	);

	const emptyMessage =
		debouncedSearch || apiCategory
			? "No matches — try a different search or category."
			: "No memories yet. Add one above, or your agents will create them automatically as they work.";
	const paginationFooter = (
		<DataTablePagination
			page={pagination.pageIndex + 1}
			pageSize={pagination.pageSize}
			total={total}
			onPageChange={(p) => setPagination((s) => ({ ...s, pageIndex: p - 1 }))}
			onPageSizeChange={(size) => setPagination(() => ({ pageIndex: 0, pageSize: size }))}
		/>
	);
	return (
		<div className="space-y-6" data-testid="memories-surface">
			{provider === "mem0" && !hasMem0Key ? (
				<Mem0KeyForm onSave={saveMem0Key.execute} isPending={saveMem0Key.isPending} />
			) : null}

			<ListToolbar
				search={
					<SearchInput
						value={search}
						onChange={(v) => {
							setSearch(v);
							setPagination((p) => ({ ...p, pageIndex: 0 }));
						}}
						placeholder="Search memories…"
					/>
				}
				filters={
					<ToggleGroup
						value={[category]}
						onValueChange={(v) => {
							const selected = v[0];
							if (!selected) return;
							setCategory(selected);
							setPagination((p) => ({ ...p, pageIndex: 0 }));
						}}
						variant="outline"
						size="sm"
						spacing={1}
						className="flex-wrap justify-start"
					>
						{CATEGORIES.map((c) => (
							<ToggleGroupItem key={c.value} value={c.value}>
								{c.label}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				}
				actions={
					<>
						<ToggleGroup
							value={[provider]}
							onValueChange={(v) => {
								const selected = v[0];
								if (selected === "builtin" || selected === "mem0") {
									updateSettings.mutate(selected);
								}
							}}
							disabled={updateSettings.isPending}
							variant="outline"
							size="sm"
						>
							<ToggleGroupItem value="builtin">
								<Database />
								Built-in
							</ToggleGroupItem>
							<ToggleGroupItem value="mem0">
								<Brain />
								Mem0
							</ToggleGroupItem>
						</ToggleGroup>
						<AddMemoryForm />
					</>
				}
			/>

			{shouldBlockQueryError(error, data) ? (
				<ApiErrorPanel
					error={error}
					onRetry={() => {
						void refetch();
					}}
					title="Couldn't load memories"
				/>
			) : (
				<div className="space-y-6">
					<MemoryNotesGrid
						memories={memories ?? []}
						isLoading={isLoading}
						emptyMessage={emptyMessage}
						onDelete={requestDeleteMemory}
					/>
					{paginationFooter}
				</div>
			)}
		</div>
	);
}

function MemoryNotesGrid({
	memories,
	isLoading,
	emptyMessage,
	onDelete,
}: {
	memories: Memory[];
	isLoading: boolean;
	emptyMessage: ReactNode;
	onDelete: (id: string) => void;
}) {
	if (isLoading) {
		const cardLineCounts = [4, 7, 3, 5, 6, 4, 8, 3, 5];
		return (
			<div className="columns-1 gap-4 sm:columns-2 xl:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
				{cardLineCounts.map((lineCount, index) => (
					<div key={index} className={HERO_CARD_BASE}>
						<div className="space-y-2">
							{Array.from({ length: lineCount }).map((_, lineIndex) => (
								<Skeleton
									key={lineIndex}
									className={cn("h-4", lineIndex === lineCount - 1 ? "w-2/3" : "w-full")}
								/>
							))}
						</div>
						<div className="mt-4 flex items-center gap-2">
							<Skeleton className="h-5 w-24 rounded-full" />
							<Skeleton className="h-3 w-14" />
							<Skeleton className="ml-auto h-3 w-20" />
						</div>
					</div>
				))}
			</div>
		);
	}

	if (!memories.length) {
		return <EmptyState description={emptyMessage} />;
	}

	return (
		<div className="columns-1 gap-4 sm:columns-2 xl:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
			{memories.map((memory) => (
				<article
					key={memory.id}
					className={cn(
						HERO_CARD_BASE,
						"group relative z-0 transition-all duration-150 hover:-translate-y-px hover:border-foreground/20",
					)}
				>
					<Link
						to="/memories/$id"
						params={{ id: memory.id }}
						aria-label={`Open memory ${memory.id.slice(0, 8)}`}
						className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					/>
					<p className="line-clamp-[8] break-words text-sm leading-relaxed">{memory.content}</p>
					<EntityMeta
						className="mt-3 text-xs"
						items={[
							<Badge
								key="category"
								variant="secondary"
								className={cn(MEMORY_CATEGORY_COLORS[memory.category])}
							>
								{memory.category}
							</Badge>,
							...(memory.tags?.slice(0, 3).map((tag) => `#${tag}`) ?? []),
							memory.created_at ? (
								<TimeTooltip key="created" value={memory.created_at}>
									<span>{relativeTime(memory.created_at)}</span>
								</TimeTooltip>
							) : null,
							memory.source_machine_name ? (
								<Tooltip key="machine">
									<TooltipTrigger
										render={<span className="inline-flex min-w-0 items-center gap-1" />}
									>
										<Laptop className="size-3 shrink-0" />
										<span className="max-w-28 truncate">{memory.source_machine_name}</span>
									</TooltipTrigger>
									<TooltipContent>Learned on {memory.source_machine_name}</TooltipContent>
								</Tooltip>
							) : null,
						]}
					/>
					<span className="absolute right-2 top-2 z-10 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
						<ConfirmAction
							title="Delete this memory?"
							description={<p>Your AI will stop recalling it on every agent within seconds.</p>}
							confirmLabel="Delete memory"
							destructive
							onConfirm={() => onDelete(memory.id)}
						>
							<Button
								variant="ghost"
								size="icon-sm"
								className="bg-card/80 text-muted-foreground backdrop-blur-sm hover:text-destructive"
								aria-label="Delete memory"
							>
								<Trash2 className="size-3.5" />
							</Button>
						</ConfirmAction>
					</span>
				</article>
			))}
		</div>
	);
}

function Mem0KeyForm({
	onSave,
	isPending,
}: {
	onSave: (key: string) => Promise<unknown>;
	isPending: boolean;
}) {
	const [apiKey, setApiKey] = useState("");
	async function submit() {
		if (!apiKey || isPending) return;
		try {
			await onSave(apiKey);
			setApiKey("");
		} catch {
			// The parent action surfaces the error; retain the value for an explicit retry.
		}
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2 text-sm">
					<Key className="size-4" />
					Mem0 Configuration
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				<p className="text-sm text-muted-foreground">
					Enter your Mem0 API key to use semantic memory search.
				</p>
				<Label htmlFor="mem0-api-key" className="text-xs font-medium">
					Mem0 API key
				</Label>
				<div className="flex gap-2">
					<Input
						id="mem0-api-key"
						name="mem0-api-key"
						type="password"
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder="m0-…"
						className="flex-1 font-mono"
						autoComplete="off"
						spellCheck={false}
						onKeyDown={(e) => {
							if (e.key === "Enter" && apiKey) void submit();
						}}
					/>
					<Button onClick={() => void submit()} disabled={!apiKey || isPending}>
						{isPending ? <Spinner /> : <Key />}
						Save API Key
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

function AddMemoryForm() {
	const api = useOpenApi();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [content, setContent] = useState("");
	const [addCategory, setAddCategory] = useState("fact");
	const secretFinding = findLikelySecret(content);

	const createMemory = api.useMutation("post", "/v1/memories", {
		onSuccess: () => {
			setOpen(false);
			queryClient.invalidateQueries({ queryKey: ["get", "/v1/memories"] });
		},
		onError: (e) => toast.error("Couldn't add memory", { description: errorMessage(e) }),
	});

	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
			onOpenChangeComplete={(next) => {
				if (!next) setContent("");
			}}
		>
			<DialogTrigger render={<Button size="sm" />}>
				<Plus />
				New memory
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>New memory</DialogTitle>
					<DialogDescription>
						A note your AI recalls on every agent, across machines.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="memory-content" className="sr-only">
							Memory content
						</Label>
						<Textarea
							id="memory-content"
							name="memory-content"
							value={content}
							onChange={(e) => setContent(e.target.value)}
							placeholder="Prefer concise PR summaries…"
							rows={5}
							autoFocus
							className="resize-none"
						/>
					</div>
					{secretFinding ? (
						<ApiErrorPanel
							error={formatSecretMemoryWarning(secretFinding)}
							title="Use Vault for secrets"
						/>
					) : null}
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<Label htmlFor="memory-category" className="text-sm text-muted-foreground">
								Category
							</Label>
							<Select
								items={ADD_CATEGORY_ITEMS}
								value={addCategory}
								onValueChange={(value) => {
									if (value !== null) setAddCategory(value);
								}}
							>
								<SelectTrigger id="memory-category" size="sm" className="w-32">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ADD_CATEGORY_ITEMS.map((c) => (
										<SelectItem key={c.value} value={c.value}>
											{c.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<Button
							onClick={() =>
								content.trim() &&
								createMemory.mutate({
									body: { content, category: addCategory, source: "web" },
								})
							}
							disabled={!content.trim() || !!secretFinding || createMemory.isPending}
						>
							{createMemory.isPending ? <Spinner /> : <Plus />}
							Save memory
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
