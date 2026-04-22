"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Key, Loader2, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";

// Shape returned by the FastAPI /api/vault endpoint — snake_case.
interface VaultResponse {
	id: string;
	slug: string;
	name: string;
	created_at?: string;
}

export default function VaultPage() {
	const { getToken } = useAuth();
	const queryClient = useQueryClient();
	const [newVaultSlug, setNewVaultSlug] = useState("");

	const { data: vaults, isLoading } = useQuery({
		queryKey: ["vaults"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<VaultResponse[]>("/api/vault", token);
		},
	});

	const createVault = useMutation({
		mutationFn: async (slug: string) => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<unknown>("/api/vault", token, {
				method: "POST",
				body: JSON.stringify({ slug, name: slug }),
			});
		},
		onSuccess: () => {
			setNewVaultSlug("");
			queryClient.invalidateQueries({ queryKey: ["vaults"] });
		},
	});

	const deleteVault = useMutation({
		mutationFn: async (slug: string) => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<unknown>(`/api/vault/${slug}`, token, { method: "DELETE" });
		},
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vaults"] }),
	});

	return (
		<div className="space-y-5">
			{/* Header */}
			<div className="flex items-start justify-between">
				<div>
					<h1 className="text-2xl font-bold">Vault</h1>
					<p className="text-sm text-muted-foreground mt-1">
						Encrypted secrets synced to your agents via{" "}
						<code className="bg-muted px-1.5 py-0.5 rounded text-xs">clawdi run</code>. Values are
						AES-256-GCM encrypted at rest.
					</p>
				</div>
				{vaults && (
					<span className="rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
						{vaults.length} vault{vaults.length === 1 ? "" : "s"}
					</span>
				)}
			</div>

			{/* Create vault */}
			<div className="flex gap-2">
				<input
					type="text"
					value={newVaultSlug}
					onChange={(e) => setNewVaultSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
					placeholder="New vault name (e.g. ai-keys, prod)"
					className="flex-1 border border-input bg-background rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
					onKeyDown={(e) => {
						if (e.key === "Enter" && newVaultSlug) createVault.mutate(newVaultSlug);
					}}
				/>
				<button
					type="button"
					onClick={() => newVaultSlug && createVault.mutate(newVaultSlug)}
					disabled={!newVaultSlug || createVault.isPending}
					className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
				>
					<Plus className="size-4" />
					Create
				</button>
			</div>

			{/* Vault list */}
			{isLoading ? (
				<div className="space-y-4">
					{Array.from({ length: 2 }).map((_, i) => (
						<div key={i} className="rounded-lg border bg-card p-4 space-y-3">
							<Skeleton className="h-4 w-32" />
							<Skeleton className="h-3 w-48" />
							<Skeleton className="h-3 w-40" />
						</div>
					))}
				</div>
			) : vaults?.length ? (
				<div className="space-y-3">
					{vaults.map((v) => (
						<VaultCard
							key={v.id}
							vault={v}
							onDelete={() => deleteVault.mutate(v.slug)}
							isDeleting={deleteVault.isPending}
						/>
					))}
				</div>
			) : (
				<div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
					No vaults yet. Create one above or run{" "}
					<code className="bg-muted px-1.5 py-0.5 rounded text-xs">clawdi vault set KEY</code>
				</div>
			)}
		</div>
	);
}

function VaultCard({
	vault,
	onDelete,
	isDeleting,
}: {
	vault: VaultResponse;
	onDelete: () => void;
	isDeleting: boolean;
}) {
	const { getToken } = useAuth();
	const queryClient = useQueryClient();
	const [adding, setAdding] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");

	const { data: items } = useQuery({
		queryKey: ["vault-items", vault.slug],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<Record<string, string[]>>(`/api/vault/${vault.slug}/items`, token);
		},
	});

	const upsertItem = useMutation({
		mutationFn: async ({ key, value }: { key: string; value: string }) => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<unknown>(`/api/vault/${vault.slug}/items`, token, {
				method: "PUT",
				body: JSON.stringify({ section: "", fields: { [key]: value } }),
			});
		},
		onSuccess: () => {
			setNewKey("");
			setNewValue("");
			setAdding(false);
			queryClient.invalidateQueries({
				queryKey: ["vault-items", vault.slug],
			});
		},
	});

	const deleteItem = useMutation({
		mutationFn: async (fieldName: string) => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<unknown>(`/api/vault/${vault.slug}/items`, token, {
				method: "DELETE",
				body: JSON.stringify({ section: "", fields: [fieldName] }),
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["vault-items", vault.slug],
			});
		},
	});

	const allFields = items
		? Object.entries(items).flatMap(([section, fields]) =>
				fields.map((f) => ({
					key: section === "(default)" ? f : `${section}/${f}`,
					name: f,
					section: section === "(default)" ? "" : section,
				})),
			)
		: [];

	return (
		<div className="group/vault rounded-lg border bg-card">
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b">
				<div className="flex items-center gap-2">
					<Key className="size-4 text-primary" />
					<span className="font-medium text-sm">{vault.slug}</span>
					<span className="text-xs text-muted-foreground">
						{allFields.length} {allFields.length === 1 ? "key" : "keys"}
					</span>
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => setAdding(!adding)}
						className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
					>
						<Plus className="size-3.5" />
						Add Key
					</button>
					<button
						type="button"
						onClick={onDelete}
						disabled={isDeleting}
						className="p-1.5 text-muted-foreground opacity-0 group-hover/vault:opacity-100 hover:text-destructive hover:bg-muted rounded-md transition-all disabled:opacity-50"
					>
						<Trash2 className="size-3.5" />
					</button>
				</div>
			</div>

			{/* Add key form */}
			{adding && (
				<div className="px-4 py-3 border-b bg-muted/30">
					<div className="flex gap-2">
						<input
							type="text"
							value={newKey}
							onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
							placeholder="KEY_NAME"
							className="flex-1 border border-input bg-background rounded-md px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-ring"
						/>
						<input
							type="password"
							value={newValue}
							onChange={(e) => setNewValue(e.target.value)}
							placeholder="secret value"
							className="flex-1 border border-input bg-background rounded-md px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
							onKeyDown={(e) => {
								if (e.key === "Enter" && newKey && newValue)
									upsertItem.mutate({ key: newKey, value: newValue });
							}}
						/>
						<button
							type="button"
							onClick={() =>
								newKey && newValue && upsertItem.mutate({ key: newKey, value: newValue })
							}
							disabled={!newKey || !newValue || upsertItem.isPending}
							className="inline-flex items-center gap-1 bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-xs font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
						>
							{upsertItem.isPending ? (
								<Loader2 className="size-3 animate-spin" />
							) : (
								<Plus className="size-3" />
							)}
							Save
						</button>
						<button
							type="button"
							onClick={() => {
								setAdding(false);
								setNewKey("");
								setNewValue("");
							}}
							className="p-1.5 text-muted-foreground hover:bg-muted rounded-md transition-colors"
						>
							<X className="size-3.5" />
						</button>
					</div>
				</div>
			)}

			{/* Keys list */}
			{allFields.length > 0 ? (
				<div>
					{allFields.map((f, i) => (
						<div
							key={f.key}
							className={cn(
								"group flex items-center justify-between px-4 py-2.5",
								i > 0 && "border-t",
							)}
						>
							<span className="font-mono text-xs">{f.key}</span>
							<div className="flex items-center gap-1">
								<span className="text-xs text-muted-foreground mr-1">••••••••</span>
								<button
									type="button"
									onClick={() => deleteItem.mutate(f.name)}
									disabled={deleteItem.isPending}
									className="p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive rounded transition-all disabled:opacity-50"
								>
									<Trash2 className="size-3.5" />
								</button>
							</div>
						</div>
					))}
				</div>
			) : (
				!adding && (
					<div className="px-4 py-4 text-center text-xs text-muted-foreground">
						No keys yet. Click "Add Key" to add one.
					</div>
				)
			)}
		</div>
	);
}
