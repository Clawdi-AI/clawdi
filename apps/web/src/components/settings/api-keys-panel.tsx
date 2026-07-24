"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Check, Copy, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toastApiError, unwrap, useApi } from "@/lib/api";
import type { ApiKey } from "@/lib/api-schemas";

/** API Keys settings — CLI-facing bearer tokens. */
export function ApiKeysPanel() {
	const api = useApi();
	const queryClient = useQueryClient();
	const [newLabel, setNewLabel] = useState("");
	const [createdKey, setCreatedKey] = useState<string | null>(null);
	const normalizedNewLabel = newLabel.trim();

	const {
		data: keys,
		error,
		isLoading,
		refetch,
	} = useQuery({
		queryKey: ["api-keys"],
		queryFn: async () => unwrap(await api.GET("/v1/auth/keys")),
	});

	const createKey = useMutation({
		mutationFn: async (label: string) =>
			unwrap(await api.POST("/v1/auth/keys", { body: { label } })),
		onSuccess: (data) => {
			setCreatedKey(data.raw_key);
			setNewLabel("");
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
		},
		onError: toastApiError("Couldn't create key"),
	});

	const revokeKey = useMutation({
		mutationFn: async (keyId: string) =>
			unwrap(
				await api.DELETE("/v1/auth/keys/{key_id}", {
					params: { path: { key_id: keyId } },
				}),
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			toast.success("Key turned off");
		},
		onError: toastApiError("Couldn't turn off key"),
	});

	const columns = useMemo<ColumnDef<ApiKey>[]>(
		() => [
			{
				accessorKey: "label",
				header: "Label",
				cell: ({ row }) => (
					<div className="flex items-center gap-2">
						<span className="font-medium">{row.original.label}</span>
						{row.original.revoked_at ? <Badge variant="destructive">Off</Badge> : null}
					</div>
				),
			},
			{
				accessorKey: "key_prefix",
				header: "Prefix",
				cell: ({ row }) => (
					<span className="font-mono text-xs text-muted-foreground">
						{row.original.key_prefix}…
					</span>
				),
			},
			{
				accessorKey: "created_at",
				header: "Created",
				cell: ({ row }) => (
					<span className="text-xs text-muted-foreground">
						{new Date(row.original.created_at).toLocaleDateString()}
					</span>
				),
			},
			{
				accessorKey: "last_used_at",
				header: "Last used",
				cell: ({ row }) =>
					row.original.last_used_at ? (
						<span className="text-xs text-muted-foreground">
							{new Date(row.original.last_used_at).toLocaleDateString()}
						</span>
					) : (
						<span className="text-xs text-muted-foreground">—</span>
					),
			},
			{
				id: "actions",
				header: "",
				cell: ({ row }) =>
					!row.original.revoked_at ? (
						<ConfirmAction
							title={`Turn off ${row.original.label}?`}
							description={
								<p>
									If a machine is still using this key, sync will stop within a minute. Sign in
									again from that machine to resume.
								</p>
							}
							confirmLabel="Turn Off Key"
							destructive
							onConfirm={() => revokeKey.mutate(row.original.id)}
						>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								disabled={revokeKey.isPending}
								aria-label="Turn off key"
								className="text-muted-foreground hover:text-destructive"
							>
								<Trash2 className="size-3.5" />
							</Button>
						</ConfirmAction>
					) : null,
				size: 40,
			},
		],
		[revokeKey],
	);

	return (
		<div className="space-y-6 px-4 lg:px-6">
			<SettingsPanelHeader
				title="API Keys"
				description={
					<>
						On a laptop,{" "}
						<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
							clawdi auth login
						</code>{" "}
						handles auth automatically — you don&apos;t need to touch this. Create a key here when
						you&apos;re setting up a server or container that can&apos;t open a browser, then paste
						it into{" "}
						<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
							CLAWDI_AUTH_TOKEN
						</code>{" "}
						(this is the env var the CLI and{" "}
						<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">clawdi daemon</code>{" "}
						actually read).
					</>
				}
			/>

			{/* Create form */}
			<form
				className="flex flex-col gap-2 sm:flex-row"
				onSubmit={(e) => {
					e.preventDefault();
					if (normalizedNewLabel && createdKey === null) {
						createKey.mutate(normalizedNewLabel);
					}
				}}
			>
				<Label htmlFor="new-key-label" className="sr-only">
					New API key label
				</Label>
				<Input
					id="new-key-label"
					value={newLabel}
					onChange={(e) => setNewLabel(e.target.value)}
					placeholder="my-laptop…"
					className="min-w-0 flex-1"
					name="new-key-label"
					autoComplete="off"
					disabled={createdKey !== null}
				/>
				<Button
					type="submit"
					disabled={!normalizedNewLabel || createKey.isPending || createdKey !== null}
					className="w-full sm:w-auto"
				>
					<Plus />
					Create
				</Button>
			</form>

			{/* Created key banner */}
			{createdKey ? (
				<div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-4">
					<div className="text-sm font-medium text-primary">
						Key created — copy it now, it won't be shown again.
					</div>
					<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
						<code className="flex-1 break-all rounded bg-muted px-3 py-2 font-mono text-xs">
							{createdKey}
						</code>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							onClick={() => {
								navigator.clipboard
									.writeText(createdKey)
									.then(() => toast.success("Copied to clipboard"))
									.catch(() => toast.error("Couldn't copy", { description: "Copy it manually." }));
							}}
							aria-label="Copy key"
						>
							<Copy />
						</Button>
						<Button type="button" variant="outline" size="sm" onClick={() => setCreatedKey(null)}>
							<Check />
							I&apos;ve saved it
						</Button>
					</div>
				</div>
			) : null}

			{error ? (
				<ApiErrorPanel error={error} onRetry={() => refetch()} title="Couldn’t load API keys" />
			) : (
				<>
					<div className="md:hidden">
						<ApiKeysMobileList
							keys={keys ?? []}
							isLoading={isLoading}
							isRevoking={revokeKey.isPending}
							onRevoke={(keyId) => revokeKey.mutate(keyId)}
						/>
					</div>
					<DataTable
						columns={columns}
						data={keys ?? []}
						isLoading={isLoading}
						emptyMessage="No API keys yet."
						className="hidden md:block"
					/>
				</>
			)}
		</div>
	);
}

function ApiKeysMobileList({
	keys,
	isLoading,
	isRevoking,
	onRevoke,
}: {
	keys: ApiKey[];
	isLoading: boolean;
	isRevoking: boolean;
	onRevoke: (keyId: string) => void;
}) {
	if (isLoading) {
		return (
			<div className="flex flex-col gap-2">
				{[0, 1, 2].map((i) => (
					<div key={i} className="rounded-lg border bg-card p-3">
						<Skeleton className="h-4 w-32" />
						<Skeleton className="mt-2 h-3 w-24" />
					</div>
				))}
			</div>
		);
	}

	if (keys.length === 0) {
		return (
			<div className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
				No API keys yet.
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-2">
			{keys.map((key) => (
				<div key={key.id} className="rounded-lg border bg-card p-3">
					<div className="flex min-w-0 items-start justify-between gap-3">
						<div className="min-w-0">
							<div className="flex min-w-0 flex-wrap items-center gap-2">
								<span className="break-words text-sm font-medium">{key.label}</span>
								{key.revoked_at ? <Badge variant="destructive">Off</Badge> : null}
							</div>
							<div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
								<span className="font-mono">{key.key_prefix}…</span>
								<span>Created {new Date(key.created_at).toLocaleDateString()}</span>
								<span>
									Last used{" "}
									{key.last_used_at ? new Date(key.last_used_at).toLocaleDateString() : "—"}
								</span>
							</div>
						</div>
						{key.revoked_at ? null : (
							<ConfirmAction
								title={`Turn off ${key.label}?`}
								description={
									<p>
										If a machine is still using this key, sync will stop within a minute. Sign in
										again from that machine to resume.
									</p>
								}
								confirmLabel="Turn Off Key"
								destructive
								onConfirm={() => onRevoke(key.id)}
							>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									disabled={isRevoking}
									aria-label="Turn off key"
									className="shrink-0 text-muted-foreground hover:text-destructive"
								>
									<Trash2 className="size-3.5" />
								</Button>
							</ConfirmAction>
						)}
					</div>
				</div>
			))}
		</div>
	);
}
