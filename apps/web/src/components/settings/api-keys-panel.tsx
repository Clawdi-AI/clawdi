"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { SettingsPanelHeader } from "@/components/settings/settings-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type ApiError, unwrap, useApi } from "@/lib/api";
import type { ApiKey } from "@/lib/api-schemas";

/** API Keys settings — CLI-facing bearer tokens. */
export function ApiKeysPanel() {
	const api = useApi();
	const queryClient = useQueryClient();
	const [newLabel, setNewLabel] = useState("");
	const [createdKey, setCreatedKey] = useState<string | null>(null);

	const { data: keys, isLoading } = useQuery({
		queryKey: ["api-keys"],
		queryFn: async () => unwrap(await api.GET("/api/auth/keys")),
	});

	const createKey = useMutation({
		mutationFn: async (label: string) =>
			unwrap(await api.POST("/api/auth/keys", { body: { label } })),
		onSuccess: (data) => {
			setCreatedKey(data.raw_key);
			setNewLabel("");
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
		},
		onError: (e: ApiError) => toast.error("Couldn't create key", { description: e.detail }),
	});

	const revokeKey = useMutation({
		mutationFn: async (keyId: string) =>
			unwrap(
				await api.DELETE("/api/auth/keys/{key_id}", {
					params: { path: { key_id: keyId } },
				}),
			),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			toast.success("Key turned off");
		},
		onError: (e: ApiError) => toast.error("Couldn't turn off key", { description: e.detail }),
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
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (newLabel) createKey.mutate(newLabel);
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
					className="flex-1"
					name="new-key-label"
					autoComplete="off"
				/>
				<Button type="submit" disabled={!newLabel || createKey.isPending}>
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
					<div className="flex items-center gap-2">
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
					</div>
				</div>
			) : null}

			<DataTable
				columns={columns}
				data={keys ?? []}
				isLoading={isLoading}
				emptyMessage="No API keys yet."
			/>
		</div>
	);
}
