"use client";

import {
	type components,
	type SessionShareTarget,
	sessionShareMatchesTarget,
} from "@clawdi/shared/api";
import { shareControlsClasses } from "@clawdi/shared/ui";
import {
	errorMessage,
	relativeTime,
	sessionDetailQueryKey,
	sessionShareDialogCopy,
	shareDetail,
	shareLabel,
} from "@clawdi/shared/view";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, Share2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiErrorPanel } from "@/components/api-error-panel";
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
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { ApiError, unwrap, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";

export type { SessionShareTarget } from "@clawdi/shared/api";

type SessionShareItem = components["schemas"]["SessionShareResponse"];
type SessionPermission = components["schemas"]["SessionPermissionResponse"];

export function SessionShareButton({ onClick }: { onClick: () => void }) {
	return (
		<Button variant="outline" size="sm" className={shareControlsClasses.button} onClick={onClick}>
			<Share2 />
			Share
		</Button>
	);
}

export function SessionShareDialog(props: {
	sessionId: string;
	target: SessionShareTarget;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<SessionShareDialogContent
			key={`${props.sessionId}:${props.target.scope}:${"position" in props.target ? props.target.position : ""}`}
			{...props}
		/>
	);
}

function SessionShareDialogContent({
	sessionId,
	target,
	open,
	onOpenChange,
}: {
	sessionId: string;
	target: SessionShareTarget;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const api = useApi();
	const queryClient = useQueryClient();
	const [createdShareId, setCreatedShareId] = useState<string | null>(null);
	const sharesKey = ["session-shares", sessionId] as const;
	const sharesQuery = useQuery({
		queryKey: sharesKey,
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/sessions/{session_id}/shares", {
					params: { path: { session_id: sessionId } },
				}),
			),
		enabled: open,
	});
	const permissionsKey = ["session-permissions", sessionId] as const;
	const permissionsQuery = useQuery({
		queryKey: permissionsKey,
		queryFn: async () =>
			unwrap(
				await api.GET("/v1/sessions/{session_id}/permissions", {
					params: { path: { session_id: sessionId } },
				}),
			),
		enabled: open && target.scope === "session",
	});

	const refreshShares = () => {
		void queryClient.invalidateQueries({ queryKey: sharesKey });
		void queryClient.invalidateQueries({ queryKey: permissionsKey });
		void queryClient.invalidateQueries({
			queryKey: sessionDetailQueryKey(sessionId),
		});
		void queryClient.invalidateQueries({ queryKey: ["get", "/v1/sessions"] });
	};
	const createShare = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.POST("/v1/sessions/{session_id}/shares", {
					params: { path: { session_id: sessionId } },
					body: target,
				}),
			),
		onSuccess: (share) => {
			setCreatedShareId(share.id);
			queryClient.setQueryData<{ shares: SessionShareItem[] }>(sharesKey, (current) => ({
				shares: [share, ...(current?.shares.filter((item) => item.id !== share.id) ?? [])],
			}));
			refreshShares();
			toast.success("Share link created");
		},
		onError: (error) => toast.error(errorMessage(error)),
	});

	const { title, description } = sessionShareDialogCopy(target);
	const shares = sharesQuery.data?.shares ?? [];
	const matchingShares = shares.filter((share) => sessionShareMatchesTarget(share, target));
	const latestShare =
		matchingShares.find((share) => share.id === createdShareId) ?? matchingShares[0];
	const previousShares = matchingShares.filter((share) => share.id !== latestShare?.id);
	const otherShares =
		target.scope === "session" ? shares.filter((share) => share.scope !== "session") : [];
	const legacyLink =
		target.scope === "session"
			? permissionsQuery.data?.permissions.find(
					(permission: SessionPermission) => permission.kind === "link",
				)
			: undefined;
	const isLoading =
		sharesQuery.isLoading || (target.scope === "session" && permissionsQuery.isLoading);
	const loadError =
		sharesQuery.error ?? (target.scope === "session" ? permissionsQuery.error : null);
	const legacyUrl = typeof window === "undefined" ? "" : `${window.location.origin}/s/${sessionId}`;
	const revokeShare = async (shareId: string) => {
		const result = await api.DELETE("/v1/session-shares/{share_id}", {
			params: { path: { share_id: shareId } },
		});
		if (result.error !== undefined) {
			throw new ApiError(result.response.status, JSON.stringify(result.error));
		}
	};
	const revokeLegacyLink = async () => {
		const result = await api.DELETE("/v1/sessions/{session_id}/permissions", {
			params: {
				path: { session_id: sessionId },
				query: { kind: "link" },
			},
		});
		if (result.error !== undefined) {
			throw new ApiError(result.response.status, JSON.stringify(result.error));
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) setCreatedShareId(null);
			}}
		>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>

				<div className={shareControlsClasses.body}>
					{isLoading ? (
						<div className="flex min-h-16 items-center justify-center text-muted-foreground">
							<Spinner className="size-4" />
						</div>
					) : null}
					{loadError ? (
						<ApiErrorPanel
							error={loadError}
							title="Couldn't load share links"
							onRetry={() => {
								void sharesQuery.refetch();
								if (target.scope === "session") void permissionsQuery.refetch();
							}}
						/>
					) : null}
					{latestShare ? (
						<ShareLinkRow
							key={latestShare.id}
							url={latestShare.share_url}
							label={shareLabel(latestShare)}
							detail={shareDetail(latestShare)}
							autoFocus={latestShare.id === createdShareId}
							onRevoke={() => revokeShare(latestShare.id)}
							onRevoked={refreshShares}
						/>
					) : null}

					{previousShares.length + otherShares.length + (legacyLink ? 1 : 0) > 0 ? (
						<details className={shareControlsClasses.body}>
							<summary className={shareControlsClasses.older}>
								Other active links (
								{previousShares.length + otherShares.length + (legacyLink ? 1 : 0)})
							</summary>
							{[...previousShares, ...otherShares].map((share) => (
								<ShareLinkRow
									key={share.id}
									url={share.share_url}
									label={shareLabel(share)}
									detail={shareDetail(share)}
									onRevoke={() => revokeShare(share.id)}
									onRevoked={refreshShares}
								/>
							))}
							{legacyLink ? (
								<div className="border-t pt-3">
									<p className="mb-2 text-xs font-medium text-muted-foreground">Older link</p>
									<ShareLinkRow
										url={legacyUrl}
										label="Live session link"
										detail={`Reflects future uploads · created ${relativeTime(legacyLink.created_at)}`}
										onRevoke={revokeLegacyLink}
										onRevoked={refreshShares}
									/>
								</div>
							) : null}
						</details>
					) : null}
				</div>

				<DialogFooter>
					<Button
						variant={latestShare ? "outline" : "default"}
						onClick={() => createShare.mutate()}
						disabled={createShare.isPending || isLoading || Boolean(loadError)}
					>
						{createShare.isPending ? <Spinner className="size-4" /> : <Link2 />}
						{matchingShares.length > 0 ? "Create new snapshot" : "Create link"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ShareLinkRow({
	url,
	label,
	detail,
	onRevoke,
	onRevoked,
	autoFocus = false,
}: {
	url: string;
	label: string;
	detail: string;
	onRevoke: () => Promise<void>;
	onRevoked: () => void;
	autoFocus?: boolean;
}) {
	const { copied, copy } = useCopyToClipboard({ success: "Share link copied" });
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [revokeSucceeded, setRevokeSucceeded] = useState(false);
	const revoke = useMutation({
		mutationFn: onRevoke,
		onSuccess: () => {
			setRevokeSucceeded(true);
			setConfirmOpen(false);
			toast.success("Share link turned off");
		},
		onError: (error) => toast.error(errorMessage(error)),
	});
	return (
		<div className={shareControlsClasses.link}>
			<div className={shareControlsClasses.linkHeader}>
				<div className="min-w-0">
					<p className={shareControlsClasses.linkTitle}>{label}</p>
					<p className={shareControlsClasses.linkMeta}>{detail}</p>
				</div>
				<Button
					variant="ghost"
					size="icon-sm"
					className={shareControlsClasses.revoke}
					onClick={() => setConfirmOpen(true)}
					aria-label="Turn off share link"
				>
					<Trash2 />
				</Button>
			</div>
			<div className={shareControlsClasses.linkActions}>
				<Input
					readOnly
					value={url}
					aria-label="Session share URL"
					className={shareControlsClasses.url}
					onFocus={(event) => event.currentTarget.select()}
				/>
				<Button
					variant="outline"
					size="sm"
					className={cn(shareControlsClasses.copy, copied && "text-success")}
					onClick={() => copy(url)}
					autoFocus={autoFocus}
				>
					{copied ? <Check /> : <Copy />}
					Copy
				</Button>
			</div>

			<AlertDialog
				open={confirmOpen}
				onOpenChange={(nextOpen) => {
					if (!revoke.isPending) setConfirmOpen(nextOpen);
				}}
				onOpenChangeComplete={(nextOpen) => {
					if (!nextOpen && revokeSucceeded) {
						setRevokeSucceeded(false);
						onRevoked();
					}
				}}
			>
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
