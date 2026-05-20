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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, useAuthedFetch } from "@/lib/api";
import { formatApiError } from "@/lib/api-errors";
import { errorMessage } from "@/lib/utils";

/**
 * Owner-side project-sharing surface.
 *
 * Two surfaces in one dialog:
 *   - People tab: accepted members and owner-side removal.
 *   - Invitations tab: email-based invitations (in-dashboard "you've been
 *     added" entries on the invitee's side, no public token).
 *   - Links tab: share-links with redeem counts + turn-off buttons.
 *
 * Backend endpoints:
 *   GET    /api/projects/{project_id}/share-links
 *   POST   /api/projects/{project_id}/share-links
 *   DELETE /api/projects/{project_id}/share-links/{link_id}
 *   GET    /api/projects/{project_id}/invitations
 *   POST   /api/projects/{project_id}/invitations
 *   DELETE /api/projects/{project_id}/invitations/{invitation_id}
 *
 * Schemas swap to typed openapi-fetch once codex regenerates them.
 */

// List shape: prefix-only, raw_token is unrecoverable once create returned.
interface ShareLinkRow {
	id: string;
	prefix: string;
	label: string | null;
	created_at: string;
	expires_at: string | null;
	revoked_at: string | null;
	redeem_count: number;
	last_redeemed_at: string | null;
}

// Create-time shape: raw_token + url shown ONCE.
interface ShareLinkCreated {
	id: string;
	raw_token: string;
	url: string;
	prefix: string;
	owner_handle: string;
	label: string | null;
	created_at: string;
	expires_at: string | null;
}

interface Invitation {
	id: string;
	invitee_email: string;
	created_at: string;
}

interface Member {
	id: string;
	user_id: string;
	user_email: string | null;
	user_display: string | null;
	role: string;
	joined_via: string;
	joined_at: string;
}

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
			<DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{isShareableProject ? `Share ${projectName}` : "Only Projects You Create Can Be Shared"}
					</DialogTitle>
					<DialogDescription>
						{isShareableProject
							? "Share this Project without sharing ownership. People join as read-only Viewers; agent use is a separate choice they make later."
							: "Only Projects you create can be shared with people. Global Projects and Agent Projects are created automatically and cannot be shared."}
					</DialogDescription>
				</DialogHeader>
				{isShareableProject ? (
					<>
						<PermissionSummary />
						<ShareMethodGuide />
						<Tabs defaultValue="members" className="w-full">
							<TabsList className="grid w-full grid-cols-3">
								<TabsTrigger value="members" className="min-w-0 px-2">
									<Users className="mr-2 size-3.5" />
									<span className="truncate">People</span>
								</TabsTrigger>
								<TabsTrigger value="invitations" className="min-w-0 px-2">
									<MailPlus className="mr-2 size-3.5" />
									<span className="truncate">Invites</span>
								</TabsTrigger>
								<TabsTrigger value="links" className="min-w-0 px-2">
									<Link2 className="mr-2 size-3.5" />
									<span className="truncate">Links</span>
								</TabsTrigger>
							</TabsList>
							<TabsContent value="members" className="mt-4">
								<MembersPanel projectId={projectId} />
							</TabsContent>
							<TabsContent value="invitations" className="mt-4">
								<InvitationsPanel projectId={projectId} />
							</TabsContent>
							<TabsContent value="links" className="mt-4">
								<ShareLinksPanel projectId={projectId} />
							</TabsContent>
						</Tabs>
					</>
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

function PermissionSummary() {
	return (
		<div className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-xs sm:grid-cols-3">
			<div>
				<div className="font-medium text-foreground">Viewer Access</div>
				<p className="mt-1 text-muted-foreground">
					Invites and links add people as Viewers. They can read skills, see Vault names, and see
					key names, but never see key values.
				</p>
			</div>
			<div>
				<div className="font-medium text-foreground">Secret Values</div>
				<p className="mt-1 text-muted-foreground">
					Viewers never see key values. Secret values stay hidden and are only used when agents run.
				</p>
			</div>
			<div>
				<div className="font-medium text-foreground">Roles</div>
				<p className="mt-1 text-muted-foreground">
					Viewer reads only. Owner edits resources and sharing. Editor is not available for Project
					sharing yet.
				</p>
			</div>
		</div>
	);
}

function ShareMethodGuide() {
	return (
		<div className="grid gap-2 rounded-md border bg-background/60 p-3 text-xs sm:grid-cols-2">
			<div>
				<div className="font-medium text-foreground">Email Invite</div>
				<p className="mt-1 text-muted-foreground">
					Best when you know the email they use to sign in. They accept from the Notification Center
					bell in the top-right.
				</p>
			</div>
			<div>
				<div className="font-medium text-foreground">Share Link</div>
				<p className="mt-1 text-muted-foreground">
					Best when you want to paste a link in chat or the person may need to create an account
					first.
				</p>
			</div>
		</div>
	);
}

function ShareLinksPanel({ projectId }: { projectId: string }) {
	const qc = useQueryClient();
	const [label, setLabel] = useState("");
	// The just-created link's full URL is shown once because the server
	// stores only the prefix going forward.
	const [freshLink, setFreshLink] = useState<ShareLinkCreated | null>(null);

	const authedFetch = useAuthedFetch();

	const links = useQuery({
		queryKey: ["share-links", projectId],
		queryFn: async (): Promise<ShareLinkRow[]> => {
			const r = await authedFetch(`/api/projects/${projectId}/share-links`);
			return r.json();
		},
	});

	const create = useMutation({
		mutationFn: async (nextLabel: string): Promise<ShareLinkCreated> => {
			const trimmedLabel = nextLabel.trim();
			const r = await authedFetch(`/api/projects/${projectId}/share-links`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ label: trimmedLabel.length > 0 ? trimmedLabel : null }),
			});
			return r.json();
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
			toast.success("Share Link Created", {
				description: "Copy it before closing this dialog. You can turn it off later.",
			});
		},
		onError: (e) => {
			toast.error(
				e instanceof ApiError && e.status === 409
					? "Set a display name on your profile before sharing."
					: e instanceof Error
						? e.message
						: "Failed to Create Link",
			);
		},
	});

	const revoke = useMutation({
		mutationFn: async (linkId: string) => {
			await authedFetch(`/api/projects/${projectId}/share-links/${linkId}`, {
				method: "DELETE",
			});
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["share-links", projectId] });
			toast.success("Share Link Turned Off");
		},
		onError: (e) => {
			toast.error("Failed to Turn Off Link", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	const visibleLinks = links.data ?? [];

	return (
		<div className="space-y-3">
			<div className="space-y-1">
				<h3 className="text-sm font-semibold">Share Links</h3>
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
						{create.isPending ? "Creating…" : "Create Link"}
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
			<AlertTitle>Copy This Link Now</AlertTitle>
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
							<div className="truncate font-mono text-[11px] text-muted-foreground">
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
									className="bg-destructive text-white hover:bg-destructive/90"
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
	const qc = useQueryClient();
	const [email, setEmail] = useState("");

	const authedFetch = useAuthedFetch();

	const invites = useQuery({
		queryKey: ["invitations", projectId],
		queryFn: async (): Promise<Invitation[]> => {
			const r = await authedFetch(`/api/projects/${projectId}/invitations`);
			const body = (await r.json()) as { items?: Invitation[] } | Invitation[];
			return Array.isArray(body) ? body : (body.items ?? []);
		},
	});

	const invite = useMutation({
		mutationFn: async (inviteEmail: string) => {
			const r = await authedFetch(`/api/projects/${projectId}/invitations`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: inviteEmail }),
			});
			return r.json();
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["invitations", projectId] });
			setEmail("");
			toast.success("Invitation Sent", {
				description:
					"They will see it under the top-right Notification Center bell after signing in with that email.",
			});
		},
		onError: (e) => {
			toast.error("Failed to Send Invitation", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	const cancel = useMutation({
		mutationFn: async (invitationId: string) => {
			await authedFetch(`/api/projects/${projectId}/invitations/${invitationId}`, {
				method: "DELETE",
			});
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["invitations", projectId] });
			toast.success("Invitation Cancelled");
		},
		onError: (e) => {
			toast.error("Failed to Cancel Invitation", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	const looksLikeEmail = /^\S+@\S+\.\S+$/.test(email);

	return (
		<div className="space-y-3">
			<div className="space-y-1">
				<h3 className="text-sm font-semibold">Invite people</h3>
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
				Invitees join as Viewers with read-only access to skills and Vault key names. Secret values
				stay hidden. After signing in, they accept from the top-right Notification Center bell.
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
											className="bg-destructive text-white hover:bg-destructive/90"
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
	const qc = useQueryClient();
	const authedFetch = useAuthedFetch();

	const members = useQuery({
		queryKey: ["project-members", projectId],
		queryFn: async (): Promise<Member[]> => {
			const r = await authedFetch(`/api/projects/${projectId}/members`);
			return r.json();
		},
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
			const r = await authedFetch(`/api/projects/${projectId}/members/${userId}`, {
				method: "DELETE",
			});
			return r.json() as Promise<{ status: string }>;
		},
		onSuccess: () => {
			refreshSharingState();
			toast.success("Member Removed");
		},
		onError: (e) =>
			toast.error("Failed to Remove Member", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			}),
	});

	const unshare = useMutation({
		mutationFn: async () => {
			const r = await authedFetch(`/api/projects/${projectId}/unshare`, { method: "POST" });
			return r.json() as Promise<{
				links_revoked: number;
				members_removed: number;
				invitations_cancelled: number;
			}>;
		},
		onSuccess: (body) => {
			refreshSharingState();
			toast.success("Sharing Stopped", {
				description: `Turned off ${body.links_revoked} link(s) and removed ${body.members_removed} member(s).`,
			});
		},
		onError: (e) =>
			toast.error("Failed to Stop Sharing", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			}),
	});

	const rows = members.data ?? [];

	return (
		<div className="space-y-3">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div className="space-y-1">
					<h3 className="text-sm font-semibold">People with access</h3>
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
							aria-label="Stop All Sharing for this Project"
						>
							{unshare.isPending ? "Stopping…" : "Stop All Sharing"}
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
								className="bg-destructive text-white hover:bg-destructive/90"
							>
								Stop All Sharing
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
												className="bg-destructive text-white hover:bg-destructive/90"
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
