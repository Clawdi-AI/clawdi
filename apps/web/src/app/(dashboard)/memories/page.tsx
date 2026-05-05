"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Brain, Database, Key, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { makeMemoryColumns } from "@/components/memories/memory-columns";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { unwrap, useApi } from "@/lib/api";
import { useDebouncedValue } from "@/lib/use-debounced";
import { errorMessage } from "@/lib/utils";

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
		onError: (e) => toast.error("Failed to update settings", { description: errorMessage(e) }),
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
		onError: (e) => toast.error("Failed to delete memory", { description: errorMessage(e) }),
	});

	const columns = useMemo(
		() =>
			makeMemoryColumns((id) => {
				// Memory deletion is account-wide and reflects on every machine via
				// the daemon's live sync — gone in seconds, no undo from this UI.
				const ok = window.confirm(
					"Delete this memory?\n\nYour AI will stop recalling it on every agent within seconds.",
				);
				if (ok) deleteMemory.mutate(id);
			}),
		[deleteMemory],
	);

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Memories"
				actions={
					<>
						{data ? (
							<Badge variant="secondary">
								{total} memor{total === 1 ? "y" : "ies"}
							</Badge>
						) : null}
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
					</>
				}
			/>

			{provider === "mem0" && !hasMem0Key ? (
				<Mem0KeyForm
					onSave={(key) => updateSettings.mutate({ mem0_api_key: key })}
					isPending={updateSettings.isPending}
				/>
			) : null}

			<AddMemoryForm />

			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Failed to load memories</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : (
				<DataTable
					columns={columns}
					data={memories ?? []}
					isLoading={isLoading}
					getRowHref={(m) => `/memories/${m.id}`}
					rowAriaLabel={(m) => `Open memory ${m.id.slice(0, 8)}`}
					emptyMessage={
						debouncedSearch || apiCategory
							? "No matches — try a different search or category."
							: "No memories yet. Add one above, or your agents will create them automatically as they work."
					}
					pagination={pagination}
					onPaginationChange={setPagination}
					pageCount={Math.max(1, Math.ceil(total / pagination.pageSize))}
					toolbar={
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
							>
								{CATEGORIES.map((c) => (
									<ToggleGroupItem key={c.value} value={c.value}>
										{c.label}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						</DataTableToolbar>
					}
					footer={
						<DataTablePagination
							page={pagination.pageIndex + 1}
							pageSize={pagination.pageSize}
							total={total}
							onPageChange={(p) => setPagination((s) => ({ ...s, pageIndex: p - 1 }))}
							onPageSizeChange={(size) => setPagination(() => ({ pageIndex: 0, pageSize: size }))}
						/>
					}
				/>
			)}
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
				<div className="flex gap-2">
					<Input
						type="password"
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder="m0-..."
						className="flex-1 font-mono"
						onKeyDown={(e) => {
							if (e.key === "Enter" && apiKey) onSave(apiKey);
						}}
					/>
					<Button onClick={() => apiKey && onSave(apiKey)} disabled={!apiKey || isPending}>
						{isPending ? <Spinner /> : <Key />}
						Save
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
		onError: (e) => toast.error("Failed to add memory", { description: errorMessage(e) }),
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
						value={content}
						onChange={(e) => setContent(e.target.value)}
						placeholder="What should your agents remember?"
						rows={3}
						className="resize-none"
						autoFocus
					/>
				</div>
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
							disabled={!content.trim() || createMemory.isPending}
						>
							{createMemory.isPending ? <Spinner /> : <Plus />}
							Add
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
