"use client";

import type { components } from "@clawdi/shared/api";
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
import { sessionDetailQueryKey } from "@/lib/session-queries";
import { cn, errorMessage, relativeTime } from "@/lib/utils";

export type SessionShareTarget =
	| { scope: "session" }
	| { scope: "through" | "response"; position: number };

type SessionShareItem = components["schemas"]["SessionShareResponse"];
type SessionPermission = components["schemas"]["SessionPermissionResponse"];

export function SessionShareButton({ onClick }: { onClick: () => void }) {
	return (
		<Button variant="outline" size="sm" className="h-8" onClick={onClick}>
			<Share2 />
			Share
		</Button>
	);
}

export function SessionShareDialog({
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

	const title =
		target.scope === "response"
			? "Share this response"
			: target.scope === "through"
				? "Share conversation to here"
				: "Share session";
	const description =
		target.scope === "response"
			? "Create a link containing only this Agent response."
			: target.scope === "through"
				? "Create a link containing the conversation through this message."
				: "Create a snapshot of the current conversation. Future messages won’t be added.";
	const shares = sharesQuery.data?.shares ?? [];
	const matchingShares = shares.filter((share) => {
		if (share.scope !== target.scope) return false;
		return target.scope === "session" || share.end_position === target.position;
	});
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

				<div className="space-y-3">
					{isLoading ? (
						<div className="flex min-h-16 items-center justify-center text-muted-foreground">
							<Spinner className="size-4" />
						</div>
					) : loadError ? (
						<ApiErrorPanel
							error={loadError}
							title="Couldn't load share links"
							onRetry={() => {
								void sharesQuery.refetch();
								if (target.scope === "session") void permissionsQuery.refetch();
							}}
						/>
					) : matchingShares.length > 0 ? (
						<div className="space-y-2">
							{matchingShares.map((share) => (
								<ShareLinkRow
									key={share.id}
									url={share.share_url}
									label={shareLabel(share)}
									detail={shareDetail(share)}
									autoFocus={share.id === createdShareId}
									onRevoke={() => revokeShare(share.id)}
									onRevoked={refreshShares}
								/>
							))}
						</div>
					) : (
						<div className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
							No snapshot has been created for this view yet.
						</div>
					)}

					{legacyLink ? (
						<div className="border-t pt-3">
							<p className="mb-2 text-xs font-medium text-muted-foreground">Older link</p>
							<ShareLinkRow
								url={legacyUrl}
								label="Live Session link"
								detail={`Reflects future uploads · created ${relativeTime(legacyLink.created_at)}`}
								onRevoke={revokeLegacyLink}
								onRevoked={refreshShares}
							/>
						</div>
					) : null}

					{otherShares.length > 0 ? (
						<div className="border-t pt-3">
							<p className="mb-2 text-xs font-medium text-muted-foreground">Other active links</p>
							<div className="space-y-2">
								{otherShares.map((share) => (
									<ShareLinkRow
										key={share.id}
										url={share.share_url}
										label={shareLabel(share)}
										detail={shareDetail(share)}
										onRevoke={() => revokeShare(share.id)}
										onRevoked={refreshShares}
										compact
									/>
								))}
							</div>
						</div>
					) : null}
				</div>

				<DialogFooter>
					<Button
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

function shareLabel(share: SessionShareItem): string {
	if (share.scope === "session") return "Full Session snapshot";
	if (share.scope === "response") return "Single response snapshot";
	return `Conversation through message ${share.message_count}`;
}

function shareDetail(share: SessionShareItem): string {
	return `Created ${relativeTime(share.created_at)} · ${share.message_count} message${share.message_count === 1 ? "" : "s"}`;
}

function ShareLinkRow({
	url,
	label,
	detail,
	onRevoke,
	onRevoked,
	autoFocus = false,
	compact = false,
}: {
	url: string;
	label: string;
	detail: string;
	onRevoke: () => Promise<void>;
	onRevoked: () => void;
	autoFocus?: boolean;
	compact?: boolean;
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
		<div className={cn("rounded-lg border p-3", compact && "p-2.5")}>
			<div className="mb-2 flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">{label}</p>
					<p className="text-xs text-muted-foreground">{detail}</p>
				</div>
				<Button
					variant="ghost"
					size="icon-sm"
					className="text-muted-foreground hover:text-destructive"
					onClick={() => setConfirmOpen(true)}
					aria-label="Turn off share link"
				>
					<Trash2 />
				</Button>
			</div>
			<div className="flex gap-2">
				<Input
					readOnly
					value={url}
					aria-label="Session share URL"
					className="h-8 min-w-0 font-mono text-xs"
					onFocus={(event) => event.currentTarget.select()}
				/>
				<Button
					variant="outline"
					size="sm"
					className={cn("h-8 shrink-0", copied && "text-success")}
					onClick={() => copy(url)}
					autoFocus={autoFocus}
				>
					{copied ? <Check /> : <Copy />}
					Copy
				</Button>
			</div>

			<AlertDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
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
