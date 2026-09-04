"use client";

import type { components } from "@clawdi/shared/api";
import { keepPreviousData, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Check, Copy, ExternalLink, Link2, Trash2 } from "lucide-react";
import { useQueryStates } from "nuqs";
import { useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTablePagination } from "@/components/ui/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { unwrap, useApi, useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import { parseAsPositiveInt } from "@/lib/url-search-parsers";
import { cn, relativeTime } from "@/lib/utils";

type SessionShare = components["schemas"]["SessionShareListItemResponse"];

export default function SharedSessionLinksPage() {
	const $api = useOpenApi();
	const queryClient = useQueryClient();
	const [params, setParams] = useQueryStates(
		{
			page: parseAsPositiveInt.withDefault(1),
			pageSize: parseAsPositiveInt.withDefault(25),
		},
		{ clearOnDefault: true, history: "replace" },
	);
	const query = $api.useQuery(
		"get",
		"/v1/session-shares",
		{
			params: { query: { page: params.page, page_size: params.pageSize } },
		},
		{ placeholderData: keepPreviousData },
	);
	const items = query.data?.items ?? [];
	const total = query.data?.total ?? 0;
	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: ["get", "/v1/session-shares"] });
		void queryClient.invalidateQueries({ queryKey: ["get", "/v1/sessions"] });
	};

	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-5 px-4 lg:px-6")}>
			<PageHeader
				title="Shared Session links"
				description="Review and turn off every active Session link from one place."
				actions={
					<Button render={<Link to="/sessions" />} nativeButton={false} variant="outline" size="sm">
						<ArrowLeft />
						Sessions
					</Button>
				}
			/>

			{query.error && !query.data ? (
				<ApiErrorPanel
					error={query.error}
					title="Couldn't load shared links"
					onRetry={() => void query.refetch()}
				/>
			) : query.isLoading ? (
				<SharedLinksSkeleton />
			) : items.length === 0 ? (
				<EmptyState
					icon={Link2}
					title="No active Session links"
					description="Links you create from a Session will appear here."
					action={
						<Button render={<Link to="/sessions" />} nativeButton={false} variant="outline">
							Browse Sessions
						</Button>
					}
				/>
			) : (
				<div className="space-y-4">
					<div className="overflow-hidden rounded-lg border bg-card">
						{items.map((share, index) => (
							<SharedLinkRow
								key={`${share.kind}:${share.id}`}
								share={share}
								onRevoked={refresh}
								className={index > 0 ? "border-t" : undefined}
							/>
						))}
					</div>
					<DataTablePagination
						page={params.page}
						pageSize={params.pageSize}
						total={total}
						onPageChange={(page) => void setParams({ page })}
						onPageSizeChange={(pageSize) => void setParams({ page: 1, pageSize })}
					/>
				</div>
			)}
		</div>
	);
}

function SharedLinkRow({
	share,
	onRevoked,
	className,
}: {
	share: SessionShare;
	onRevoked: () => void;
	className?: string;
}) {
	const api = useApi();
	const { copied, copy } = useCopyToClipboard({ success: "Share link copied" });
	const [confirmOpen, setConfirmOpen] = useState(false);
	const revoke = useMutation({
		mutationFn: async () => {
			if (share.kind === "snapshot") {
				unwrap(
					await api.DELETE("/v1/session-shares/{share_id}", {
						params: { path: { share_id: share.id } },
					}),
				);
				return;
			}
			unwrap(
				await api.DELETE("/v1/sessions/{session_id}/permissions", {
					params: {
						path: { session_id: share.session_id },
						query: { kind: "link" },
					},
				}),
			);
		},
		onSuccess: () => {
			setConfirmOpen(false);
			onRevoked();
			toast.success("Share link turned off");
		},
		onError: (error) =>
			toast.error("Couldn't turn off share link", {
				description: normalizeApiError(error),
			}),
	});
	const scope = shareScopeLabel(share);

	return (
		<div className={cn("flex flex-col gap-3 p-4 sm:flex-row sm:items-center", className)}>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<Link
						to="/sessions/$id"
						params={{ id: share.session_id }}
						className="truncate text-sm font-medium underline-offset-4 hover:underline"
					>
						{share.session_title}
					</Link>
					<Badge variant="outline">{share.kind === "live" ? "Live" : "Snapshot"}</Badge>
				</div>
				<p className="mt-1 text-xs text-muted-foreground">
					{scope} · {share.message_count} {share.message_count === 1 ? "message" : "messages"} ·
					Created {relativeTime(share.created_at)}
				</p>
				{share.kind === "live" ? (
					<p className="mt-1 text-xs text-muted-foreground">
						Updates when the Session is uploaded again.
					</p>
				) : null}
			</div>
			<div className="flex shrink-0 flex-wrap items-center gap-2">
				<Button variant="outline" size="sm" onClick={() => void copy(share.share_url)}>
					{copied ? <Check /> : <Copy />}
					Copy
				</Button>
				<Button
					render={<a href={share.share_url} target="_blank" rel="noreferrer" />}
					nativeButton={false}
					variant="outline"
					size="sm"
				>
					<ExternalLink />
					Open
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					className="text-muted-foreground hover:text-destructive"
					onClick={() => setConfirmOpen(true)}
					aria-label={`Turn off share link for ${share.session_title}`}
				>
					<Trash2 />
				</Button>
			</div>

			<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Turn off this share link?</AlertDialogTitle>
						<AlertDialogDescription>
							Anyone using this link will immediately lose access. The original Session stays
							unchanged.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={revoke.isPending}
							onClick={() => revoke.mutate()}
						>
							Turn off link
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function shareScopeLabel(share: SessionShare): string {
	if (share.kind === "live") return "Full Session, live";
	if (share.scope === "response") return "Single Agent response";
	if (share.scope === "through") return "Conversation excerpt";
	return "Full Session snapshot";
}

function SharedLinksSkeleton() {
	return (
		<div className="overflow-hidden rounded-lg border" aria-hidden="true">
			{Array.from({ length: 4 }, (_, index) => (
				<div key={index} className={cn("flex items-center gap-4 p-4", index > 0 && "border-t")}>
					<div className="min-w-0 flex-1 space-y-2">
						<Skeleton className="h-4 w-48 max-w-full" />
						<Skeleton className="h-3 w-72 max-w-full" />
					</div>
					<Skeleton className="h-8 w-32 shrink-0" />
				</div>
			))}
		</div>
	);
}
