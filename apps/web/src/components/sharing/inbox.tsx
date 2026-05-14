"use client";

import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Mail, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { API_URL, ApiError, useAuthedFetch } from "@/lib/api";
import { errorMessage } from "@/lib/utils";
import { formatApiError } from "./vault-conflicts";

interface Invitation {
	id: string;
	project_id: string;
	project_name: string;
	project_kind: string;
	owner_display: string;
	owner_handle: string;
	invitee_email: string;
	invited_by_user_id: string;
	invited_by_display: string | null;
	created_at: string;
}

interface AcceptResponse {
	id: string;
	project_id: string;
	role: string;
	joined_via: string;
	joined_at: string;
	resolved_owner_handle: string;
	bound_agent_ids?: string[];
}

export function Inbox() {
	const { getToken } = useAuth();
	const qc = useQueryClient();
	const authedFetch = useAuthedFetch();

	const refetchMembershipDerived = () => {
		qc.invalidateQueries({ queryKey: ["me-invitations"] });
		qc.invalidateQueries({ queryKey: ["skills"] });
		qc.invalidateQueries({ queryKey: ["projects"] });
		qc.invalidateQueries({ queryKey: ["agents"] });
	};

	const invitations = useQuery({
		queryKey: ["me-invitations"],
		queryFn: async (): Promise<Invitation[]> => {
			const r = await authedFetch("/api/me/invitations");
			return r.json();
		},
		refetchOnWindowFocus: true,
	});

	const accept = useMutation({
		mutationFn: async ({ id }: { id: string }) => {
			const token = await getToken();
			const headers = new Headers();
			if (token) headers.set("Authorization", `Bearer ${token}`);
			headers.set("Content-Type", "application/json");
			const r = await fetch(`${API_URL}/api/me/invitations/${id}/accept`, {
				method: "POST",
				headers,
				body: JSON.stringify({}),
			});
			if (!r.ok) throw new ApiError(r.status, await r.text());
			return (await r.json()) as AcceptResponse;
		},
		onSuccess: (result) => {
			refetchMembershipDerived();
			const bound = result.bound_agent_ids?.length ?? 0;
			if (bound > 0) {
				toast.success(`Joined project and attached it to ${bound} agent${bound === 1 ? "" : "s"}.`);
				return;
			}
			toast.success("Joined project as viewer. Use it with an agent when you're ready.");
		},
		onError: (e) => {
			toast.error(
				e instanceof ApiError && e.status === 410
					? "This invitation was revoked. Ask the owner to send a new one."
					: e instanceof ApiError
						? formatApiError(e.detail)
						: errorMessage(e),
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
			toast.error("Couldn't decline", {
				description: e instanceof ApiError ? formatApiError(e.detail) : errorMessage(e),
			});
		},
	});

	const items = invitations.data ?? [];
	if (invitations.isLoading || items.length === 0 || invitations.error) {
		return null;
	}

	return (
		<Alert>
			<Mail />
			<AlertTitle>
				You've been invited to{" "}
				{items.length === 1 ? "a shared project" : `${items.length} shared projects`}
			</AlertTitle>
			<AlertDescription className="space-y-3">
				<p className="text-xs text-muted-foreground">
					Accept to gain project access. You join as a <Badge variant="secondary">viewer</Badge>{" "}
					with read-only access; using it with an agent is a separate step.
				</p>
				<ul className="space-y-2">
					{items.map((inv, idx) => {
						const pending = accept.isPending && accept.variables?.id === inv.id;
						const declining = decline.isPending && decline.variables === inv.id;
						return (
							<li key={inv.id} className="space-y-2">
								<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
									<div className="min-w-0 flex-1">
										<div className="truncate text-sm font-medium">{inv.project_name}</div>
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
											onClick={() => accept.mutate({ id: inv.id })}
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
