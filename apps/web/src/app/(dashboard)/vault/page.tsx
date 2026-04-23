"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Key, Loader2, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import type { Vault, VaultItems } from "@/lib/api-schemas";
import { cn } from "@/lib/utils";

export default function VaultPage() {
	const { getToken } = useAuth();
	const queryClient = useQueryClient();
	const [newVaultSlug, setNewVaultSlug] = useState("");

	const { data: vaults, isLoading } = useQuery({
		queryKey: ["vaults"],
		queryFn: async () => {
			const token = await getToken();
			if (!token) throw new Error("Not authenticated");
			return apiFetch<Vault[]>("/api/vault", token);
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
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Vaults"
				description="Encrypted secrets your agents can access with clawdi run."
				actions={
					vaults ? (
						<Badge variant="secondary">
							{vaults.length} vault{vaults.length === 1 ? "" : "s"}
						</Badge>
					) : null
				}
			/>

			{/* Create vault */}
			<div className="flex gap-2">
				<Input
					value={newVaultSlug}
					onChange={(e) => setNewVaultSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
					placeholder="New vault name (e.g. ai-keys, prod)"
					className="flex-1 rounded-xl"
					onKeyDown={(e) => {
						if (e.key === "Enter" && newVaultSlug) createVault.mutate(newVaultSlug);
					}}
				/>
				<Button
					onClick={() => newVaultSlug && createVault.mutate(newVaultSlug)}
					disabled={!newVaultSlug || createVault.isPending}
					className="rounded-lg"
				>
					<Plus className="size-4" />
					Create
				</Button>
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
				<EmptyState
					description={
						<>
							No vaults yet. Create one above or run{" "}
							<code className="bg-muted px-1.5 py-0.5 rounded text-xs">clawdi vault set KEY</code>
						</>
					}
				/>
			)}
		</div>
	);
}

function VaultCard({
	vault,
	onDelete,
	isDeleting,
}: {
	vault: Vault;
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
			return apiFetch<VaultItems>(`/api/vault/${vault.slug}/items`, token);
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
					<Button
						variant="ghost"
						size="xs"
						onClick={() => setAdding(!adding)}
						className="text-muted-foreground"
					>
						<Plus className="size-3.5" />
						Add Key
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={onDelete}
						disabled={isDeleting}
						className="text-muted-foreground opacity-0 group-hover/vault:opacity-100 hover:text-destructive"
					>
						<Trash2 className="size-3.5" />
					</Button>
				</div>
			</div>

			{/* Add key form */}
			{adding && (
				<div className="px-4 py-3 border-b bg-muted/30">
					<div className="flex gap-2">
						<Input
							value={newKey}
							onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
							placeholder="KEY_NAME"
							className="flex-1 h-8 text-xs font-mono"
						/>
						<Input
							type="password"
							value={newValue}
							onChange={(e) => setNewValue(e.target.value)}
							placeholder="secret value"
							className="flex-1 h-8 text-xs"
							onKeyDown={(e) => {
								if (e.key === "Enter" && newKey && newValue)
									upsertItem.mutate({ key: newKey, value: newValue });
							}}
						/>
						<Button
							size="sm"
							onClick={() =>
								newKey && newValue && upsertItem.mutate({ key: newKey, value: newValue })
							}
							disabled={!newKey || !newValue || upsertItem.isPending}
						>
							{upsertItem.isPending ? (
								<Loader2 className="size-3 animate-spin" />
							) : (
								<Plus className="size-3" />
							)}
							Save
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={() => {
								setAdding(false);
								setNewKey("");
								setNewValue("");
							}}
						>
							<X className="size-3.5" />
						</Button>
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
								<Button
									variant="ghost"
									size="icon-xs"
									onClick={() => deleteItem.mutate(f.name)}
									disabled={deleteItem.isPending}
									className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
								>
									<Trash2 className="size-3.5" />
								</Button>
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
