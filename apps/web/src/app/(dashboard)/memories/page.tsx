"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Database, Key, Loader2, Plus, Search, Trash2, X } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import type { Memory, UserSettings } from "@/lib/api-schemas";
import { cn, relativeTime } from "@/lib/utils";

const CATEGORIES = [
	{ value: "", label: "All" },
	{ value: "fact", label: "Fact" },
	{ value: "preference", label: "Preference" },
	{ value: "pattern", label: "Pattern" },
	{ value: "decision", label: "Decision" },
	{ value: "context", label: "Context" },
] as const;

const CATEGORY_COLORS: Record<string, string> = {
	fact: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
	preference: "bg-purple-500/10 text-purple-700 dark:text-purple-400",
	pattern: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
	decision: "bg-green-500/10 text-green-700 dark:text-green-400",
	context: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

export default function MemoriesPage() {
	const { getToken } = useAuth();
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = useState("");
	const [category, setCategory] = useState("");
	const deferredQuery = useDeferredValue(searchQuery);

	// --- Settings (provider) ---
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
	});

	// --- Memories ---
	const { data: memories, isLoading } = useQuery({
		queryKey: ["memories", deferredQuery, category],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			const params = new URLSearchParams();
			if (deferredQuery) params.set("q", deferredQuery);
			if (category) params.set("category", category);
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
	});

	return (
		<div className="space-y-5">
			<PageHeader
				title="Memories"
				description="Cross-agent recall. Memories are searchable from any agent via MCP."
				actions={
					<>
						{memories && (
							<Badge variant="secondary">
								{memories.length} memor{memories.length === 1 ? "y" : "ies"}
							</Badge>
						)}
						<ProviderSwitch
							provider={provider}
							onSwitch={(p) => updateSettings.mutate({ memory_provider: p })}
							isPending={updateSettings.isPending}
						/>
					</>
				}
			/>

			{/* Mem0 API Key config */}
			{provider === "mem0" && !hasMem0Key && (
				<Mem0KeyForm
					onSave={(key) => updateSettings.mutate({ mem0_api_key: key })}
					isPending={updateSettings.isPending}
				/>
			)}

			{/* Add memory */}
			<AddMemoryForm />

			{/* Search + Category filter */}
			<div className="flex flex-col gap-3">
				<div className="relative">
					<Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground z-10" />
					<Input
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search memories..."
						className="rounded-xl pl-9 pr-9"
					/>
					{searchQuery && (
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={() => setSearchQuery("")}
							className="absolute right-1 top-1/2 -translate-y-1/2"
						>
							<X className="size-4" />
						</Button>
					)}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{CATEGORIES.map((c) => (
						<button
							key={c.value}
							type="button"
							onClick={() => setCategory(c.value)}
							className={cn(
								"rounded-full px-3 py-1 text-xs font-medium border transition-colors",
								category === c.value
									? "bg-primary text-primary-foreground border-primary"
									: "border-border text-muted-foreground hover:bg-muted",
							)}
						>
							{c.label}
						</button>
					))}
				</div>
			</div>

			{/* Memory list */}
			{isLoading ? (
				<div className="space-y-2">
					{Array.from({ length: 4 }).map((_, i) => (
						<div key={i} className="rounded-lg border bg-card px-4 py-3 space-y-2">
							<Skeleton className="h-4 w-3/4" />
							<div className="flex gap-2">
								<Skeleton className="h-3 w-14 rounded-full" />
								<Skeleton className="h-3 w-20" />
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
								<div className="flex items-center gap-2 mt-1.5">
									<span
										className={cn(
											"text-[10px] font-medium px-1.5 py-0.5 rounded-full",
											CATEGORY_COLORS[m.category] || "bg-muted text-muted-foreground",
										)}
									>
										{m.category}
									</span>
									<span className="text-xs text-muted-foreground">{m.source}</span>
									{m.tags?.map((t) => (
										<span key={t} className="text-xs text-muted-foreground">
											#{t}
										</span>
									))}
									{m.created_at && (
										<span className="text-xs text-muted-foreground">
											{relativeTime(m.created_at)}
										</span>
									)}
								</div>
							</div>
							<Button
								variant="ghost"
								size="icon-sm"
								onClick={() => deleteMemory.mutate(m.id)}
								disabled={deleteMemory.isPending}
								className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive shrink-0"
							>
								<Trash2 className="size-3.5" />
							</Button>
						</div>
					))}
				</div>
			) : (
				<div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
					{searchQuery || category
						? "No memories match your search."
						: 'No memories yet. Add one above or use `clawdi memory add "..."`'}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ProviderSwitch({
	provider,
	onSwitch,
	isPending,
}: {
	provider: string;
	onSwitch: (p: string) => void;
	isPending: boolean;
}) {
	return (
		<div className="flex items-center gap-0.5 rounded-lg border p-0.5">
			<button
				type="button"
				onClick={() => onSwitch("builtin")}
				disabled={isPending}
				className={cn(
					"inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors",
					provider === "builtin"
						? "bg-primary text-primary-foreground"
						: "text-muted-foreground hover:bg-muted",
				)}
			>
				<Database className="size-3" />
				Built-in
			</button>
			<button
				type="button"
				onClick={() => onSwitch("mem0")}
				disabled={isPending}
				className={cn(
					"inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs transition-colors",
					provider === "mem0"
						? "bg-primary text-primary-foreground"
						: "text-muted-foreground hover:bg-muted",
				)}
			>
				<Brain className="size-3" />
				Mem0
			</button>
		</div>
	);
}

function Mem0KeyForm({ onSave, isPending }: { onSave: (key: string) => void; isPending: boolean }) {
	const [apiKey, setApiKey] = useState("");

	return (
		<Card className="gap-2 py-4">
			<CardHeader className="px-4">
				<CardTitle className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					<Key className="size-3.5" />
					Mem0 Configuration
				</CardTitle>
			</CardHeader>
			<CardContent className="px-4">
				<p className="text-xs text-muted-foreground mb-3">
					Enter your Mem0 API key to use semantic memory search.
				</p>
				<div className="flex gap-2">
					<Input
						type="password"
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder="m0-..."
						className="flex-1 h-8 text-xs font-mono"
						onKeyDown={(e) => {
							if (e.key === "Enter" && apiKey) onSave(apiKey);
						}}
					/>
					<Button
						size="sm"
						onClick={() => apiKey && onSave(apiKey)}
						disabled={!apiKey || isPending}
					>
						{isPending ? <Loader2 className="size-3 animate-spin" /> : <Key className="size-3" />}
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
				body: JSON.stringify({
					content,
					category: addCategory,
					source: "web",
				}),
			});
		},
		onSuccess: () => {
			setContent("");
			setOpen(false);
			queryClient.invalidateQueries({ queryKey: ["memories"] });
		},
	});

	if (!open) {
		return (
			<Button
				variant="outline"
				onClick={() => setOpen(true)}
				className="border-dashed text-muted-foreground"
			>
				<Plus className="size-4" />
				Add Memory
			</Button>
		);
	}

	return (
		<div className="rounded-lg border bg-card p-4 space-y-3">
			<Textarea
				value={content}
				onChange={(e) => setContent(e.target.value)}
				placeholder="What should your agents remember?"
				rows={3}
				className="resize-none"
			/>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="text-xs text-muted-foreground">Category:</span>
					<Select value={addCategory} onValueChange={setAddCategory}>
						<SelectTrigger size="sm" className="text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{CATEGORIES.filter((c) => c.value).map((c) => (
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
						size="sm"
						onClick={() => {
							setOpen(false);
							setContent("");
						}}
					>
						Cancel
					</Button>
					<Button
						size="sm"
						onClick={() => content.trim() && createMemory.mutate()}
						disabled={!content.trim() || createMemory.isPending}
					>
						{createMemory.isPending ? (
							<Loader2 className="size-3 animate-spin" />
						) : (
							<Plus className="size-3" />
						)}
						Add
					</Button>
				</div>
			</div>
		</div>
	);
}
