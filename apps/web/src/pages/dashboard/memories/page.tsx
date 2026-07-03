"use client";

import { findLikelySecret, formatSecretMemoryWarning } from "@clawdi/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Brain, Database, Key, Laptop, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { TimeTooltip } from "@/components/time-tooltip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { unwrap, useApi } from "@/lib/api";
import type { Memory } from "@/lib/api-schemas";
import { MEMORY_CATEGORY_COLORS } from "@/lib/memory-utils";
import { getProjectResourceDefinition } from "@/lib/project-resource-model";
import { useDebouncedValue } from "@/lib/use-debounced";
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
const MEMORIES_RESOURCE = getProjectResourceDefinition("memories");

export default function MemoriesPage() {
	const api = useApi();
	const queryClient = useQueryClient();
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState<string>(ALL);
	const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
	const debouncedSearch = useDebouncedValue(search, 250);
	const apiCategory = category === ALL ? "" : category;

	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: async () => unwrap(await api.GET("/v1/settings")),
	});

	const provider =
		typeof settings?.memory_provider === "string" ? settings.memory_provider : "builtin";
	const mem0Key = typeof settings?.mem0_api_key === "string" ? settings.mem0_api_key : "";
	const hasMem0Key = mem0Key !== "";

	const updateSettings = useMutation({
		mutationFn: async (patch: Record<string, string>) =>
			unwrap(await api.PATCH("/v1/settings", { body: { settings: patch } })),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["settings"] });
			queryClient.invalidateQueries({ queryKey: ["memories"] });
		},
		onError: (e) => toast.error("Couldn't update settings", { description: errorMessage(e) }),
	});

	const { data, isLoading, isFetching, error } = useQuery({
		queryKey: ["memories", debouncedSearch, apiCategory, pagination.pageIndex, pagination.pageSize],
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/memories", {
					params: {
						query: {
							page: pagination.pageIndex + 1,
							page_size: pagination.pageSize,
							q: debouncedSearch || undefined,
							category: apiCategory || undefined,
						},
					},
				}),
			),
		placeholderData: keepPreviousData,
	});

	const memories = data?.items;
	const total = data?.total ?? 0;

	const deleteMemory = useMutation({
		mutationFn: async (id: string) =>
			unwrap(
				await api.DELETE("/v1/memories/{memory_id}", {
					params: { path: { memory_id: id } },
				}),
			),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["memories"] }),
		onError: (e) => toast.error("Couldn't delete memory", { description: errorMessage(e) }),
	});

	const requestDeleteMemory = useCallback((id: string) => deleteMemory.mutate(id), [deleteMemory]);

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
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}>
			<PageHeader
				title="Memories"
				description={MEMORIES_RESOURCE.managementDescription}
				actions={
					<>
						<ToggleGroup
							type="single"
							value={provider}
							onValueChange={(v) => v && updateSettings.mutate({ memory_provider: v })}
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

			{provider === "mem0" && !hasMem0Key ? (
				<Mem0KeyForm
					onSave={(key) => updateSettings.mutate({ mem0_api_key: key })}
					isPending={updateSettings.isPending}
				/>
			) : null}

			{/* Notes toolbar — search front and center, category chips beside. */}
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<SearchInput
					value={search}
					onChange={(v) => {
						setSearch(v);
						setPagination((p) => ({ ...p, pageIndex: 0 }));
					}}
					placeholder="Search memories…"
					className="w-full sm:max-w-md"
				/>
				<ToggleGroup
					type="single"
					value={category}
					onValueChange={(v) => {
						if (!v) return;
						setCategory(v);
						setPagination((p) => ({ ...p, pageIndex: 0 }));
					}}
					variant="outline"
					size="sm"
					spacing={1}
					className="w-full flex-wrap justify-start sm:w-fit"
				>
					{CATEGORIES.map((c) => (
						<ToggleGroupItem key={c.value} value={c.value}>
							{c.label}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			</div>

			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Couldn't load memories</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : (
				<div
					className={cn(
						"space-y-6 transition-opacity",
						isFetching && !isLoading ? "opacity-60" : "opacity-100",
					)}
				>
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
					<div key={index} className="rounded-xl border bg-card p-4">
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
		return <EmptyState bordered fillHeight={false} description={emptyMessage} />;
	}

	return (
		<div className="columns-1 gap-4 sm:columns-2 xl:columns-3 [&>*]:mb-4 [&>*]:break-inside-avoid">
			{memories.map((memory) => (
				<article
					key={memory.id}
					className="group relative z-0 rounded-xl border bg-card p-4 transition-all duration-150 hover:-translate-y-px hover:border-foreground/20"
				>
					<Link
						to="/memories/$id"
						params={{ id: memory.id }}
						aria-label={`Open memory ${memory.id.slice(0, 8)}`}
						className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					/>
					<p className="line-clamp-[8] break-words text-sm leading-relaxed">{memory.content}</p>
					<div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
						<Badge variant="secondary" className={cn(MEMORY_CATEGORY_COLORS[memory.category])}>
							{memory.category}
						</Badge>
						{memory.tags?.slice(0, 3).map((tag) => (
							<span key={tag} className="text-xs text-muted-foreground">
								#{tag}
							</span>
						))}
						<span className="ml-auto inline-flex items-center gap-2 text-xs text-muted-foreground">
							{memory.created_at ? (
								<TimeTooltip value={memory.created_at}>
									<span>{relativeTime(memory.created_at)}</span>
								</TimeTooltip>
							) : null}
							{memory.source_machine_name ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<span className="inline-flex min-w-0 items-center gap-1">
											<Laptop className="size-3 shrink-0" />
											<span className="max-w-28 truncate">{memory.source_machine_name}</span>
										</span>
									</TooltipTrigger>
									<TooltipContent>Learned on {memory.source_machine_name}</TooltipContent>
								</Tooltip>
							) : null}
						</span>
					</div>
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

function Mem0KeyForm({ onSave, isPending }: { onSave: (key: string) => void; isPending: boolean }) {
	const [apiKey, setApiKey] = useState("");
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
							if (e.key === "Enter" && apiKey) onSave(apiKey);
						}}
					/>
					<Button onClick={() => apiKey && onSave(apiKey)} disabled={!apiKey || isPending}>
						{isPending ? <Spinner /> : <Key />}
						Save API Key
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

function AddMemoryForm() {
	const api = useApi();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [content, setContent] = useState("");
	const [addCategory, setAddCategory] = useState("fact");
	const secretFinding = findLikelySecret(content);

	const createMemory = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.POST("/v1/memories", {
					body: { content, category: addCategory, source: "web" },
				}),
			),
		onSuccess: () => {
			setContent("");
			setOpen(false);
			queryClient.invalidateQueries({ queryKey: ["memories"] });
		},
		onError: (e) => toast.error("Couldn't add memory", { description: errorMessage(e) }),
	});

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setContent("");
			}}
		>
			<DialogTrigger asChild>
				<Button size="sm">
					<Plus />
					New memory
				</Button>
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
						<Alert variant="destructive">
							<AlertCircle />
							<AlertTitle>Use Vault for secrets</AlertTitle>
							<AlertDescription>{formatSecretMemoryWarning(secretFinding)}</AlertDescription>
						</Alert>
					) : null}
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-2">
							<Label htmlFor="memory-category" className="text-sm text-muted-foreground">
								Category
							</Label>
							<Select value={addCategory} onValueChange={setAddCategory}>
								<SelectTrigger id="memory-category" size="sm" className="w-32">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CATEGORIES.filter((c) => c.value !== ALL).map((c) => (
										<SelectItem key={c.value} value={c.value}>
											{c.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<Button
							onClick={() => content.trim() && createMemory.mutate()}
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
