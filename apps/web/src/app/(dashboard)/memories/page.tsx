"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Brain, Database, Key, Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { apiFetch } from "@/lib/api";
import type { Memory, UserSettings } from "@/lib/api-schemas";
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

// Semantic color overlay. Applied via cn() to the shadcn Badge — we don't
// modify the Badge primitive itself, just extend its classes for the data-viz
// category distinction (fact/preference/pattern/decision/context).
const CATEGORY_COLORS: Record<string, string> = {
	fact: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-transparent",
	preference: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-transparent",
	pattern: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-transparent",
	decision: "bg-green-500/10 text-green-700 dark:text-green-400 border-transparent",
	context: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-transparent",
};

export default function MemoriesPage() {
	const { getToken } = useAuth();
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = useState("");
	const [category, setCategory] = useState<string>(ALL);
	const deferredQuery = useDeferredValue(searchQuery);
	const apiCategory = category === ALL ? "" : category;

	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<UserSettings>("/api/settings", token);
		},
	});

	const provider =
		typeof settings?.memory_provider === "string" ? settings.memory_provider : "builtin";
	const mem0Key = typeof settings?.mem0_api_key === "string" ? settings.mem0_api_key : "";
	const hasMem0Key = mem0Key !== "";

	const updateSettings = useMutation({
		mutationFn: async (patch: Record<string, string>) => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<unknown>("/api/settings", token, {
				method: "PATCH",
				body: JSON.stringify({ settings: patch }),
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["settings"] });
			queryClient.invalidateQueries({ queryKey: ["memories"] });
		},
		onError: (e) => toast.error("Failed to update settings", { description: errorMessage(e) }),
	});

	const {
		data: memories,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["memories", deferredQuery, apiCategory],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			const params = new URLSearchParams();
			if (deferredQuery) params.set("q", deferredQuery);
			if (apiCategory) params.set("category", apiCategory);
			const qs = params.toString();
			return apiFetch<Memory[]>(`/api/memories${qs ? `?${qs}` : ""}`, token);
		},
	});

	const deleteMemory = useMutation({
		mutationFn: async (id: string) => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<unknown>(`/api/memories/${id}`, token, { method: "DELETE" });
		},
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["memories"] }),
		onError: (e) => toast.error("Failed to delete memory", { description: errorMessage(e) }),
	});

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Memories"
				description="Searchable knowledge available to every connected agent via MCP."
				actions={
					<>
						{memories ? (
							<Badge variant="secondary">
								{memories.length} memor{memories.length === 1 ? "y" : "ies"}
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

			<div className="flex flex-col gap-3">
				<div className="relative">
					<Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search memories..."
						className="pl-9 pr-9"
					/>
					{searchQuery ? (
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={() => setSearchQuery("")}
							className="absolute right-1 top-1/2 -translate-y-1/2"
							aria-label="Clear search"
						>
							<X className="size-4" />
						</Button>
					) : null}
				</div>
				<ToggleGroup
					type="single"
					value={category}
					onValueChange={(v) => v && setCategory(v)}
					variant="outline"
					size="sm"
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
					<AlertTitle>Failed to load memories</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : isLoading ? (
				<div className="space-y-2">
					{Array.from({ length: 4 }).map((_, i) => (
						<div key={i} className="rounded-lg border bg-card px-4 py-3 space-y-2">
							<Skeleton className="h-4 w-3/4" />
							<div className="flex gap-2">
								<Skeleton className="h-4 w-14" />
								<Skeleton className="h-4 w-20" />
							</div>
						</div>
					))}
				</div>
			) : memories?.length ? (
				<div className="space-y-2">
					{memories.map((m) => (
						<div
							key={m.id}
							className="group flex items-start justify-between gap-3 rounded-lg border bg-card px-4 py-3"
						>
							<div className="min-w-0 flex-1">
								<p className="text-sm">{m.content}</p>
								<div className="mt-1.5 flex flex-wrap items-center gap-2">
									<Badge variant="secondary" className={cn(CATEGORY_COLORS[m.category])}>
										{m.category}
									</Badge>
									<span className="text-xs text-muted-foreground">{m.source}</span>
									{m.tags?.map((t) => (
										<span key={t} className="text-xs text-muted-foreground">
											#{t}
										</span>
									))}
									{m.created_at ? (
										<span className="text-xs text-muted-foreground">
											{relativeTime(m.created_at)}
										</span>
									) : null}
								</div>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								onClick={() => deleteMemory.mutate(m.id)}
								disabled={deleteMemory.isPending}
								className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
								aria-label="Delete memory"
							>
								<Trash2 className="size-3.5" />
							</Button>
						</div>
					))}
				</div>
			) : (
				<EmptyState
					icon={Brain}
					title={searchQuery || apiCategory ? "No matches" : "No memories yet"}
					description={
						searchQuery || apiCategory ? (
							"Try a different search or category."
						) : (
							<>
								Add one above, or run{" "}
								<code className="rounded bg-muted px-1.5 py-0.5 text-xs">
									clawdi memory add "..."
								</code>
							</>
						)
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
						{isPending ? <Loader2 className="animate-spin" /> : <Key />}
						Save
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

function AddMemoryForm() {
	const { getToken } = useAuth();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [content, setContent] = useState("");
	const [addCategory, setAddCategory] = useState("fact");

	const createMemory = useMutation({
		mutationFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<unknown>("/api/memories", token, {
				method: "POST",
				body: JSON.stringify({ content, category: addCategory, source: "web" }),
			});
		},
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
							{createMemory.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
							Add
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
