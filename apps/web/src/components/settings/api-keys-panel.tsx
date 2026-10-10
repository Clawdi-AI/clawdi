"use client";

import { formatShortDate } from "@clawdi/shared/view";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Terminal, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import {
	API_KEYS_QUERY_KEY,
	activeApiKeys,
	describeApiKeyScopes,
	removeApiKeyFromList,
	restoreApiKeyToList,
} from "@/components/settings/api-keys-panel.logic";
import { SettingsPanelHeader } from "@/components/settings/settings-panel-header";
import { TimeTooltip } from "@/components/time-tooltip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumnDef } from "@/components/ui/data-table";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useDialogExitLifecycle } from "@/components/ui/use-dialog-exit-lifecycle";
import { toastApiError, useApi } from "@/lib/api";
import type { ApiKey } from "@/lib/api-schemas";
import { shouldBlockQueryError } from "@/lib/query-state";
import { unwrapReverifiable, useReverifiedRequest } from "@/lib/reverification";

const REVOKE_API_KEY_MUTATION_KEY = ["revoke-api-key"] as const;

type RevokeContext = {
	removedKey?: ApiKey;
};

/** API Keys settings — review and revoke existing bearer tokens; new keys are internal only. */
export function ApiKeysPanel() {
	const api = useApi();
	const queryClient = useQueryClient();
	const [revokeOpen, setRevokeOpen] = useState(false);
	const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
	const revokeExit = useDialogExitLifecycle({
		open: revokeOpen,
		value: revokeTarget,
		emptyValue: null,
	});
	const renderedRevokeTarget = revokeExit.renderedValue;

	// Listing and revoking keys require a recently verified session; Clerk prompts, then retries.
	const listKeys = useReverifiedRequest(async (signal: AbortSignal) =>
		unwrapReverifiable(await api.GET("/v1/auth/keys", { signal })),
	);
	const revoke = useReverifiedRequest(async (keyId: string) =>
		unwrapReverifiable(
			await api.DELETE("/v1/auth/keys/{key_id}", { params: { path: { key_id: keyId } } }),
		),
	);
	const {
		data: listedKeys,
		error,
		isLoading,
		refetch,
	} = useQuery({
		queryKey: API_KEYS_QUERY_KEY,
		queryFn: ({ signal }) => listKeys(signal),
		// Listing can prompt for verification, so don't refetch behind the user's back.
		refetchOnWindowFocus: false,
	});
	const keys = useMemo(() => activeApiKeys(listedKeys), [listedKeys]);

	const revokeKey = useMutation({
		mutationKey: REVOKE_API_KEY_MUTATION_KEY,
		mutationFn: revoke,
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
			revokeExit.beginClose();
			setRevokeOpen(false);
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

	const handleRevoke = useCallback((key: ApiKey) => {
		setRevokeTarget(key);
		setRevokeOpen(true);
	}, []);
	const listBlocked = shouldBlockQueryError(error, listedKeys);
	const isEmpty = !listBlocked && !isLoading && keys.length === 0;
	const showExpiration = keys.some((key) => key.expires_at !== null);
	const columns = useMemo(
		() => apiKeyColumns({ showExpiration, onRevoke: handleRevoke }),
		[handleRevoke, showExpiration],
	);

	return (
		<div className="flex flex-col gap-8 px-5 sm:px-6 lg:px-8">
			<SettingsPanelHeader
				title="API Keys"
				description="Review and revoke bearer tokens created for servers and automation."
			/>

			{isEmpty ? null : (
				<Alert>
					<Terminal aria-hidden="true" />
					<AlertDescription>
						<ApiKeysRetiredNote />
					</AlertDescription>
				</Alert>
			)}

			{listBlocked ? (
				<ApiErrorPanel error={error} onRetry={() => refetch()} title="Couldn’t load API keys" />
			) : isLoading ? (
				<>
					<ApiKeysMobileLoading />
					<DataTable columns={columns} data={[]} isLoading className="hidden md:block" />
				</>
			) : isEmpty ? (
				<ApiKeysEmptyState />
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

			<AlertDialog
				open={revokeOpen}
				onOpenChange={(nextOpen) => {
					if (revokeKey.isPending) return;
					if (nextOpen) revokeExit.beginOpen();
					else revokeExit.beginClose();
					setRevokeOpen(nextOpen);
				}}
				onOpenChangeComplete={(nextOpen) => {
					if (!nextOpen) {
						revokeExit.completeClose();
						setRevokeTarget(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Revoke “{renderedRevokeTarget?.label ?? "API key"}”?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Requests using this key will stop working. This can’t be undone; reconnect the client
							with <code className="font-mono text-xs">clawdi auth login</code>.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={revokeKey.isPending}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={!renderedRevokeTarget || revokeKey.isPending}
							onClick={(event) => {
								event.preventDefault();
								if (renderedRevokeTarget && !revokeKey.isPending)
									revokeKey.mutate(renderedRevokeTarget.id);
							}}
						>
							{revokeKey.isPending ? <Spinner /> : null}
							Revoke key
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function apiKeyColumns({
	showExpiration,
	onRevoke,
}: {
	showExpiration: boolean;
	onRevoke: (key: ApiKey) => void;
}): DataTableColumnDef<ApiKey>[] {
	const columns: DataTableColumnDef<ApiKey>[] = [
		{
			accessorKey: "label",
			header: "Name",
			cell: ({ row }) => (
				<div className="min-w-0">
					<span className="block min-w-0 truncate font-medium" title={row.original.label}>
						{row.original.label}
					</span>
					<KeyIdentifier prefix={row.original.key_prefix} />
				</div>
			),
			size: 200,
		},
		{
			accessorKey: "scopes",
			header: "Permissions",
			cell: ({ row }) => <ApiKeyScopes scopes={row.original.scopes} />,
			size: 200,
		},
		{
			accessorKey: "created_at",
			header: "Created",
			cell: ({ row }) => <ApiKeyDate value={row.original.created_at} />,
			size: 104,
		},
		{
			accessorKey: "last_used_at",
			header: "Last used",
			cell: ({ row }) => <ApiKeyDate value={row.original.last_used_at} emptyLabel="Never" />,
			size: 104,
		},
	];

	if (showExpiration) {
		columns.push({
			accessorKey: "expires_at",
			header: "Expires",
			cell: ({ row }) => <ApiKeyDate value={row.original.expires_at} emptyLabel="Never" />,
			size: 104,
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

function ApiKeyScopes({ scopes }: { scopes: string[] | null }) {
	const description = describeApiKeyScopes(scopes);
	return (
		<span className="block min-w-0 truncate text-xs text-muted-foreground" title={description}>
			{description}
		</span>
	);
}

function ApiKeysRetiredNote() {
	return (
		<>
			API keys can no longer be created. To connect Clawdi on your computer or a server, run{" "}
			<code className="font-mono text-xs whitespace-nowrap">clawdi auth login</code> (use{" "}
			<code className="font-mono text-xs whitespace-nowrap">--no-open</code> on a server). Existing
			keys keep working until you revoke them.
		</>
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
	onRevoke: (key: ApiKey) => void;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			aria-label={`Revoke ${apiKey.label}`}
			className="text-muted-foreground hover:text-destructive"
			onClick={() => onRevoke(apiKey)}
		>
			<Trash2 aria-hidden="true" />
			Revoke
		</Button>
	);
}

function ApiKeysEmptyState() {
	return (
		<div className="rounded-lg border bg-card">
			<Empty className="p-8 sm:p-12">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<KeyRound aria-hidden="true" />
					</EmptyMedia>
					<EmptyTitle>No active API keys</EmptyTitle>
					<EmptyDescription>
						<ApiKeysRetiredNote />
					</EmptyDescription>
				</EmptyHeader>
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
	onRevoke: (key: ApiKey) => void;
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
						<div className="col-span-2 min-w-0">
							<dt className="text-muted-foreground">Permissions</dt>
							<dd className="mt-0.5 break-words font-medium text-foreground">
								{describeApiKeyScopes(key.scopes)}
							</dd>
						</div>
					</dl>
				</article>
			))}
		</div>
	);
}
