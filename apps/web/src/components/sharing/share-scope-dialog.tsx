"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Copy, Link2, Plus, Share2, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { ApiError, useApi } from "@/lib/api";
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

interface ShareLink {
	id: string;
	url: string;
	created_at: string;
	created_by_display: string;
	redeem_count: number;
	last_redeemed_at: string | null;
	resolved_owner_handle: string;
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
	const api = useApi();
	const qc = useQueryClient();
	const links = useQuery({
		queryKey: ["share-links", scopeId],
		queryFn: async (): Promise<ShareLink[]> => {
			// Untyped path until Phase B regen — openapi-fetch will complain
			// about the unknown path so we bypass for now.
			const token = await (
				api as unknown as {
					getToken?: () => Promise<string | null>;
				}
			).getToken?.();
			const r = await fetch(`${API_URL}/api/scopes/${scopeId}/share-links`, {
				headers: token ? { Authorization: `Bearer ${token}` } : undefined,
			});
			if (!r.ok) throw new ApiError(r.status, await r.text());
			const body = (await r.json()) as { items?: ShareLink[] };
			return body.items ?? [];
		},
	});

	const create = useMutation({
		mutationFn: async (): Promise<ShareLink> => {
			const r = await fetch(`${API_URL}/api/scopes/${scopeId}/share-links`, {
				method: "POST",
			});
			if (!r.ok) throw new ApiError(r.status, await r.text());
			return r.json();
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["share-links", scopeId] });
			toast.success("New share link created");
		},
		onError: (e) => {
			toast.error(e instanceof Error ? e.message : "Failed to create link");
		},
	});

	const revoke = useMutation({
		mutationFn: async (linkId: string) => {
			const r = await fetch(`${API_URL}/api/scopes/${scopeId}/share-links/${linkId}`, {
				method: "DELETE",
			});
			if (!r.ok) throw new ApiError(r.status, await r.text());
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["share-links", scopeId] });
			toast.success("Link revoked");
		},
		onError: (e) => {
			toast.error(e instanceof Error ? e.message : "Failed to revoke link");
		},
	});

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
			<Separator />
			{links.isLoading ? (
				<Skeleton className="h-16 w-full" />
			) : links.error ? (
				<EmptyHint
					message={
						links.error instanceof ApiError && links.error.status === 404
							? "Sharing isn't enabled for this scope yet. Backend Phase B endpoints land soon."
							: links.error instanceof Error
								? links.error.message
								: "Couldn't load links."
					}
				/>
			) : (links.data ?? []).length === 0 ? (
				<EmptyHint message="No share links yet. Generate one to start sharing this scope." />
			) : (
				<ul className="space-y-2">
					{links.data?.map((link) => (
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

function LinkRow({
	link,
	onRevoke,
	revoking,
}: {
	link: ShareLink;
	onRevoke: () => void;
	revoking: boolean;
}) {
	const copy = () => {
		if (typeof navigator !== "undefined" && navigator.clipboard) {
			navigator.clipboard
				.writeText(link.url)
				.then(() => toast.success("Link copied"))
				.catch(() => toast.error("Couldn't copy"));
		}
	};
	return (
		<li className="rounded-lg border p-3">
			<div className="flex items-center gap-2">
				<Input readOnly value={link.url} className="font-mono text-xs" />
				<Button variant="outline" size="icon" onClick={copy}>
					<Copy className="size-3.5" />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					onClick={onRevoke}
					disabled={revoking}
					title="Revoke link"
				>
					<Trash2 className="size-3.5 text-destructive" />
				</Button>
			</div>
			<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<span>
					Created{" "}
					{new Date(link.created_at).toLocaleDateString(undefined, {
						month: "short",
						day: "numeric",
					})}
				</span>
				<span aria-hidden>·</span>
				<Badge variant="secondary" className="font-mono">
					@{link.resolved_owner_handle}
				</Badge>
				<span aria-hidden>·</span>
				<span>
					{link.redeem_count} redeem{link.redeem_count === 1 ? "" : "s"}
				</span>
			</div>
		</li>
	);
}

function InvitationsPanel({ scopeId }: { scopeId: string }) {
	const qc = useQueryClient();
	const [email, setEmail] = useState("");

	const invites = useQuery({
		queryKey: ["invitations", scopeId],
		queryFn: async (): Promise<Invitation[]> => {
			const r = await fetch(`${API_URL}/api/scopes/${scopeId}/invitations`);
			if (!r.ok) throw new ApiError(r.status, await r.text());
			const body = (await r.json()) as { items?: Invitation[] };
			return body.items ?? [];
		},
	});

	const invite = useMutation({
		mutationFn: async (inviteEmail: string) => {
			const r = await fetch(`${API_URL}/api/scopes/${scopeId}/invitations`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: inviteEmail }),
			});
			if (!r.ok) throw new ApiError(r.status, await r.text());
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
			const r = await fetch(`${API_URL}/api/scopes/${scopeId}/invitations/${invitationId}`, {
				method: "DELETE",
			});
			if (!r.ok) throw new ApiError(r.status, await r.text());
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
