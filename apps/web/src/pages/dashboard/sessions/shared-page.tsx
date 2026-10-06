"use client";

import { type components, sessionShareIdentity } from "@clawdi/shared/api";
import { sharedSessionLinksClasses } from "@clawdi/shared/ui";
import { relativeTime, shareScopeLabel } from "@clawdi/shared/view";
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
import { cn } from "@/lib/utils";

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
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, sharedSessionLinksClasses.page)}>
			<PageHeader
				title="Shared Session Links"
				description="Review and turn off every active session link from one place."
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
					title="No active session links"
					description="Links you create from a session will appear here."
					action={
						<Button render={<Link to="/sessions" />} nativeButton={false} variant="outline">
							Browse sessions
						</Button>
					}
				/>
			) : (
				<div className="space-y-4">
					<div className={sharedSessionLinksClasses.list}>
						{items.map((share, index) => (
							<SharedLinkRow
								key={sessionShareIdentity(share)}
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
		<div className={cn(sharedSessionLinksClasses.row, className)}>
			<div className={sharedSessionLinksClasses.content}>
				<div className={sharedSessionLinksClasses.titleRow}>
					<Link
						to="/sessions/$id"
						params={{ id: share.session_id }}
						className={sharedSessionLinksClasses.title}
					>
						{share.session_title}
					</Link>
					<Badge variant="outline">{share.kind === "live" ? "Live" : "Snapshot"}</Badge>
				</div>
				<p className={sharedSessionLinksClasses.meta}>
					{scope} · {share.message_count} {share.message_count === 1 ? "message" : "messages"} ·
					Created {relativeTime(share.created_at)}
				</p>
				{share.kind === "live" ? (
					<p className={sharedSessionLinksClasses.meta}>
						Updates when the session is uploaded again.
					</p>
				) : null}
			</div>
			<div className={sharedSessionLinksClasses.actions}>
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
					className={sharedSessionLinksClasses.revoke}
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
							Anyone using this link will immediately lose access. The original session stays
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

function SharedLinksSkeleton() {
	return (
		<div className={sharedSessionLinksClasses.skeleton} aria-hidden="true">
			{Array.from({ length: 4 }, (_, index) => (
				<div
					key={index}
					className={cn(sharedSessionLinksClasses.skeletonRow, index > 0 && "border-t")}
				>
					<div className={sharedSessionLinksClasses.skeletonBody}>
						<Skeleton className={sharedSessionLinksClasses.skeletonTitle} />
						<Skeleton className={sharedSessionLinksClasses.skeletonMeta} />
					</div>
					<Skeleton className={sharedSessionLinksClasses.skeletonActions} />
				</div>
			))}
		</div>
	);
}
