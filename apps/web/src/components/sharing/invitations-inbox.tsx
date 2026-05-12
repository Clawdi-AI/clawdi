"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Mail, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ApiError } from "@/lib/api";
import { env } from "@/lib/env";

/**
 * Invitee-side inbox surface: GET /api/me/invitations + accept/decline.
 *
 * Rendered as a top-of-page banner on /skills when the current user
 * has pending invitations. Self-hiding on empty inbox so it doesn't
 * occupy space when there's nothing to act on.
 *
 * Accept → POST /api/me/invitations/{id}/accept → ScopeMembership
 * created → react-query invalidates skill listings so shared
 * skills appear in the table below without a manual refresh.
 *
 * Decline → POST /api/me/invitations/{id}/decline → pending row
 * deleted.
 */

interface Invitation {
	id: string;
	scope_id: string;
	scope_name: string;
	scope_kind: string;
	owner_display: string;
	owner_handle: string;
	invitee_email: string;
	invited_by_user_id: string;
	invited_by_display: string | null;
	created_at: string;
}

const API_URL = env.NEXT_PUBLIC_API_URL;

export function InvitationsInbox() {
	const { getToken } = useAuth();
	const qc = useQueryClient();

	const authedFetch = async (path: string, init?: RequestInit) => {
		const token = await getToken();
		const headers = new Headers(init?.headers);
		if (token) headers.set("Authorization", `Bearer ${token}`);
		const r = await fetch(`${API_URL}${path}`, { ...init, headers });
		if (!r.ok) throw new ApiError(r.status, await r.text());
		return r;
	};

	// Refresh every cache that derives from membership state so the
	// banner row disappears and skill / scope listings pick up the
	// new mount immediately. Reused by both the normal-accept success
	// path AND the 409 mount_target_ambiguous path (which still
	// commits membership — the mount is just deferred).
	const refetchMembershipDerived = () => {
		qc.invalidateQueries({ queryKey: ["me-invitations"] });
		qc.invalidateQueries({ queryKey: ["skills"] });
		qc.invalidateQueries({ queryKey: ["scopes"] });
		qc.invalidateQueries({ queryKey: ["scope-mounts"] });
	};

	const invitations = useQuery({
		queryKey: ["me-invitations"],
		queryFn: async (): Promise<Invitation[]> => {
			const r = await authedFetch("/api/me/invitations");
			return r.json();
		},
		// Invitations are a low-traffic surface; poll on focus rather
		// than on a fixed interval so an owner-invite that lands
		// mid-session surfaces when the user comes back to the tab.
		refetchOnWindowFocus: true,
	});

	const accept = useMutation({
		mutationFn: async (id: string) => {
			// Bypass authedFetch's "throw on !r.ok" so we can distinguish
			// 409 mount_target_ambiguous (membership IS created server-side,
			// only the mount edge is deferred) from real failures. The
			// other error paths still bubble as ApiError.
			const token = await getToken();
			const headers = new Headers();
			if (token) headers.set("Authorization", `Bearer ${token}`);
			const r = await fetch(`${API_URL}/api/me/invitations/${id}/accept`, {
				method: "POST",
				headers,
			});
			if (r.status === 409) {
				const body = (await r.json().catch(() => ({}))) as {
					detail?: { error?: string };
				};
				if (body?.detail?.error === "mount_target_ambiguous") {
					return { mountDeferred: true as const };
				}
				throw new ApiError(409, JSON.stringify(body));
			}
			if (!r.ok) throw new ApiError(r.status, await r.text());
			return { mountDeferred: false as const, ...(await r.json()) };
		},
		onSuccess: (result) => {
			refetchMembershipDerived();
			if (result.mountDeferred) {
				toast.success("Joined as viewer — pick a parent scope to compose it into your workspace.");
			} else {
				toast.success("Joined as viewer — shared skills now appear in your dashboard");
			}
		},
		onError: (e) => {
			toast.error(
				e instanceof ApiError && e.status === 410
					? "This invitation was revoked. Ask the owner to send a new one."
					: e instanceof Error
						? e.message
						: "Couldn't accept",
			);
		},
	});

	const decline = useMutation({
		mutationFn: async (id: string) => {
			await authedFetch(`/api/me/invitations/${id}/decline`, { method: "POST" });
		},
		onSuccess: () => {
			refetchMembershipDerived();
			toast.success("Invitation declined");
		},
		onError: (e) => {
			toast.error(e instanceof Error ? e.message : "Couldn't decline");
		},
	});

	const items = invitations.data ?? [];
	// Self-hiding: nothing to act on, render nothing. The loading
	// flicker is fine — invitations are an exceptional state.
	if (invitations.isLoading || items.length === 0 || invitations.error) {
		return null;
	}

	return (
		<Alert>
			<Mail />
			<AlertTitle>
				You've been invited to{" "}
				{items.length === 1 ? "a shared scope" : `${items.length} shared scopes`}
			</AlertTitle>
			<AlertDescription className="space-y-3">
				<p className="text-xs text-muted-foreground">
					Accept to start syncing the owner's skills into your dashboard. You join as a{" "}
					<Badge variant="secondary">viewer</Badge> — read-only access.
				</p>
				<ul className="space-y-2">
					{items.map((inv, idx) => {
						const pending = accept.isPending && accept.variables === inv.id;
						const declining = decline.isPending && decline.variables === inv.id;
						return (
							<li key={inv.id} className="space-y-2">
								<div className="flex items-center justify-between gap-2">
									<div className="min-w-0 flex-1">
										<div className="truncate text-sm font-medium">{inv.scope_name}</div>
										<div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
											<span>
												from {inv.owner_display}{" "}
												<span className="font-mono">@{inv.owner_handle}</span>
											</span>
											<span aria-hidden>·</span>
											<span>
												{new Date(inv.created_at).toLocaleDateString(undefined, {
													month: "short",
													day: "numeric",
												})}
											</span>
										</div>
									</div>
									<div className="flex shrink-0 gap-1">
										<Button
											size="sm"
											variant="ghost"
											onClick={() => decline.mutate(inv.id)}
											disabled={pending || declining}
										>
											<XCircle className="mr-1 size-3.5" />
											{declining ? "…" : "Decline"}
										</Button>
										<Button
											size="sm"
											onClick={() => accept.mutate(inv.id)}
											disabled={pending || declining}
										>
											<CheckCircle2 className="mr-1 size-3.5" />
											{pending ? "Joining…" : "Accept"}
										</Button>
									</div>
								</div>
								{idx < items.length - 1 ? <Separator className="my-1" /> : null}
							</li>
						);
					})}
				</ul>
			</AlertDescription>
		</Alert>
	);
}
