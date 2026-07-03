"use client";

import { buildShareAgentHandoffPrompt } from "@clawdi/shared/sharing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertCircle,
	CheckCircle2,
	Copy,
	Link2,
	MailPlus,
	Plus,
	Share2,
	Trash2,
	UserMinus,
	Users,
} from "lucide-react";
import { useState } from "react";
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
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, unwrap, useApi } from "@/lib/api";
import { formatApiError } from "@/lib/api-errors";
import type { components } from "@/lib/api-schemas";
import { errorMessage } from "@/lib/utils";

/**
 * Owner-side project-sharing surface.
 *
 * One stacked surface (no tabs): invite by email, current people, and the
 * share link — in reading order, with a single line explaining what a
 * viewer can do.
 *
 * Backend endpoints:
 *   GET    /api/projects/{project_id}/share-links
 *   POST   /api/projects/{project_id}/share-links
 *   DELETE /api/projects/{project_id}/share-links/{link_id}
 *   GET    /api/projects/{project_id}/invitations
 *   POST   /api/projects/{project_id}/invitations
 *   DELETE /api/projects/{project_id}/invitations/{invitation_id}
 *
 */

type ShareLinkRow = components["schemas"]["ShareLinkResponse"];
type ShareLinkCreated = components["schemas"]["ShareLinkCreated"];
type Invitation = components["schemas"]["InvitationResponse"];
type Member = components["schemas"]["MemberResponse"];

interface ShareProjectDialogProps {
	projectId: string;
	projectName: string;
	projectKind?: string;
	children?: React.ReactNode;
}

export function ShareProjectDialog({
	projectId,
	projectName,
	projectKind,
	children,
}: ShareProjectDialogProps) {
	const [open, setOpen] = useState(false);
	const isShareableProject = isCustomProject({ kind: projectKind });
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{children ?? (
					<Button variant="outline" size="sm" aria-label={`Share ${projectName}`}>
						<Share2 className="mr-2 size-4" />
						Share Project
					</Button>
				)}
			</DialogTrigger>
			{/* `sm:` prefix is load-bearing: the primitive's base classes include
			    `sm:max-w-lg`, so an unprefixed `max-w-2xl` loses at sm+ and the
			    content gets clipped at 512px wide. */}
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{isShareableProject ? `Share ${projectName}` : "Only Projects you create can be shared"}
					</DialogTitle>
					<DialogDescription>
						{isShareableProject
							? "Share this Project without sharing ownership. People join as Viewers with read access; agent use is a separate choice they make later."
							: "Only Projects you create can be shared with people. Global Projects and Agent Projects are created automatically and cannot be shared."}
					</DialogDescription>
				</DialogHeader>
				{isShareableProject ? (
					<div className="space-y-5">
						{/* One surface, no tabs (journey J4): invite people, see who's
						    in, manage the link — top to bottom. */}
						<section className="space-y-3">
							<h3 className="flex items-center gap-1.5 text-sm font-semibold">
								<MailPlus className="size-3.5 text-muted-foreground" />
								Invite by email
							</h3>
							<InvitationsPanel projectId={projectId} />
						</section>
						<section className="space-y-3 border-t pt-4">
							<h3 className="flex items-center gap-1.5 text-sm font-semibold">
								<Users className="size-3.5 text-muted-foreground" />
								People
							</h3>
							<MembersPanel projectId={projectId} />
						</section>
						<section className="space-y-3 border-t pt-4">
							<h3 className="flex items-center gap-1.5 text-sm font-semibold">
								<Link2 className="size-3.5 text-muted-foreground" />
								Share link
							</h3>
							<ShareLinksPanel projectId={projectId} />
						</section>
						<p className="border-t pt-3 text-xs text-muted-foreground">
							Everyone joins as a viewer: they read skills and key names here, and their agents can
							use key values through the CLI. The dashboard never reveals values, and only you can
							edit anything.
						</p>
					</div>
				) : (
					<Alert>
						<AlertCircle />
						<AlertTitle>Managed Projects are not shareable</AlertTitle>
						<AlertDescription>
							Only Projects you create can have members, invitations, and share links.
						</AlertDescription>
					</Alert>
				)}
			</DialogContent>
		</Dialog>
	);
}

function ShareLinksPanel({ projectId }: { projectId: string }) {
	const api = useApi();
	const qc = useQueryClient();
	const [label, setLabel] = useState("");
	// The just-created link's full URL is shown once because the server
	// stores only the prefix going forward.
	const [freshLink, setFreshLink] = useState<ShareLinkCreated | null>(null);

	const links = useQuery({
		queryKey: ["share-links", projectId],
		queryFn: async (): Promise<ShareLinkRow[]> =>
			unwrap(
				await api.GET("/v1/projects/{project_id}/share-links", {
					params: { path: { project_id: projectId } },
				}),
			),
	});

	const create = useMutation({
		mutationFn: async (nextLabel: string): Promise<ShareLinkCreated> => {
			const trimmedLabel = nextLabel.trim();
			return unwrap(
				await api.POST("/v1/projects/{project_id}/share-links", {
					params: { path: { project_id: projectId } },
					body: { label: trimmedLabel.length > 0 ? trimmedLabel : null },
				}),
			);
		},
		onSuccess: (body) => {
			setLabel("");
			setFreshLink(body);
			qc.invalidateQueries({ queryKey: ["share-links", projectId] });
			// Best-effort auto-copy. Browsers without the async
			// clipboard API silently fall through to the manual copy
			// button in the banner.
			if (typeof navigator !== "undefined" && navigator.clipboard) {
				navigator.clipboard.writeText(body.url).catch(() => {});
			}
			toast.success("Share link created", {
				description: "Copy it before closing this dialog. You can turn it off later.",
			});
		},
		onError: (e) => {
			toast.error(
				e instanceof ApiError && e.status === 409
					? "Set a display name on your profile before sharing."
					: e instanceof Error
						? e.message
						: "Couldn't create link",
			);
		},
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
			qc.invalidateQueries({ queryKey: ["share-links", projectId] });
			toast.success("Share Link Turned Off");
		},
		onError: (e) => {
			toast.error("Couldn't turn off link", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	const visibleLinks = links.data ?? [];

	return (
		<div className="space-y-3">
			<div className="space-y-1">
				<p className="text-xs text-muted-foreground">
					Create a link when you want to send access yourself, or when the person may not have a
					Clawdi account yet.
				</p>
			</div>
			<form
				className="space-y-2 rounded-lg border p-3"
				onSubmit={(e) => {
					e.preventDefault();
					create.mutate(label);
				}}
			>
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					<Input
						name="share-link-label"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						maxLength={200}
						placeholder="Bob onboarding…"
						aria-label="Share link label"
						autoComplete="off"
						className="min-w-0 flex-1"
						spellCheck={false}
					/>
					<Button type="submit" size="sm" disabled={create.isPending}>
						<Plus className="mr-1.5 size-3.5" />
						{create.isPending ? "Creating…" : "Create link"}
					</Button>
				</div>
				<p className="text-xs text-muted-foreground">
					The full URL is shown once after creation. Labels stay visible so you can recognize links
					before turning them off.
				</p>
			</form>

			<div className="flex items-center justify-between gap-2">
				<p className="text-xs text-muted-foreground">
					Anyone with an active link can preview this Project and join as a read-only Viewer. Turn
					off a link anytime to stop new accepts.
				</p>
				<Badge variant="secondary" className="text-xs">
					{visibleLinks.filter((link) => link.revoked_at === null).length} Active
				</Badge>
			</div>

			{freshLink ? <FreshLinkBanner link={freshLink} onDismiss={() => setFreshLink(null)} /> : null}

			<Separator />

			{links.isLoading ? (
				<Skeleton className="h-16 w-full" />
			) : links.error ? (
				<EmptyHint
					variant="destructive"
					message={
						links.error instanceof ApiError
							? formatApiError(links.error.detail)
							: errorMessage(links.error)
					}
				/>
			) : visibleLinks.length === 0 ? (
				<EmptyHint message="No share links yet. Create one when you need a lightweight invite." />
			) : (
				<ul className="space-y-2">
					{visibleLinks.map((link) => (
						<LinkRow
							key={link.id}
							link={link}
							onRevoke={() => revoke.mutate(link.id)}
							revoking={revoke.isPending && revoke.variables === link.id}
						/>
					))}
				</ul>
			)}
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
					toast.error("Couldn't Copy", { description: "Select the text and copy it manually." }),
				);
		} else {
			toast.error("Couldn't Copy", { description: "Select the text and copy it manually." });
		}
	};
	const agentPrompt = buildShareAgentHandoffPrompt(link);
	return (
		<Alert>
			<CheckCircle2 />
			<AlertTitle>Copy this link now</AlertTitle>
			<AlertDescription>
				<p className="text-xs text-muted-foreground">
					Send this URL to the person you want to invite. They sign in or create an account, accept
					as a read-only Viewer, then open the Project from their dashboard.
				</p>
				<p className="mt-1 text-xs text-muted-foreground">
					This is the only time the full URL is visible here. After this, only the prefix{" "}
					<span className="font-mono">{link.prefix}</span> remains available.
				</p>
				{link.label ? (
					<p className="mt-1 text-xs text-muted-foreground">
						Label: <span className="font-medium text-foreground">{link.label}</span>
					</p>
				) : null}
				<div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
					<Input
						readOnly
						value={link.url}
						name="fresh-share-link-url"
						aria-label="New share link URL"
						autoComplete="off"
						spellCheck={false}
						className="min-w-0 font-mono text-xs"
					/>
					<Button
						variant="outline"
						size="sm"
						onClick={() => copyText(link.url, "Link Copied")}
						className="sm:size-9 sm:px-0"
						aria-label="Copy Share Link"
					>
						<Copy className="size-3.5" />
						<span className="sm:sr-only">Copy</span>
					</Button>
					<Button variant="ghost" size="sm" onClick={onDismiss}>
						Done
					</Button>
				</div>
				<div className="mt-2 rounded-md border bg-background/60 p-2">
					<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
						<div className="min-w-0">
							<div className="text-xs font-medium">Agent Handoff Prompt</div>
							<div className="truncate font-mono text-2xs text-muted-foreground">
								Viewer access · add to an agent later · {link.prefix}
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => copyText(agentPrompt, "Agent Prompt Copied")}
							aria-label={`Copy agent handoff prompt for share link ${link.prefix}`}
						>
							<Copy className="mr-1.5 size-3.5" />
							Copy Prompt
						</Button>
					</div>
				</div>
			</AlertDescription>
		</Alert>
	);
}

function LinkRow({
	link,
	onRevoke,
	revoking,
}: {
	link: ShareLinkRow;
	onRevoke: () => void;
	revoking: boolean;
}) {
	const revoked = link.revoked_at !== null;
	return (
		<li className={`rounded-lg border p-3 ${revoked ? "bg-muted/30 text-muted-foreground" : ""}`}>
			<div className="flex items-center justify-between gap-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 text-sm">
						<Badge variant="outline" className="font-mono">
							{link.prefix}…
						</Badge>
						{link.label ? (
							<span className="truncate font-medium">{link.label}</span>
						) : (
							<span className="text-xs italic text-muted-foreground">No Label</span>
						)}
						{revoked ? (
							<Badge variant="secondary" className="text-xs">
								Off
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
						{link.last_redeemed_at ? (
							<>
								<span aria-hidden>·</span>
								<span>
									Last used{" "}
									{new Date(link.last_redeemed_at).toLocaleDateString(undefined, {
										month: "short",
										day: "numeric",
									})}
								</span>
							</>
						) : null}
					</div>
				</div>
				{!revoked ? (
					<AlertDialog>
						<AlertDialogTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								disabled={revoking}
								title="Turn off link"
								aria-label={`Turn off share link ${link.prefix}`}
							>
								<Trash2 className="size-3.5 text-destructive" />
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Turn off this share link?</AlertDialogTitle>
								<AlertDialogDescription>
									Anyone who has not already joined through this link will lose access to it.
									Existing Viewers stay connected until you remove them from People.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									onClick={onRevoke}
									className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
								>
									Turn Off Link
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				) : null}
			</div>
		</li>
	);
}

function InvitationsPanel({ projectId }: { projectId: string }) {
	const api = useApi();
	const qc = useQueryClient();
	const [email, setEmail] = useState("");

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
			toast.success("Invitation Sent", {
				description:
					"They will see it under the top-right Notification Center bell after signing in with that email.",
			});
		},
		onError: (e) => {
			toast.error("Couldn't send invitation", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
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
			qc.invalidateQueries({ queryKey: ["invitations", projectId] });
			toast.success("Invitation Cancelled");
		},
		onError: (e) => {
			toast.error("Couldn't cancel invitation", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	const looksLikeEmail = /^\S+@\S+\.\S+$/.test(email);

	return (
		<div className="space-y-3">
			<div className="space-y-1">
				<p className="text-xs text-muted-foreground">
					Use email when the person already signs in with this address. If they may be new to
					Clawdi, create a share link instead.
				</p>
			</div>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					if (!looksLikeEmail) return;
					invite.mutate(email);
				}}
				className="flex flex-col gap-2 sm:flex-row"
			>
				<Input
					type="email"
					name="project-invite-email"
					placeholder="email@example.com…"
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
			<p className="text-xs text-muted-foreground">
				Invitees join as Viewers with read access to skills and Vault values through CLI runtime
				reads. After signing in, they accept from the top-right Notification Center bell.
			</p>
			<Separator />
			{invites.isLoading ? (
				<Skeleton className="h-16 w-full" />
			) : invites.error ? (
				<EmptyHint
					variant="destructive"
					message={
						invites.error instanceof ApiError && invites.error.status === 404
							? "Email invitations are unavailable for this Project."
							: invites.error instanceof ApiError
								? formatApiError(invites.error.detail)
								: errorMessage(invites.error)
					}
				/>
			) : (invites.data ?? []).length === 0 ? (
				<EmptyHint message="No pending invites." />
			) : (
				<ul className="space-y-2">
					{invites.data?.map((inv) => (
						<li
							key={inv.id}
							className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
						>
							<div className="min-w-0">
								<div className="truncate font-medium">{inv.invitee_email}</div>
								<div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
									<Badge variant="outline">Pending</Badge>
									<span aria-hidden>·</span>
									<span>
										Sent{" "}
										{new Date(inv.created_at).toLocaleDateString(undefined, {
											month: "short",
											day: "numeric",
										})}
									</span>
								</div>
							</div>
							<AlertDialog>
								<AlertDialogTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										disabled={cancel.isPending && cancel.variables === inv.id}
										title="Cancel invitation"
										aria-label={`Cancel invitation for ${inv.invitee_email}`}
									>
										<Trash2 className="size-3.5 text-destructive" />
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>Cancel this invitation?</AlertDialogTitle>
										<AlertDialogDescription>
											{inv.invitee_email} will no longer see this invitation in their dashboard.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>Keep invitation</AlertDialogCancel>
										<AlertDialogAction
											onClick={() => cancel.mutate(inv.id)}
											className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
										>
											Cancel invitation
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function MembersPanel({ projectId }: { projectId: string }) {
	const api = useApi();
	const qc = useQueryClient();

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
		qc.invalidateQueries({ queryKey: ["projects"] });
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
			refreshSharingState();
			toast.success("Member Removed");
		},
		onError: (e) =>
			toast.error("Couldn't remove member", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			}),
	});

	const unshare = useMutation({
		mutationFn: async () =>
			unwrap(
				await api.POST("/v1/projects/{project_id}/unshare", {
					params: { path: { project_id: projectId } },
				}),
			),
		onSuccess: (body) => {
			refreshSharingState();
			toast.success("Sharing Stopped", {
				description: `Turned off ${body.links_revoked} link(s) and removed ${body.members_removed} member(s).`,
			});
		},
		onError: (e) =>
			toast.error("Couldn't stop sharing", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			}),
	});

	const rows = members.data ?? [];

	return (
		<div className="space-y-3">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div className="space-y-1">
					<p className="text-xs text-muted-foreground sm:max-w-sm">
						People who accepted access. Viewers can read this Project until you remove them.
					</p>
				</div>
				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button
							variant="destructive"
							size="sm"
							disabled={unshare.isPending}
							aria-label="Stop all sharing for this Project"
						>
							{unshare.isPending ? "Stopping…" : "Stop all sharing"}
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Stop Sharing This Project?</AlertDialogTitle>
							<AlertDialogDescription>
								This turns off active links, cancels pending invitations, and removes accepted
								Viewers. Project content remains yours.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Keep Sharing</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => unshare.mutate()}
								className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
							>
								Stop all sharing
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>
			<Separator />
			{members.isLoading ? (
				<Skeleton className="h-16 w-full" />
			) : members.error ? (
				<EmptyHint
					variant="destructive"
					message={
						members.error instanceof ApiError
							? formatApiError(members.error.detail)
							: errorMessage(members.error)
					}
				/>
			) : rows.length === 0 ? (
				<EmptyHint message="No accepted Viewers yet. Invite someone or create a link." />
			) : (
				<ul className="space-y-2">
					{rows.map((member) => {
						const label = member.user_email ?? member.user_display ?? member.user_id;
						return (
							<li
								key={member.id}
								className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm"
							>
								<div className="min-w-0">
									<div className="truncate font-medium">{label}</div>
									<div className="text-xs text-muted-foreground">
										{formatMembershipToken(member.role)} · Joined via{" "}
										{formatMembershipToken(member.joined_via)} ·{" "}
										{new Date(member.joined_at).toLocaleDateString(undefined, {
											month: "short",
											day: "numeric",
										})}
									</div>
								</div>
								<AlertDialog>
									<AlertDialogTrigger asChild>
										<Button
											variant="ghost"
											size="icon"
											disabled={remove.isPending}
											title="Remove member"
											aria-label={`Remove member ${label}`}
										>
											<UserMinus className="size-3.5 text-destructive" />
										</Button>
									</AlertDialogTrigger>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>Remove this member?</AlertDialogTitle>
											<AlertDialogDescription>
												{label} will lose access to this Project.
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>Cancel</AlertDialogCancel>
											<AlertDialogAction
												onClick={() => remove.mutate(member.user_id)}
												className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
											>
												Remove Member
											</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
							</li>
						);
					})}
				</ul>
			)}
		</div>
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
