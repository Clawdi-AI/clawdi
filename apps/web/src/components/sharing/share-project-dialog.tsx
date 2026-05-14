"use client";

import { buildShareAgentHandoffPrompt } from "@clawdi/shared/sharing";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertCircle,
	CheckCircle2,
	Copy,
	Link2,
	Plus,
	Share2,
	Trash2,
	UserMinus,
	Users,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import { errorMessage } from "@/lib/utils";
import { formatApiError } from "./vault-conflicts";

/**
 * Owner-side project-sharing surface.
 *
 * Two surfaces in one dialog:
 *   - Links tab: list of share-links with redeem counts + revoke buttons,
 *     plus "Generate new link" CTA that POSTs and returns a fresh URL.
 *   - Invitations tab: email-based invitations (in-dashboard "you've been
 *     added" entries on the invitee's side, no public token).
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
	const isPersonalProject = projectKind === "personal";
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{children ?? (
					<Button variant="outline" size="sm" aria-label={`Share ${projectName}`}>
						<Share2 className="mr-2 size-4" />
						Share project
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Share "{projectName}"</DialogTitle>
					<DialogDescription>
						Give others read-only membership in this project. Accepting grants project access; agent
						binding remains a separate explicit step.
					</DialogDescription>
				</DialogHeader>
				{isPersonalProject ? (
					<Alert>
						<AlertCircle />
						<AlertTitle>Personal project sharing needs extra care</AlertTitle>
						<AlertDescription>
							Personal projects often mix experiments, one-off vault references, and default
							context. Prefer sharing a dedicated project boundary for cleaner collaboration.
						</AlertDescription>
					</Alert>
				) : null}
				<Tabs defaultValue="links" className="w-full">
					<TabsList className="grid w-full grid-cols-3">
						<TabsTrigger value="links" className="min-w-0 px-2">
							<Link2 className="mr-2 size-3.5" />
							<span className="truncate">Links</span>
						</TabsTrigger>
						<TabsTrigger value="invitations" className="min-w-0 px-2">
							<Users className="mr-2 size-3.5" />
							<span className="truncate">Invites</span>
						</TabsTrigger>
						<TabsTrigger value="members" className="min-w-0 px-2">
							<UserMinus className="mr-2 size-3.5" />
							<span className="truncate">Members</span>
						</TabsTrigger>
					</TabsList>
					<TabsContent value="links" className="mt-4">
						<ShareLinksPanel projectId={projectId} />
					</TabsContent>
					<TabsContent value="invitations" className="mt-4">
						<InvitationsPanel projectId={projectId} />
					</TabsContent>
					<TabsContent value="members" className="mt-4">
						<MembersPanel projectId={projectId} />
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}

function ShareLinksPanel({ projectId }: { projectId: string }) {
	const qc = useQueryClient();
	const [label, setLabel] = useState("");
	// The just-created link's full URL — surfaced once in a banner
	// because the server stores only the prefix going forward.
	// Cleared on next create or on dialog close (panel unmount).
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
			toast.success("Share link created — copy it now");
		},
		onError: (e) => {
			toast.error(
				e instanceof ApiError && e.status === 409
					? "Set a display name on your profile before sharing."
					: e instanceof Error
						? e.message
						: "Failed to create link",
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
			toast.success("Link revoked");
		},
		onError: (e) => {
			toast.error("Failed to revoke link", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	const visibleLinks = links.data ?? [];

	return (
		<div className="space-y-3">
			<form
				className="space-y-2 rounded-lg border p-3"
				onSubmit={(e) => {
					e.preventDefault();
					create.mutate(label);
				}}
			>
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					<Input
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						maxLength={200}
						placeholder="Link label, e.g. Bob onboarding"
						aria-label="Share link label"
						className="min-w-0 flex-1"
					/>
					<Button type="submit" size="sm" disabled={create.isPending}>
						<Plus className="mr-1.5 size-3.5" />
						{create.isPending ? "Creating…" : "Generate link"}
					</Button>
				</div>
				<p className="text-xs text-muted-foreground">
					Labels stay visible after the full URL is hidden, so you can tell links apart before
					revoking them.
				</p>
			</form>

			<div className="flex items-center justify-between gap-2">
				<p className="text-xs text-muted-foreground">
					Anyone with a share link can preview the project and accept it. Revoke anytime.
				</p>
				<Badge variant="secondary" className="text-xs">
					{visibleLinks.filter((link) => link.revoked_at === null).length} active
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
				<EmptyHint message="No share links yet. Generate one to start sharing this project." />
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
				.catch(() => toast.error("Couldn't copy — select the text and copy manually"));
		} else {
			toast.error("Couldn't copy — select the text and copy manually");
		}
	};
	const agentPrompt = buildShareAgentHandoffPrompt(link);
	return (
		<Alert>
			<CheckCircle2 />
			<AlertTitle>Link ready — save it now</AlertTitle>
			<AlertDescription>
				<p className="text-xs text-muted-foreground">
					This is the only time you'll see the full URL. After you close this dialog, only the
					prefix <span className="font-mono">{link.prefix}</span> stays visible — revoke if it
					leaks.
				</p>
				{link.label ? (
					<p className="mt-1 text-xs text-muted-foreground">
						Label: <span className="font-medium text-foreground">{link.label}</span>
					</p>
				) : null}
				<div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
					<Input readOnly value={link.url} className="min-w-0 font-mono text-xs" />
					<Button
						variant="outline"
						size="sm"
						onClick={() => copyText(link.url, "Link copied")}
						className="sm:size-9 sm:px-0"
						aria-label="Copy share link"
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
							<div className="text-xs font-medium">Agent setup prompt</div>
							<div className="truncate font-mono text-[11px] text-muted-foreground">
								clawdi.share.v1 · {link.prefix}
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => copyText(agentPrompt, "Agent prompt copied")}
							aria-label={`Copy agent setup prompt for share link ${link.prefix}`}
						>
							<Copy className="mr-1.5 size-3.5" />
							Copy prompt
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
							<span className="text-xs italic text-muted-foreground">no label</span>
						)}
						{revoked ? (
							<Badge variant="secondary" className="text-xs">
								Revoked
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
								title="Revoke link"
								aria-label={`Revoke share link ${link.prefix}`}
							>
								<Trash2 className="size-3.5 text-destructive" />
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Revoke this share link?</AlertDialogTitle>
								<AlertDialogDescription>
									Anyone who has not already joined through this link will lose access to it.
									Existing members stay connected until you remove them.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									onClick={onRevoke}
									className="bg-destructive text-white hover:bg-destructive/90"
								>
									Revoke link
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
			toast.success("Invitation sent");
		},
		onError: (e) => {
			toast.error("Failed to send invitation", {
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
			toast.success("Invitation cancelled");
		},
		onError: (e) => {
			toast.error("Failed to cancel invitation", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	const looksLikeEmail = /^\S+@\S+\.\S+$/.test(email);

	return (
		<div className="space-y-3">
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
					placeholder="email@example.com"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					autoComplete="email"
					aria-label="Invitee email"
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
				The recipient needs a Clawdi account; the invitation appears in their dashboard.
			</p>
			<Separator />
			{invites.isLoading ? (
				<Skeleton className="h-16 w-full" />
			) : invites.error ? (
				<EmptyHint
					variant="destructive"
					message={
						invites.error instanceof ApiError && invites.error.status === 404
							? "Email invitations are unavailable for this project."
							: invites.error instanceof ApiError
								? formatApiError(invites.error.detail)
								: errorMessage(invites.error)
					}
				/>
			) : (invites.data ?? []).length === 0 ? (
				<EmptyHint message="No invitations yet." />
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
									<Badge variant="outline">pending</Badge>
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
			toast.success("Member removed");
		},
		onError: (e) =>
			toast.error("Failed to remove member", {
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
			toast.success(
				`Stopped sharing — revoked ${body.links_revoked} link(s), removed ${body.members_removed} member(s)`,
			);
		},
		onError: (e) =>
			toast.error("Failed to stop sharing", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			}),
	});

	const rows = members.data ?? [];

	return (
		<div className="space-y-3">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<p className="text-xs text-muted-foreground sm:max-w-sm">
					Accepted viewers with permanent access to this project.
				</p>
				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button
							variant="destructive"
							size="sm"
							disabled={unshare.isPending}
							aria-label="Stop all sharing for this project"
						>
							{unshare.isPending ? "Stopping…" : "Stop all sharing"}
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Stop sharing this project?</AlertDialogTitle>
							<AlertDialogDescription>
								This revokes active links, cancels pending invitations, and removes accepted
								members.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Keep sharing</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => unshare.mutate()}
								className="bg-destructive text-white hover:bg-destructive/90"
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
				<EmptyHint message="No accepted members yet." />
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
										{member.role} · joined via {member.joined_via} ·{" "}
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
												{label} will lose access to this project.
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>Cancel</AlertDialogCancel>
											<AlertDialogAction
												onClick={() => remove.mutate(member.user_id)}
												className="bg-destructive text-white hover:bg-destructive/90"
											>
												Remove member
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
