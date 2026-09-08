"use client";

import { buildShareAgentHandoffPrompt } from "@clawdi/shared/sharing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Copy, Link2, Share2, Trash2, UserMinus } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isCustomProject } from "@/components/projects/project-metadata";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDialogExitLifecycle } from "@/components/ui/use-dialog-exit-lifecycle";
import { ApiError, unwrap, useApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import { shouldBlockQueryError } from "@/lib/query-state";
import { useSensitiveAction } from "@/lib/use-sensitive-action";

type ShareLinkRow = components["schemas"]["ShareLinkResponse"];
type ShareLinkCreated = components["schemas"]["ShareLinkCreated"];
type Invitation = components["schemas"]["InvitationResponse"];
type Member = components["schemas"]["MemberResponse"];

interface ShareProjectDialogProps {
	projectId: string;
	projectName: string;
	projectKind?: string;
	children?: ReactElement | null;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

export function ShareProjectDialog({
	projectId,
	projectName,
	projectKind,
	children,
	open: controlledOpen,
	onOpenChange,
}: ShareProjectDialogProps) {
	const [internalOpen, setInternalOpen] = useState(false);
	const open = controlledOpen ?? internalOpen;
	const setOpen = (nextOpen: boolean) => {
		if (controlledOpen === undefined) setInternalOpen(nextOpen);
		onOpenChange?.(nextOpen);
	};
	const isShareableProject = isCustomProject({ kind: projectKind });
	const trigger =
		children === undefined ? (
			<Button variant="outline" size="sm" aria-label={`Share ${projectName}`}>
				<Share2 className="mr-2 size-4" />
				Share project
			</Button>
		) : (
			children
		);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			{trigger ? <DialogTrigger render={trigger} /> : null}
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle className="pr-8 leading-snug break-words">
						{isShareableProject ? `Share ${projectName}` : "Only Projects you create can be shared"}
					</DialogTitle>
					<DialogDescription>
						{isShareableProject
							? "People can view this Project and let their Agents use its keys. Secret values stay hidden in the dashboard. Only you can edit."
							: "Sharing is available for Projects you create. An Agent's private Workspace cannot be shared."}
					</DialogDescription>
				</DialogHeader>
				{isShareableProject ? (
					<div key={projectId} className="space-y-4">
						<InvitationsPanel projectId={projectId} />
						<MembersPanel projectId={projectId} />
						<section className="space-y-3 border-t pt-4" aria-label="Invite links">
							<ShareLinksPanel projectId={projectId} open={open} />
						</section>
						<StopSharingPanel projectId={projectId} />
					</div>
				) : (
					<Alert>
						<AlertCircle />
						<AlertTitle>This resource cannot be shared</AlertTitle>
						<AlertDescription>
							Only Projects you create can have members, invitations, and share links.
						</AlertDescription>
					</Alert>
				)}
			</DialogContent>
		</Dialog>
	);
}

function ShareLinksPanel({ projectId, open }: { projectId: string; open: boolean }) {
	const api = useApi();
	const qc = useQueryClient();
	// The just-created link's full URL is shown once because the server
	// stores only the prefix going forward.
	const [freshLink, setFreshLink] = useState<ShareLinkCreated | null>(null);
	const [revokeOpen, setRevokeOpen] = useState(false);
	const [revokeTarget, setRevokeTarget] = useState<ShareLinkRow | null>(null);
	const revokeSucceededRef = useRef(false);
	const revokeExit = useDialogExitLifecycle({
		open: revokeOpen,
		value: revokeTarget,
		emptyValue: null,
	});
	const renderedRevokeTarget = revokeExit.renderedValue;
	useEffect(() => {
		if (open) setFreshLink(null);
	}, [open]);

	const links = useQuery({
		queryKey: ["share-links", projectId],
		queryFn: async (): Promise<ShareLinkRow[]> =>
			unwrap(
				await api.GET("/v1/projects/{project_id}/share-links", {
					params: { path: { project_id: projectId } },
				}),
			),
	});

	const create = useSensitiveAction(async (): Promise<ShareLinkCreated> => {
		try {
			const body = unwrap(
				await api.POST("/v1/projects/{project_id}/share-links", {
					params: { path: { project_id: projectId } },
					body: {},
				}),
			);
			setFreshLink(body);
			qc.invalidateQueries({ queryKey: ["share-links", projectId] });
			// Best-effort auto-copy. Browsers without the async
			// clipboard API silently fall through to the manual copy
			// button in the banner.
			if (typeof navigator !== "undefined" && navigator.clipboard) {
				navigator.clipboard.writeText(body.url).catch(() => {});
			}
			toast.success("Invite link created");
			return body;
		} catch (e) {
			toast.error(
				e instanceof ApiError && e.status === 409
					? "Set a display name on your profile before sharing."
					: "Couldn't create link. Try again.",
			);
			throw e;
		}
	});

	const revoke = useMutation({
		mutationFn: async (linkId: string) => {
			await unwrap(
				await api.DELETE("/v1/projects/{project_id}/share-links/{link_id}", {
					params: { path: { project_id: projectId, link_id: linkId } },
				}),
			);
		},
		onSuccess: () => {
			revokeSucceededRef.current = true;
			revokeExit.beginClose();
			setRevokeOpen(false);
			toast.success("Invite link turned off");
		},
		onError: (e) => {
			toast.error("Couldn't turn off link", {
				description: normalizeApiError(e),
			});
		},
	});

	const activeLinks = (links.data ?? []).filter(
		(link) => link.revoked_at === null && !isExpiredLink(link),
	);
	const inactiveLinks = (links.data ?? []).filter(
		(link) => link.revoked_at !== null || isExpiredLink(link),
	);

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="text-sm font-semibold">Invite link</h3>
				<Button
					variant="outline"
					size="sm"
					disabled={create.isPending}
					onClick={() => {
						void create.execute().catch(() => undefined);
					}}
				>
					<Link2 className="mr-1.5 size-4" />
					{create.isPending ? "Creating…" : "Create invite link"}
				</Button>
			</div>
			<p className="text-sm text-muted-foreground">
				Anyone with the link can preview and join this Project.
			</p>
			{freshLink && !inactiveLinks.some((link) => link.id === freshLink.id) ? (
				<FreshLinkBanner link={freshLink} onDismiss={() => setFreshLink(null)} />
			) : null}
			{links.isLoading ? (
				<Skeleton className="h-10 w-full" />
			) : shouldBlockQueryError(links.error, links.data) ? (
				<EmptyHint variant="destructive" message={normalizeApiError(links.error)} />
			) : activeLinks.length > 0 ? (
				<ul className="space-y-1">
					{activeLinks.map((link) => (
						<LinkRow
							key={link.id}
							link={link}
							onRevoke={() => {
								revokeSucceededRef.current = false;
								setRevokeTarget(link);
								setRevokeOpen(true);
							}}
							revoking={revoke.isPending && revoke.variables === link.id}
						/>
					))}
				</ul>
			) : null}
			{inactiveLinks.length > 0 ? (
				<details className="text-sm">
					<summary className="cursor-pointer text-muted-foreground">
						Inactive links ({inactiveLinks.length})
					</summary>
					<ul className="mt-2 space-y-1">
						{inactiveLinks.map((link) => (
							<LinkRow key={link.id} link={link} revoking={false} />
						))}
					</ul>
				</details>
			) : null}
			<AlertDialog
				open={revokeOpen}
				onOpenChange={(nextOpen) => {
					if (!revoke.isPending) {
						if (nextOpen) revokeExit.beginOpen();
						else revokeExit.beginClose();
						setRevokeOpen(nextOpen);
					}
				}}
				onOpenChangeComplete={(nextOpen) => {
					if (nextOpen) return;
					setRevokeTarget(null);
					revokeExit.completeClose();
					if (revokeSucceededRef.current) {
						revokeSucceededRef.current = false;
						void qc.invalidateQueries({ queryKey: ["share-links", projectId] });
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Turn off this invite link?</AlertDialogTitle>
						<AlertDialogDescription>
							People will no longer be able to join from this link. Existing members retain access
							until removed from People.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								event.preventDefault();
								if (renderedRevokeTarget && !revoke.isPending)
									revoke.mutate(renderedRevokeTarget.id);
							}}
							disabled={!renderedRevokeTarget || revoke.isPending}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{revoke.isPending ? "Turning off…" : "Turn off link"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function FreshLinkBanner({ link, onDismiss }: { link: ShareLinkCreated; onDismiss: () => void }) {
	const copyText = (value: string, success: string) => {
		if (typeof navigator !== "undefined" && navigator.clipboard) {
			navigator.clipboard
				.writeText(value)
				.then(() => toast.success(success))
				.catch(() =>
					toast.error("Couldn't copy", { description: "Select the text and copy it manually." }),
				);
		} else {
			toast.error("Couldn't copy", { description: "Select the text and copy it manually." });
		}
	};
	const agentPrompt = buildShareAgentHandoffPrompt(link);
	return (
		<Alert>
			<CheckCircle2 />
			<AlertTitle>Copy this link now</AlertTitle>
			<AlertDescription>
				<p>Save it before closing this dialog.</p>
				<div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
					<Input
						readOnly
						value={link.url}
						name="fresh-share-link-url"
						aria-label="New invite link URL"
						autoComplete="off"
						spellCheck={false}
						className="min-w-0 font-mono text-xs"
					/>
					<Button
						variant="outline"
						size="sm"
						onClick={() => copyText(link.url, "Link copied")}
						className="sm:size-9 sm:px-0"
						aria-label="Copy invite link"
					>
						<Copy className="size-3.5" />
						<span className="sm:sr-only">Copy</span>
					</Button>
					<Button variant="ghost" size="sm" onClick={onDismiss}>
						Done
					</Button>
				</div>
				<details className="mt-2 text-sm">
					<summary className="cursor-pointer">Send to an Agent</summary>
					<Button
						variant="ghost"
						size="sm"
						className="mt-2"
						onClick={() => copyText(agentPrompt, "Agent prompt copied")}
						aria-label={`Copy agent handoff prompt for invite link ${link.prefix}`}
					>
						<Copy className="mr-1.5 size-3.5" />
						Copy prompt
					</Button>
				</details>
			</AlertDescription>
		</Alert>
	);
}

function isExpiredLink(link: ShareLinkRow) {
	return link.expires_at !== null && new Date(link.expires_at).getTime() <= Date.now();
}

function LinkRow({
	link,
	onRevoke,
	revoking,
}: {
	link: ShareLinkRow;
	onRevoke?: () => void;
	revoking: boolean;
}) {
	const revoked = link.revoked_at !== null;
	const expired = isExpiredLink(link);
	return (
		<li className={`py-2 ${revoked || expired ? "text-muted-foreground" : ""}`}>
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 text-sm">
						<span className="truncate font-medium">{link.label ?? "Invite link"}</span>
						{revoked || expired ? (
							<Badge variant="secondary" className="text-xs">
								{revoked ? "Off" : "Expired"}
							</Badge>
						) : null}
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
						<span>
							Created{" "}
							{new Date(link.created_at).toLocaleDateString(undefined, {
								month: "short",
								day: "numeric",
							})}
						</span>
						<span aria-hidden>·</span>
						<span>
							{link.redeem_count} accept{link.redeem_count === 1 ? "" : "s"}
						</span>
					</div>
				</div>
				{!revoked && !expired ? (
					<Button
						variant="ghost"
						size="icon"
						disabled={revoking}
						title="Turn off link"
						aria-label={`Turn off invite link ${link.prefix}`}
						onClick={onRevoke}
					>
						<Trash2 className="size-3.5 text-destructive" />
					</Button>
				) : null}
			</div>
		</li>
	);
}

function InvitationsPanel({ projectId }: { projectId: string }) {
	const api = useApi();
	const qc = useQueryClient();
	const [email, setEmail] = useState("");
	const [cancelOpen, setCancelOpen] = useState(false);
	const [cancelTarget, setCancelTarget] = useState<Invitation | null>(null);
	const cancelSucceededRef = useRef(false);
	const cancelExit = useDialogExitLifecycle({
		open: cancelOpen,
		value: cancelTarget,
		emptyValue: null,
	});
	const renderedCancelTarget = cancelExit.renderedValue;

	const invites = useQuery({
		queryKey: ["invitations", projectId],
		queryFn: async (): Promise<Invitation[]> =>
			unwrap(
				await api.GET("/v1/projects/{project_id}/invitations", {
					params: { path: { project_id: projectId } },
				}),
			),
	});

	const invite = useMutation({
		mutationFn: async (inviteEmail: string) =>
			unwrap(
				await api.POST("/v1/projects/{project_id}/invitations", {
					params: { path: { project_id: projectId } },
					body: { email: inviteEmail },
				}),
			),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["invitations", projectId] });
			setEmail("");
			toast.success("Invitation sent", {
				description: "They can accept in Clawdi notifications.",
			});
		},
		onError: (e) => {
			toast.error("Couldn't send invitation", {
				description: normalizeApiError(e),
			});
		},
	});

	const cancel = useMutation({
		mutationFn: async (invitationId: string) => {
			await unwrap(
				await api.DELETE("/v1/projects/{project_id}/invitations/{invitation_id}", {
					params: { path: { project_id: projectId, invitation_id: invitationId } },
				}),
			);
		},
		onSuccess: () => {
			cancelSucceededRef.current = true;
			cancelExit.beginClose();
			setCancelOpen(false);
			toast.success("Invitation canceled");
		},
		onError: (e) => {
			toast.error("Couldn't cancel invitation", {
				description: normalizeApiError(e),
			});
		},
	});

	const looksLikeEmail = /^\S+@\S+\.\S+$/.test(email.trim());

	return (
		<div className="space-y-3">
			<form
				onSubmit={(e) => {
					e.preventDefault();
					if (!looksLikeEmail) return;
					invite.mutate(email.trim());
				}}
				className="flex gap-2"
			>
				<Input
					type="email"
					name="project-invite-email"
					placeholder="Enter email address"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					autoComplete="email"
					aria-label="Invitee email"
					spellCheck={false}
				/>
				<Button
					type="submit"
					size="sm"
					disabled={!looksLikeEmail || invite.isPending}
					aria-label="Invite email to project"
				>
					{invite.isPending ? "Sending…" : "Invite"}
				</Button>
			</form>

			{invites.isLoading ? (
				<Skeleton className="h-16 w-full" />
			) : shouldBlockQueryError(invites.error, invites.data) ? (
				<EmptyHint
					variant="destructive"
					message={
						invites.error instanceof ApiError && invites.error.status === 404
							? "Email invitations are unavailable for this Project."
							: normalizeApiError(invites.error)
					}
				/>
			) : (invites.data ?? []).length === 0 ? null : (
				<ul className="space-y-2">
					{invites.data?.map((inv) => (
						<li key={inv.id} className="flex items-center justify-between gap-2 py-1 text-sm">
							<div className="min-w-0">
								<div className="truncate font-medium" title={inv.invitee_email}>
									{inv.invitee_email}
								</div>
								<div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
									<Badge variant="outline">Pending</Badge>
								</div>
							</div>
							<Button
								variant="ghost"
								size="icon"
								disabled={cancel.isPending && cancel.variables === inv.id}
								title="Cancel invitation"
								aria-label={`Cancel invitation for ${inv.invitee_email}`}
								onClick={() => {
									cancelSucceededRef.current = false;
									setCancelTarget(inv);
									setCancelOpen(true);
								}}
							>
								<Trash2 className="size-3.5 text-destructive" />
							</Button>
						</li>
					))}
				</ul>
			)}
			<AlertDialog
				open={cancelOpen}
				onOpenChange={(nextOpen) => {
					if (!cancel.isPending) {
						if (nextOpen) cancelExit.beginOpen();
						else cancelExit.beginClose();
						setCancelOpen(nextOpen);
					}
				}}
				onOpenChangeComplete={(nextOpen) => {
					if (nextOpen) return;
					setCancelTarget(null);
					cancelExit.completeClose();
					if (cancelSucceededRef.current) {
						cancelSucceededRef.current = false;
						void qc.invalidateQueries({ queryKey: ["invitations", projectId] });
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Cancel this invitation?</AlertDialogTitle>
						<AlertDialogDescription>
							{renderedCancelTarget?.invitee_email ?? "This person"} will no longer see this
							invitation in their dashboard.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={cancel.isPending}>Keep invitation</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								event.preventDefault();
								if (renderedCancelTarget && !cancel.isPending)
									cancel.mutate(renderedCancelTarget.id);
							}}
							disabled={!renderedCancelTarget || cancel.isPending}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{cancel.isPending ? "Canceling…" : "Cancel invitation"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function MembersPanel({ projectId }: { projectId: string }) {
	const api = useApi();
	const qc = useQueryClient();
	const [removeOpen, setRemoveOpen] = useState(false);
	const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
	const removeSucceededRef = useRef(false);
	const removeExit = useDialogExitLifecycle({
		open: removeOpen,
		value: removeTarget,
		emptyValue: null,
	});
	const renderedRemoveTarget = removeExit.renderedValue;

	const members = useQuery({
		queryKey: ["project-members", projectId],
		queryFn: async (): Promise<Member[]> =>
			unwrap(
				await api.GET("/v1/projects/{project_id}/members", {
					params: { path: { project_id: projectId } },
				}),
			),
	});

	const refreshSharingState = () => {
		qc.invalidateQueries({ queryKey: ["project-members", projectId] });
		qc.invalidateQueries({ queryKey: ["share-links", projectId] });
		qc.invalidateQueries({ queryKey: ["invitations", projectId] });
		qc.invalidateQueries({ queryKey: ["skills"] });
		qc.invalidateQueries({ queryKey: ["get", "/v1/projects"] });
	};

	const remove = useMutation({
		mutationFn: async (userId: string) => {
			return unwrap(
				await api.DELETE("/v1/projects/{project_id}/members/{member_user_id}", {
					params: { path: { project_id: projectId, member_user_id: userId } },
				}),
			);
		},
		onSuccess: () => {
			removeSucceededRef.current = true;
			removeExit.beginClose();
			setRemoveOpen(false);
			toast.success("Member removed");
		},
		onError: (e) =>
			toast.error("Couldn't remove member", {
				description: normalizeApiError(e),
			}),
	});

	const rows = members.data ?? [];

	return (
		<div className="space-y-3">
			<h3 className="text-sm font-semibold">People with access</h3>
			{members.isLoading ? (
				<Skeleton className="h-16 w-full" />
			) : shouldBlockQueryError(members.error, members.data) ? (
				<EmptyHint variant="destructive" message={normalizeApiError(members.error)} />
			) : rows.length === 0 ? (
				<p className="text-sm text-muted-foreground">Only you have access</p>
			) : (
				<ul className="space-y-2">
					{rows.map((member) => {
						const label = member.user_email ?? member.user_display ?? member.user_id;
						return (
							<li key={member.id} className="flex items-center justify-between gap-2 py-1 text-sm">
								<div className="min-w-0">
									<div className="truncate font-medium">{label}</div>
									<div className="text-xs text-muted-foreground">
										{formatMembershipToken(member.role)}
									</div>
								</div>
								<Button
									variant="ghost"
									size="icon"
									disabled={remove.isPending}
									title="Remove member"
									aria-label={`Remove member ${label}`}
									onClick={() => {
										removeSucceededRef.current = false;
										setRemoveTarget(member);
										setRemoveOpen(true);
									}}
								>
									<UserMinus className="size-3.5 text-destructive" />
								</Button>
							</li>
						);
					})}
				</ul>
			)}

			<AlertDialog
				open={removeOpen}
				onOpenChange={(nextOpen) => {
					if (!remove.isPending) {
						if (nextOpen) removeExit.beginOpen();
						else removeExit.beginClose();
						setRemoveOpen(nextOpen);
					}
				}}
				onOpenChangeComplete={(nextOpen) => {
					if (nextOpen) return;
					setRemoveTarget(null);
					removeExit.completeClose();
					if (removeSucceededRef.current) {
						removeSucceededRef.current = false;
						refreshSharingState();
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Remove this member?</AlertDialogTitle>
						<AlertDialogDescription>
							{renderedRemoveTarget
								? (renderedRemoveTarget.user_email ??
									renderedRemoveTarget.user_display ??
									renderedRemoveTarget.user_id)
								: "This member"}{" "}
							will lose access to this Project.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								event.preventDefault();
								if (renderedRemoveTarget && !remove.isPending)
									remove.mutate(renderedRemoveTarget.user_id);
							}}
							disabled={!renderedRemoveTarget || remove.isPending}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{remove.isPending ? "Removing…" : "Remove member"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function StopSharingPanel({ projectId }: { projectId: string }) {
	const api = useApi();
	const qc = useQueryClient();
	const [stopAllOpen, setStopAllOpen] = useState(false);
	const unshare = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.POST("/v1/projects/{project_id}/unshare", {
					params: { path: { project_id: projectId } },
				}),
			),
		onSuccess: (body) => {
			setStopAllOpen(false);
			for (const queryKey of [
				["project-members", projectId],
				["share-links", projectId],
				["invitations", projectId],
				["skills"],
				["get", "/v1/projects"],
			])
				void qc.invalidateQueries({ queryKey });
			toast.success("Sharing stopped", {
				description: `Turned off ${body.links_revoked} link(s) and removed ${body.members_removed} member(s).`,
			});
		},
		onError: (e) =>
			toast.error("Couldn't stop sharing", {
				description: normalizeApiError(e),
			}),
	});

	return (
		<details className="text-sm">
			<summary className="cursor-pointer text-muted-foreground">Manage sharing</summary>
			<AlertDialog
				open={stopAllOpen}
				onOpenChange={(nextOpen) => {
					if (!unshare.isPending) setStopAllOpen(nextOpen);
				}}
			>
				<AlertDialogTrigger
					render={
						<Button
							variant="ghost"
							className="text-destructive"
							size="sm"
							disabled={unshare.isPending}
							aria-label="Stop all sharing for this Project"
						/>
					}
				>
					{unshare.isPending ? "Stopping…" : "Stop all sharing"}
				</AlertDialogTrigger>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Stop all sharing?</AlertDialogTitle>
						<AlertDialogDescription>
							All invite links and pending invitations will stop working. Members will lose access.
							Your Project content stays unchanged.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={unshare.isPending}>Keep sharing</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								event.preventDefault();
								if (!unshare.isPending) unshare.mutate();
							}}
							disabled={unshare.isPending}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							Stop all sharing
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</details>
	);
}

function EmptyHint({ message, variant }: { message: string; variant?: "default" | "destructive" }) {
	return (
		<Alert variant={variant}>
			<AlertCircle />
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}

function formatMembershipToken(value: string) {
	return value
		.split(/[_-]+/g)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}
