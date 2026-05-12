"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Copy, Link2, Plus, Share2, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { ApiError } from "@/lib/api";
import { env } from "@/lib/env";

/**
 * Owner-side scope-sharing surface (Spec §6 / Plan Phase F).
 *
 * Two surfaces in one dialog:
 *   - Links tab: list of share-links with redeem counts + revoke buttons,
 *     plus "Generate new link" CTA that POSTs and returns a fresh URL.
 *   - Invitations tab: email-based invitations (in-dashboard "you've been
 *     added" entries on the invitee's side, no public token).
 *
 * Backend endpoints land in Phase B:
 *   GET    /api/scopes/{scope_id}/share-links
 *   POST   /api/scopes/{scope_id}/share-links
 *   DELETE /api/scopes/{scope_id}/share-links/{link_id}
 *   GET    /api/scopes/{scope_id}/invitations
 *   POST   /api/scopes/{scope_id}/invitations
 *   DELETE /api/scopes/{scope_id}/invitations/{invitation_id}
 *
 * Until those land the dialog renders empty + actions error gracefully.
 * Schemas swap to typed openapi-fetch once codex regenerates them.
 */

// List shape (Phase B.3): prefix-only, raw_token is unrecoverable
// once create returned.
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

// Create-time shape (Phase B.2): raw_token + url shown ONCE.
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
	invitee_display: string | null;
	status: "pending" | "accepted" | "declined" | "cancelled";
	created_at: string;
}

interface ShareScopeDialogProps {
	scopeId: string;
	scopeName: string;
	children?: React.ReactNode;
}

const API_URL = env.NEXT_PUBLIC_API_URL;

export function ShareScopeDialog({ scopeId, scopeName, children }: ShareScopeDialogProps) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{children ?? (
					<Button variant="outline" size="sm">
						<Share2 className="mr-2 size-4" />
						Share scope
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>Share "{scopeName}"</DialogTitle>
					<DialogDescription>
						Give others read-only access to the skills and vault secrets in this scope. Sharees join
						as viewers — they can't edit your scope.
					</DialogDescription>
				</DialogHeader>
				<Tabs defaultValue="links" className="w-full">
					<TabsList className="grid w-full grid-cols-2">
						<TabsTrigger value="links">
							<Link2 className="mr-2 size-3.5" />
							Share links
						</TabsTrigger>
						<TabsTrigger value="invitations">
							<Users className="mr-2 size-3.5" />
							Invite by email
						</TabsTrigger>
					</TabsList>
					<TabsContent value="links" className="mt-4">
						<ShareLinksPanel scopeId={scopeId} />
					</TabsContent>
					<TabsContent value="invitations" className="mt-4">
						<InvitationsPanel scopeId={scopeId} />
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}

function ShareLinksPanel({ scopeId }: { scopeId: string }) {
	const { getToken } = useAuth();
	const qc = useQueryClient();
	// The just-created link's full URL — surfaced once in a banner
	// because the server stores only the prefix going forward.
	// Cleared on next create or on dialog close (panel unmount).
	const [freshLink, setFreshLink] = useState<ShareLinkCreated | null>(null);

	const authedFetch = async (path: string, init?: RequestInit) => {
		const token = await getToken();
		const headers = new Headers(init?.headers);
		if (token) headers.set("Authorization", `Bearer ${token}`);
		const r = await fetch(`${API_URL}${path}`, { ...init, headers });
		if (!r.ok) throw new ApiError(r.status, await r.text());
		return r;
	};

	const links = useQuery({
		queryKey: ["share-links", scopeId],
		queryFn: async (): Promise<ShareLinkRow[]> => {
			const r = await authedFetch(`/api/scopes/${scopeId}/share-links`);
			return r.json();
		},
	});

	const create = useMutation({
		mutationFn: async (): Promise<ShareLinkCreated> => {
			const r = await authedFetch(`/api/scopes/${scopeId}/share-links`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			return r.json();
		},
		onSuccess: (body) => {
			setFreshLink(body);
			qc.invalidateQueries({ queryKey: ["share-links", scopeId] });
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
			await authedFetch(`/api/scopes/${scopeId}/share-links/${linkId}`, {
				method: "DELETE",
			});
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["share-links", scopeId] });
			toast.success("Link revoked");
		},
		onError: (e) => {
			toast.error(e instanceof Error ? e.message : "Failed to revoke link");
		},
	});

	const visibleLinks = links.data ?? [];

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<p className="text-xs text-muted-foreground">
					Anyone with a share link can preview the scope and accept it. Revoke anytime.
				</p>
				<Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>
					<Plus className="mr-1.5 size-3.5" />
					{create.isPending ? "Creating…" : "Generate link"}
				</Button>
			</div>

			{freshLink ? <FreshLinkBanner link={freshLink} onDismiss={() => setFreshLink(null)} /> : null}

			<Separator />

			{links.isLoading ? (
				<Skeleton className="h-16 w-full" />
			) : links.error ? (
				<EmptyHint
					message={links.error instanceof Error ? links.error.message : "Couldn't load links."}
				/>
			) : visibleLinks.length === 0 ? (
				<EmptyHint message="No share links yet. Generate one to start sharing this scope." />
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
	const copy = () => {
		if (typeof navigator !== "undefined" && navigator.clipboard) {
			navigator.clipboard
				.writeText(link.url)
				.then(() => toast.success("Link copied"))
				.catch(() => toast.error("Couldn't copy — select the URL and copy manually"));
		}
	};
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
				<div className="mt-2 flex items-center gap-2">
					<Input readOnly value={link.url} className="font-mono text-xs" />
					<Button variant="outline" size="icon" onClick={copy}>
						<Copy className="size-3.5" />
					</Button>
					<Button variant="ghost" size="sm" onClick={onDismiss}>
						Done
					</Button>
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
							{link.redeem_count} redeem{link.redeem_count === 1 ? "" : "s"}
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
					<Button
						variant="ghost"
						size="icon"
						onClick={onRevoke}
						disabled={revoking}
						title="Revoke link"
					>
						<Trash2 className="size-3.5 text-destructive" />
					</Button>
				) : null}
			</div>
		</li>
	);
}

function InvitationsPanel({ scopeId }: { scopeId: string }) {
	const { getToken } = useAuth();
	const qc = useQueryClient();
	const [email, setEmail] = useState("");

	const authedFetch = async (path: string, init?: RequestInit) => {
		const token = await getToken();
		const headers = new Headers(init?.headers);
		if (token) headers.set("Authorization", `Bearer ${token}`);
		const r = await fetch(`${API_URL}${path}`, { ...init, headers });
		if (!r.ok) throw new ApiError(r.status, await r.text());
		return r;
	};

	const invites = useQuery({
		queryKey: ["invitations", scopeId],
		queryFn: async (): Promise<Invitation[]> => {
			const r = await authedFetch(`/api/scopes/${scopeId}/invitations`);
			const body = (await r.json()) as { items?: Invitation[] } | Invitation[];
			return Array.isArray(body) ? body : (body.items ?? []);
		},
	});

	const invite = useMutation({
		mutationFn: async (inviteEmail: string) => {
			const r = await authedFetch(`/api/scopes/${scopeId}/invitations`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: inviteEmail }),
			});
			return r.json();
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["invitations", scopeId] });
			setEmail("");
			toast.success("Invitation sent");
		},
		onError: (e) => {
			toast.error(e instanceof Error ? e.message : "Failed to send invitation");
		},
	});

	const cancel = useMutation({
		mutationFn: async (invitationId: string) => {
			await authedFetch(`/api/scopes/${scopeId}/invitations/${invitationId}`, {
				method: "DELETE",
			});
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["invitations", scopeId] });
			toast.success("Invitation cancelled");
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
				className="flex gap-2"
			>
				<Input
					type="email"
					placeholder="email@example.com"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					autoComplete="email"
				/>
				<Button type="submit" size="sm" disabled={!looksLikeEmail || invite.isPending}>
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
					message={
						invites.error instanceof ApiError && invites.error.status === 404
							? "Email invitations aren't enabled yet. Backend Phase B endpoints land soon."
							: invites.error instanceof Error
								? invites.error.message
								: "Couldn't load invitations."
					}
				/>
			) : (invites.data ?? []).length === 0 ? (
				<EmptyHint message="No invitations yet." />
			) : (
				<ul className="space-y-2">
					{invites.data?.map((inv) => (
						<li
							key={inv.id}
							className="flex items-center justify-between rounded-md border p-2 text-sm"
						>
							<div>
								<div className="font-medium">{inv.invitee_email}</div>
								<div className="text-xs text-muted-foreground">
									<Badge variant={inv.status === "pending" ? "outline" : "secondary"}>
										{inv.status}
									</Badge>
								</div>
							</div>
							{inv.status === "pending" ? (
								<Button
									variant="ghost"
									size="icon"
									onClick={() => cancel.mutate(inv.id)}
									title="Cancel invitation"
								>
									<Trash2 className="size-3.5 text-destructive" />
								</Button>
							) : null}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function EmptyHint({ message }: { message: string }) {
	return (
		<Alert>
			<AlertCircle />
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}
