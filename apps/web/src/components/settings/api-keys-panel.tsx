"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Check, Copy, KeyRound, Laptop, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	API_KEYS_QUERY_KEY,
	activeApiKeys,
	removeApiKeyFromList,
	restoreApiKeyToList,
} from "@/components/settings/api-keys-panel.logic";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { TimeTooltip } from "@/components/time-tooltip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { DataTable } from "@/components/ui/data-table";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { toastApiError, unwrap, useApi } from "@/lib/api";
import type { ApiKey } from "@/lib/api-schemas";
import { formatShortDate } from "@/lib/format";
import { useSensitiveAction } from "@/lib/use-sensitive-action";

const API_KEY_LABEL_MAX_LENGTH = 200;
const REVOKE_API_KEY_MUTATION_KEY = ["revoke-api-key"] as const;

type RevokeContext = {
	removedKey?: ApiKey;
};

/** API Keys settings — CLI-facing bearer tokens. */
export function ApiKeysPanel() {
	const api = useApi();
	const queryClient = useQueryClient();
	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const [newLabel, setNewLabel] = useState("");
	const [createdKey, setCreatedKey] = useState<string | null>(null);
	const [secretAcknowledged, setSecretAcknowledged] = useState(false);
	const normalizedNewLabel = newLabel.trim();
	const { copied, copy } = useCopyToClipboard({
		success: "API key copied to clipboard",
		error: "Couldn’t copy the API key — select and copy it manually.",
	});

	const {
		data: listedKeys,
		error,
		isLoading,
		refetch,
	} = useQuery({
		queryKey: API_KEYS_QUERY_KEY,
		queryFn: async () => unwrap(await api.GET("/v1/auth/keys")),
	});
	const keys = useMemo(() => activeApiKeys(listedKeys), [listedKeys]);

	const createKey = useSensitiveAction(async (label: string) => {
		try {
			const data = unwrap(await api.POST("/v1/auth/keys", { body: { label } }));
			setCreatedKey(data.raw_key);
			setSecretAcknowledged(false);
			setNewLabel("");
			void queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
			return data;
		} catch (actionError) {
			toastApiError("Couldn’t create API key")(actionError);
			throw actionError;
		}
	});

	const revokeKey = useMutation({
		mutationKey: REVOKE_API_KEY_MUTATION_KEY,
		mutationFn: async (keyId: string) =>
			unwrap(
				await api.DELETE("/v1/auth/keys/{key_id}", {
					params: { path: { key_id: keyId } },
				}),
			),
		onMutate: async (keyId): Promise<RevokeContext> => {
			await queryClient.cancelQueries({ queryKey: API_KEYS_QUERY_KEY });
			const currentKeys = queryClient.getQueryData<ApiKey[]>(API_KEYS_QUERY_KEY);
			const removedKey = currentKeys?.find((key) => key.id === keyId);
			queryClient.setQueryData<ApiKey[]>(
				API_KEYS_QUERY_KEY,
				removeApiKeyFromList(currentKeys, keyId),
			);
			return { removedKey };
		},
		onSuccess: () => {
			toast.success("API key revoked");
		},
		onError: (mutationError, _keyId, context) => {
			const removedKey = context?.removedKey;
			if (removedKey) {
				queryClient.setQueryData<ApiKey[]>(API_KEYS_QUERY_KEY, (currentKeys) =>
					restoreApiKeyToList(currentKeys, removedKey),
				);
			}
			toastApiError("Couldn’t revoke API key")(mutationError);
		},
		onSettled: () => {
			// Reconcile once the last overlapping revoke settles so a refetch cannot
			// temporarily resurrect another row whose request is still in flight.
			if (queryClient.isMutating({ mutationKey: REVOKE_API_KEY_MUTATION_KEY }) === 1) {
				return queryClient.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
			}
		},
	});

	const handleRevoke = useCallback(
		(keyId: string) => revokeKey.mutateAsync(keyId),
		[revokeKey.mutateAsync],
	);
	const showExpiration = keys.some((key) => key.expires_at !== null);
	const columns = useMemo(
		() => apiKeyColumns({ showExpiration, onRevoke: handleRevoke }),
		[handleRevoke, showExpiration],
	);

	function openCreateDialog() {
		if (createdKey !== null) return;
		createKey.reset();
		setNewLabel("");
		setSecretAcknowledged(false);
		setCreateDialogOpen(true);
	}

	function handleCreateDialogOpenChange(nextOpen: boolean) {
		if (!nextOpen && (createKey.isPending || createdKey !== null)) return;
		if (!nextOpen) {
			createKey.reset();
			setNewLabel("");
			setSecretAcknowledged(false);
		}
		setCreateDialogOpen(nextOpen);
	}

	function finishSecretReveal() {
		if (!secretAcknowledged) return;
		setCreatedKey(null);
		setSecretAcknowledged(false);
		setCreateDialogOpen(false);
	}

	return (
		<div className="space-y-6 px-4 lg:px-6">
			<SettingsPanelHeader
				title="API Keys"
				description="Manage bearer tokens for servers, containers, and other headless environments."
				actions={
					<Button type="button" onClick={openCreateDialog} className="sm:mr-8">
						<Plus data-icon="inline-start" />
						Create API key
					</Button>
				}
			/>

			<div className="flex items-start gap-3 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
				<Laptop className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<p className="text-muted-foreground">
					<span className="font-medium text-foreground">Using Clawdi on a laptop?</span> Run{" "}
					<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">clawdi auth login</code>{" "}
					instead; it completes sign-in without a manually managed key.
				</p>
			</div>

			{error ? (
				<ApiErrorPanel error={error} onRetry={() => refetch()} title="Couldn’t load API keys" />
			) : isLoading ? (
				<>
					<ApiKeysMobileLoading />
					<DataTable columns={columns} data={[]} isLoading className="hidden md:block" />
				</>
			) : keys.length === 0 ? (
				<ApiKeysEmptyState onCreate={openCreateDialog} />
			) : (
				<>
					<div className="md:hidden">
						<ApiKeysMobileList keys={keys} onRevoke={handleRevoke} />
					</div>
					<DataTable
						columns={columns}
						data={keys}
						className="hidden md:block"
						tableContainerClassName="max-w-full"
					/>
				</>
			)}

			<Dialog open={createDialogOpen} onOpenChange={handleCreateDialogOpenChange}>
				<DialogContent
					showCloseButton={!createKey.isPending && createdKey === null}
					className="sm:max-w-lg"
				>
					<DialogHeader>
						<DialogTitle>{createdKey ? "Save your API key" : "Create API key"}</DialogTitle>
						<DialogDescription>
							{createdKey
								? "Copy this key now. For your security, it won’t be available again."
								: "Use a recognizable name so you know which client can be revoked later."}
						</DialogDescription>
					</DialogHeader>

					{createdKey ? (
						<div className="space-y-5">
							<Alert className="border-primary/30 bg-primary/5">
								<ShieldCheck aria-hidden="true" />
								<AlertTitle>Key created</AlertTitle>
								<AlertDescription>
									Store it in your secret manager and set it as{" "}
									<code className="font-mono text-xs">CLAWDI_AUTH_TOKEN</code> on the client.
								</AlertDescription>
							</Alert>

							<div className="flex min-w-0 items-start gap-2 rounded-lg border bg-muted/30 p-2">
								<code className="min-w-0 flex-1 select-all break-all px-1 py-1.5 font-mono text-xs leading-relaxed">
									{createdKey}
								</code>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void copy(createdKey)}
									data-copied={copied}
								>
									{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
									{copied ? "Copied" : "Copy"}
								</Button>
							</div>

							<div className="flex items-start gap-2.5">
								<Checkbox
									id="api-key-secret-acknowledgement"
									checked={secretAcknowledged}
									onCheckedChange={(checked) => setSecretAcknowledged(checked === true)}
									className="mt-0.5"
								/>
								<Label
									htmlFor="api-key-secret-acknowledgement"
									className="text-sm leading-snug font-normal"
								>
									I have copied and stored this API key safely.
								</Label>
							</div>

							<DialogFooter>
								<Button type="button" disabled={!secretAcknowledged} onClick={finishSecretReveal}>
									Done
								</Button>
							</DialogFooter>
						</div>
					) : (
						<form
							className="space-y-5"
							onSubmit={(event) => {
								event.preventDefault();
								if (normalizedNewLabel && !createKey.isPending) {
									void createKey.execute(normalizedNewLabel).catch(() => undefined);
								}
							}}
						>
							<div className="space-y-2">
								<Label htmlFor="new-key-label">Key name</Label>
								<Input
									id="new-key-label"
									value={newLabel}
									onChange={(event) => {
										setNewLabel(event.target.value);
										createKey.reset();
									}}
									placeholder="Production server"
									name="new-key-label"
									autoComplete="off"
									maxLength={API_KEY_LABEL_MAX_LENGTH}
									required
									disabled={createKey.isPending}
									aria-describedby="new-key-label-help"
								/>
								<p id="new-key-label-help" className="text-xs text-muted-foreground">
									For example, the server, container, or automation that will use this key.
								</p>
								{createKey.error ? (
									<p role="alert" className="text-xs text-destructive">
										The key couldn’t be created. Check the name and try again.
									</p>
								) : null}
							</div>

							<DialogFooter>
								<Button
									type="button"
									variant="outline"
									onClick={() => handleCreateDialogOpenChange(false)}
									disabled={createKey.isPending}
								>
									Cancel
								</Button>
								<Button type="submit" disabled={!normalizedNewLabel || createKey.isPending}>
									{createKey.isPending ? <Spinner /> : <Plus aria-hidden="true" />}
									Create API key
								</Button>
							</DialogFooter>
						</form>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}

function apiKeyColumns({
	showExpiration,
	onRevoke,
}: {
	showExpiration: boolean;
	onRevoke: (keyId: string) => Promise<unknown>;
}): ColumnDef<ApiKey>[] {
	const columns: ColumnDef<ApiKey>[] = [
		{
			accessorKey: "label",
			header: "Name",
			cell: ({ row }) => (
				<span className="block min-w-0 truncate font-medium" title={row.original.label}>
					{row.original.label}
				</span>
			),
			size: 240,
		},
		{
			accessorKey: "key_prefix",
			header: "Key",
			cell: ({ row }) => <KeyIdentifier prefix={row.original.key_prefix} />,
			size: 170,
		},
		{
			accessorKey: "created_at",
			header: "Created",
			cell: ({ row }) => <ApiKeyDate value={row.original.created_at} />,
			size: 120,
		},
		{
			accessorKey: "last_used_at",
			header: "Last used",
			cell: ({ row }) => <ApiKeyDate value={row.original.last_used_at} emptyLabel="Never" />,
			size: 120,
		},
	];

	if (showExpiration) {
		columns.push({
			accessorKey: "expires_at",
			header: "Expires",
			cell: ({ row }) => <ApiKeyDate value={row.original.expires_at} emptyLabel="Never" />,
			size: 120,
		});
	}

	columns.push({
		id: "actions",
		header: "",
		cell: ({ row }) => (
			<RevokeApiKeyAction key={row.original.id} apiKey={row.original} onRevoke={onRevoke} />
		),
		size: 88,
	});

	return columns;
}

function KeyIdentifier({ prefix }: { prefix: string }) {
	return (
		<code
			className="block min-w-0 truncate font-mono text-xs text-muted-foreground"
			title={`Key prefix: ${prefix}`}
		>
			{prefix}…
		</code>
	);
}

function ApiKeyDate({ value, emptyLabel = "—" }: { value: string | null; emptyLabel?: string }) {
	if (!value) return <span className="text-xs text-muted-foreground">{emptyLabel}</span>;
	return (
		<TimeTooltip value={value}>
			<span className="text-xs text-muted-foreground">{formatShortDate(value)}</span>
		</TimeTooltip>
	);
}

function RevokeApiKeyAction({
	apiKey,
	onRevoke,
}: {
	apiKey: ApiKey;
	onRevoke: (keyId: string) => Promise<unknown>;
}) {
	return (
		<ConfirmAction
			title={`Revoke “${apiKey.label}”?`}
			description={
				<p>
					Requests using this key will stop working. This can’t be undone; create and install a new
					key to reconnect the client.
				</p>
			}
			confirmLabel="Revoke key"
			destructive
			onConfirm={() => onRevoke(apiKey.id)}
		>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				aria-label={`Revoke ${apiKey.label}`}
				className="text-muted-foreground hover:text-destructive"
			>
				<Trash2 aria-hidden="true" />
				Revoke
			</Button>
		</ConfirmAction>
	);
}

function ApiKeysEmptyState({ onCreate }: { onCreate: () => void }) {
	return (
		<div className="rounded-lg border bg-card">
			<Empty className="p-8 sm:p-12">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<KeyRound aria-hidden="true" />
					</EmptyMedia>
					<EmptyTitle>No active API keys</EmptyTitle>
					<EmptyDescription>
						Create a key to authenticate a server, container, or other client that can’t open a
						browser.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button type="button" onClick={onCreate}>
						<Plus aria-hidden="true" />
						Create API key
					</Button>
				</EmptyContent>
			</Empty>
		</div>
	);
}

function ApiKeysMobileLoading() {
	return (
		<div className="flex flex-col gap-3 md:hidden" role="status">
			<span className="sr-only">Loading API keys</span>
			{[0, 1, 2].map((index) => (
				<div key={index} className="rounded-lg border bg-card p-4">
					<Skeleton className="h-4 w-2/3" />
					<Skeleton className="mt-3 h-3 w-1/2" />
					<Skeleton className="mt-4 h-8 w-full" />
				</div>
			))}
		</div>
	);
}

function ApiKeysMobileList({
	keys,
	onRevoke,
}: {
	keys: ApiKey[];
	onRevoke: (keyId: string) => Promise<unknown>;
}) {
	return (
		<div className="flex flex-col gap-3">
			{keys.map((key) => (
				<article key={key.id} className="min-w-0 rounded-lg border bg-card p-4">
					<div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
						<div className="min-w-0">
							<h3 className="line-clamp-2 break-all text-sm font-medium" title={key.label}>
								{key.label}
							</h3>
							<div className="mt-1.5 max-w-full">
								<KeyIdentifier prefix={key.key_prefix} />
							</div>
						</div>
						<RevokeApiKeyAction apiKey={key} onRevoke={onRevoke} />
					</div>

					<dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 text-xs">
						<div className="min-w-0">
							<dt className="text-muted-foreground">Created</dt>
							<dd className="mt-0.5 font-medium text-foreground">
								<ApiKeyDate value={key.created_at} />
							</dd>
						</div>
						<div className="min-w-0">
							<dt className="text-muted-foreground">Last used</dt>
							<dd className="mt-0.5 font-medium text-foreground">
								<ApiKeyDate value={key.last_used_at} emptyLabel="Never" />
							</dd>
						</div>
						{key.expires_at ? (
							<div className="min-w-0">
								<dt className="text-muted-foreground">Expires</dt>
								<dd className="mt-0.5 font-medium text-foreground">
									<ApiKeyDate value={key.expires_at} />
								</dd>
							</div>
						) : null}
					</dl>
				</article>
			))}
		</div>
	);
}
