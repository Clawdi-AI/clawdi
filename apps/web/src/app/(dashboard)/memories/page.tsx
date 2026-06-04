"use client";

import { findLikelySecret, formatSecretMemoryWarning } from "@clawdi/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Brain, Database, Key, Laptop, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	DashboardSection,
	DashboardSectionHeader,
	DashboardSectionToolbar,
} from "@/components/dashboard/section";
import { makeMemoryColumns } from "@/components/memories/memory-columns";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { DataTable } from "@/components/ui/data-table";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { DataTableToolbar } from "@/components/ui/data-table-toolbar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { unwrap, useApi } from "@/lib/api";
import type { Memory } from "@/lib/api-schemas";
import { MEMORY_CATEGORY_COLORS } from "@/lib/memory-utils";
import { getProjectResourceDefinition, memoryDetailHref } from "@/lib/project-resource-model";
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
		queryFn: async () => unwrap(await api.GET("/api/settings")),
	});

	const provider =
		typeof settings?.memory_provider === "string" ? settings.memory_provider : "builtin";
	const mem0Key = typeof settings?.mem0_api_key === "string" ? settings.mem0_api_key : "";
	const hasMem0Key = mem0Key !== "";

	const updateSettings = useMutation({
		mutationFn: async (patch: Record<string, string>) =>
			unwrap(await api.PATCH("/api/settings", { body: { settings: patch } })),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["settings"] });
			queryClient.invalidateQueries({ queryKey: ["memories"] });
		},
		onError: (e) => toast.error("Failed to Update Settings", { description: errorMessage(e) }),
	});

	const { data, isLoading, error } = useQuery({
		queryKey: ["memories", debouncedSearch, apiCategory, pagination.pageIndex, pagination.pageSize],
		queryFn: async () =>
			unwrap(
				await api.GET("/api/memories", {
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
	});

	const memories = data?.items;
	const total = data?.total ?? 0;

	const deleteMemory = useMutation({
		mutationFn: async (id: string) =>
			unwrap(
				await api.DELETE("/api/memories/{memory_id}", {
					params: { path: { memory_id: id } },
				}),
			),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["memories"] }),
		onError: (e) => toast.error("Failed to Delete Memory", { description: errorMessage(e) }),
	});

	const requestDeleteMemory = useCallback((id: string) => deleteMemory.mutate(id), [deleteMemory]);

	const columns = useMemo(() => makeMemoryColumns(requestDeleteMemory), [requestDeleteMemory]);

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
	const tableToolbar = (
		<DashboardSectionToolbar>
			<DataTableToolbar
				value={search}
				onChange={(v) => {
					setSearch(v);
					setPagination((p) => ({ ...p, pageIndex: 0 }));
				}}
				placeholder="Search memories…"
			>
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
			</DataTableToolbar>
		</DashboardSectionToolbar>
	);

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Memories"
				description={MEMORIES_RESOURCE.managementDescription}
				actions={
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
				}
			/>

			{provider === "mem0" && !hasMem0Key ? (
				<Mem0KeyForm
					onSave={(key) => updateSettings.mutate({ mem0_api_key: key })}
					isPending={updateSettings.isPending}
				/>
			) : null}

			<DashboardSection>
				<DashboardSectionHeader
					icon={Brain}
					title="Memory Library"
					count={data ? `${total} memor${total === 1 ? "y" : "ies"}` : undefined}
					description="Account-level notes agents can recall across runs. They are not shared through Projects."
				/>
				<div className="border-b px-4 py-3">
					<AddMemoryForm />
				</div>

				{error ? (
					<div className="p-4">
						<Alert variant="destructive">
							<AlertCircle />
							<AlertTitle>Couldn't load memories</AlertTitle>
							<AlertDescription>{errorMessage(error)}</AlertDescription>
						</Alert>
					</div>
				) : (
					<>
						<div className="md:hidden">
							{tableToolbar}
							<div className="p-4">
								<MobileMemoryList
									memories={memories ?? []}
									isLoading={isLoading}
									emptyMessage={emptyMessage}
									onDelete={requestDeleteMemory}
								/>
								<div className="mt-3">{paginationFooter}</div>
							</div>
						</div>
						<div className="hidden md:block">
							<DataTable
								columns={columns}
								data={memories ?? []}
								isLoading={isLoading}
								getRowHref={(m) => memoryDetailHref(m.id)}
								rowAriaLabel={(m) => `Open memory ${m.id.slice(0, 8)}`}
								emptyMessage={emptyMessage}
								pagination={pagination}
								onPaginationChange={setPagination}
								pageCount={Math.max(1, Math.ceil(total / pagination.pageSize))}
								toolbar={tableToolbar}
								footer={<div className="border-t px-4 py-3">{paginationFooter}</div>}
								className="space-y-0"
								tableContainerClassName="rounded-none border-x-0 border-b-0 bg-transparent"
							/>
						</div>
					</>
				)}
			</DashboardSection>
		</div>
	);
}

function MobileMemoryList({
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
		return (
			<div className="mt-3 space-y-2">
				{Array.from({ length: 3 }).map((_, index) => (
					<div key={index} className="rounded-lg border bg-card p-3">
						<Skeleton className="h-4 w-5/6" />
						<Skeleton className="mt-2 h-4 w-2/3" />
						<Skeleton className="mt-3 h-5 w-24" />
					</div>
				))}
			</div>
		);
	}

	if (!memories.length) {
		return (
			<div className="mt-3 rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
				{emptyMessage}
			</div>
		);
	}

	return (
		<div className="mt-3 divide-y rounded-lg border bg-card">
			{memories.map((memory) => (
				<article key={memory.id} className="relative p-3">
					<Link
						href={memoryDetailHref(memory.id)}
						aria-label={`Open memory ${memory.id.slice(0, 8)}`}
						className="absolute inset-0 rounded-lg"
					/>
					<div className="pointer-events-none relative z-10 flex items-start justify-between gap-3">
						<div className="min-w-0 flex-1 space-y-2">
							<p className="break-words text-sm leading-relaxed">{memory.content}</p>
							<div className="flex flex-wrap items-center gap-1.5">
								<Badge variant="secondary" className={cn(MEMORY_CATEGORY_COLORS[memory.category])}>
									{memory.category}
								</Badge>
								{memory.tags?.slice(0, 3).map((tag) => (
									<span key={tag} className="text-xs text-muted-foreground">
										#{tag}
									</span>
								))}
							</div>
							<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
								{memory.created_at ? <span>{relativeTime(memory.created_at)}</span> : null}
								{memory.source_machine_name ? (
									<span className="inline-flex min-w-0 items-center gap-1">
										<Laptop className="size-3 shrink-0" />
										<span className="truncate">Learned on {memory.source_machine_name}</span>
									</span>
								) : null}
							</div>
						</div>
						<ConfirmAction
							title="Delete this memory?"
							description={<p>Your AI will stop recalling it on every agent within seconds.</p>}
							confirmLabel="Delete Memory"
							destructive
							onConfirm={() => onDelete(memory.id)}
						>
							<Button
								variant="ghost"
								size="icon-sm"
								onClick={(event) => {
									event.stopPropagation();
								}}
								className="pointer-events-auto shrink-0 text-muted-foreground hover:text-destructive"
								aria-label="Delete memory"
							>
								<Trash2 className="size-3.5" />
							</Button>
						</ConfirmAction>
					</div>
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
				await api.POST("/api/memories", {
					body: { content, category: addCategory, source: "web" },
				}),
			),
		onSuccess: () => {
			setContent("");
			setOpen(false);
			queryClient.invalidateQueries({ queryKey: ["memories"] });
		},
		onError: (e) => toast.error("Failed to Add Memory", { description: errorMessage(e) }),
	});

	if (!open) {
		return (
			<Button
				variant="outline"
				onClick={() => setOpen(true)}
				className="border-dashed text-muted-foreground"
			>
				<Plus />
				Add Memory
			</Button>
		);
	}

	return (
		<Card>
			<CardContent className="space-y-3">
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
						rows={3}
						className="resize-none"
					/>
				</div>
				{secretFinding ? (
					<Alert variant="destructive">
						<AlertCircle />
						<AlertTitle>Use Vault for Secrets</AlertTitle>
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
					<div className="flex items-center gap-2">
						<Button
							variant="ghost"
							onClick={() => {
								setOpen(false);
								setContent("");
							}}
						>
							Cancel
						</Button>
						<Button
							onClick={() => content.trim() && createMemory.mutate()}
							disabled={!content.trim() || !!secretFinding || createMemory.isPending}
						>
							{createMemory.isPending ? <Spinner /> : <Plus />}
							Add Memory
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
