"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { AlertCircle, Key, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { unwrap, useApi } from "@/lib/api";
import type { Vault } from "@/lib/api-schemas";
import { errorMessage } from "@/lib/utils";

interface VaultField {
	key: string;
	name: string;
	section: string;
}

export default function VaultPage() {
	const api = useApi();
	const queryClient = useQueryClient();
	const [newVaultSlug, setNewVaultSlug] = useState("");

	const { data, isLoading, error } = useQuery({
		queryKey: ["vaults"],
		// Vaults list is small; fetch one large page so the UI doesn't need
		// its own paginator here.
		queryFn: async () =>
			unwrap(await api.GET("/api/vault", { params: { query: { page_size: 100 } } })),
	});
	const vaults = data?.items;

	const createVault = useMutation({
		mutationFn: async (slug: string) =>
			unwrap(await api.POST("/api/vault", { body: { slug, name: slug } })),
		onSuccess: () => {
			setNewVaultSlug("");
			queryClient.invalidateQueries({ queryKey: ["vaults"] });
		},
		onError: (e) => toast.error("Failed to create vault", { description: errorMessage(e) }),
	});

	const deleteVault = useMutation({
		mutationFn: async (vault: { slug: string; scope_id: string }) =>
			unwrap(
				await api.DELETE("/api/vault/{slug}", {
					params: { path: { slug: vault.slug }, query: { scope_id: vault.scope_id } },
				}),
			),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["vaults"] }),
		onError: (e) => toast.error("Failed to delete vault", { description: errorMessage(e) }),
	});

	return (
		<div className="space-y-5 px-4 lg:px-6">
			<PageHeader
				title="Vaults"
				description="Secrets your AI can use without copy-pasting them into chats."
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
					className="flex-1"
					onKeyDown={(e) => {
						if (e.key === "Enter" && newVaultSlug) createVault.mutate(newVaultSlug);
					}}
				/>
				<Button
					onClick={() => newVaultSlug && createVault.mutate(newVaultSlug)}
					disabled={!newVaultSlug || createVault.isPending}
				>
					<Plus />
					Create
				</Button>
			</div>

			{error ? (
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Failed to load vaults</AlertTitle>
					<AlertDescription>{errorMessage(error)}</AlertDescription>
				</Alert>
			) : null}

			{/* Vault list — flat sections, no per-vault outer card. Skeleton
			    mirrors the actual shape: heading line + 3 table-row bars. */}
			{isLoading ? (
				<div className="space-y-6">
					{Array.from({ length: 2 }).map((_, i) => (
						<div key={i} className="space-y-2">
							<Skeleton className="h-4 w-24" />
							<Skeleton className="h-24 w-full rounded-lg" />
						</div>
					))}
				</div>
			) : vaults?.length ? (
				<div className="space-y-6">
					{vaults.map((v) => (
						<VaultCard
							key={v.id}
							vault={v}
							onDelete={() => deleteVault.mutate({ slug: v.slug, scope_id: v.scope_id })}
							isDeleting={deleteVault.isPending}
						/>
					))}
				</div>
			) : (
				<EmptyState
					icon={Key}
					title="No vaults yet"
					description="Create one above to store API keys for your AI to use."
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
	const api = useApi();
	const queryClient = useQueryClient();
	const [adding, setAdding] = useState(false);
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");

	// Cache key includes scope_id so a JWT user with the same slug
	// in two scopes (Personal + env-A) doesn't share entries.
	// Without the scope_id in the key the second card would render
	// the first's items.
	const itemsCacheKey = ["vault-items", vault.slug, vault.scope_id] as const;

	const { data: items } = useQuery({
		queryKey: itemsCacheKey,
		queryFn: async () =>
			unwrap(
				await api.GET("/api/vault/{slug}/items", {
					params: { path: { slug: vault.slug }, query: { scope_id: vault.scope_id } },
				}),
			),
	});

	const upsertItem = useMutation({
		mutationFn: async ({ section, key, value }: { section: string; key: string; value: string }) =>
			unwrap(
				await api.PUT("/api/vault/{slug}/items", {
					params: { path: { slug: vault.slug }, query: { scope_id: vault.scope_id } },
					body: { section, fields: { [key]: value } },
				}),
			),
		onSuccess: () => {
			setNewKey("");
			setNewValue("");
			setAdding(false);
			queryClient.invalidateQueries({ queryKey: itemsCacheKey });
		},
		onError: (e) => toast.error("Failed to save key", { description: errorMessage(e) }),
	});

	const deleteItem = useMutation({
		mutationFn: async ({ section, name }: { section: string; name: string }) =>
			unwrap(
				await api.DELETE("/api/vault/{slug}/items", {
					params: { path: { slug: vault.slug }, query: { scope_id: vault.scope_id } },
					body: { section, fields: [name] },
				}),
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: itemsCacheKey });
		},
		onError: (e) => toast.error("Failed to delete key", { description: errorMessage(e) }),
	});

	const allFields: VaultField[] = items
		? Object.entries(items).flatMap(([section, fields]) =>
				fields.map((f) => ({
					key: section === "(default)" ? f : `${section}/${f}`,
					name: f,
					section: section === "(default)" ? "" : section,
				})),
			)
		: [];

	const columns = useMemo<ColumnDef<VaultField>[]>(
		() => [
			{
				accessorKey: "key",
				header: "Key",
				cell: ({ row }) => <span className="font-mono text-xs">{row.original.key}</span>,
			},
			{
				id: "value",
				header: "Value",
				cell: () => <span className="font-mono text-xs text-muted-foreground">••••••••</span>,
				size: 120,
			},
			{
				id: "actions",
				header: "",
				cell: ({ row }) => (
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={(e) => {
							e.stopPropagation();
							// Removing a secret breaks any clawdi:// reference
							// to it the next time an AI tries to resolve.
							const ok = window.confirm(
								`Delete "${row.original.key}"?\n\n` +
									"Anything that resolves this key will start failing. To get it back you'd have to paste the value in again.",
							);
							if (ok) deleteItem.mutate({ section: row.original.section, name: row.original.name });
						}}
						disabled={deleteItem.isPending}
						className="text-muted-foreground hover:text-destructive"
						aria-label={`Delete ${row.original.key}`}
					>
						<Trash2 className="size-3.5" />
					</Button>
				),
				size: 40,
			},
		],
		[deleteItem],
	);

	// Flat section layout — heading + action row on top, then the table.
	// No outer card/border wrapping so it reads like Sessions/Memories and
	// doesn't stack a card inside a card.
	return (
		<section className="space-y-2">
			{/* Scope group/header to the heading row only — otherwise the delete
			    icon pops in whenever the cursor moves anywhere in the table body
			    below. */}
			<div className="group/header flex items-center justify-between gap-2 px-1">
				<div className="flex items-baseline gap-2">
					<h3 className="font-semibold text-sm">{vault.slug}</h3>
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
						onClick={() => {
							// Vault deletion permanently destroys every key
							// inside it — anything that resolves a clawdi://
							// URI from this vault will start failing the next
							// time an AI tries to use it.
							const ok = window.confirm(
								`Delete vault "${vault.slug}"?\n\n` +
									`This will permanently remove ${allFields.length} ` +
									`secret${allFields.length === 1 ? "" : "s"} stored inside. ` +
									"Anything that uses these keys will stop working.",
							);
							if (ok) onDelete();
						}}
						disabled={isDeleting}
						className="text-muted-foreground opacity-0 group-hover/header:opacity-100 hover:text-destructive"
						aria-label="Delete vault"
					>
						<Trash2 className="size-3.5" />
					</Button>
				</div>
			</div>

			{/* Inline add form, when toggled */}
			{adding ? (
				<div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-2">
					<Label htmlFor={`key-${vault.slug}`} className="sr-only">
						Key name
					</Label>
					<Input
						id={`key-${vault.slug}`}
						value={newKey}
						onChange={(e) => setNewKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
						placeholder="KEY_NAME"
						className="max-w-[220px] flex-1 font-mono"
					/>
					<Label htmlFor={`value-${vault.slug}`} className="sr-only">
						Secret value
					</Label>
					<Input
						id={`value-${vault.slug}`}
						type="password"
						value={newValue}
						onChange={(e) => setNewValue(e.target.value)}
						placeholder="secret value"
						className="flex-1"
						onKeyDown={(e) => {
							if (e.key === "Enter" && newKey && newValue)
								upsertItem.mutate({ section: "", key: newKey, value: newValue });
						}}
					/>
					<Button
						onClick={() =>
							newKey && newValue && upsertItem.mutate({ section: "", key: newKey, value: newValue })
						}
						disabled={!newKey || !newValue || upsertItem.isPending}
						size="sm"
					>
						{upsertItem.isPending ? <Spinner /> : <Plus />}
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
						aria-label="Cancel"
					>
						<X />
					</Button>
				</div>
			) : null}

			{allFields.length > 0 ? (
				<DataTable columns={columns} data={allFields} />
			) : !adding ? (
				<p className="px-1 text-sm text-muted-foreground">
					No keys yet. Click <span className="font-medium">Add Key</span> to store your first
					secret.
				</p>
			) : null}
		</section>
	);
}
