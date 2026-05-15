"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, InboxIcon, MailOpen, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, useAuthedFetch } from "@/lib/api";
import { cn, errorMessage } from "@/lib/utils";
import {
	type AcceptInvitationResponse,
	getAcceptedProjectInvitationToastCopy,
	getNotificationCenterEmptyCopy,
	getNotificationCenterTitle,
	getNotificationCenterTriggerLabel,
	getPendingNotificationCount,
	getProjectInvitationAccessCopy,
	NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS,
	NOTIFICATION_CENTER_QUERY_KEY,
	type ProjectInvitationNotification,
} from "./notification-center.logic";
import { formatApiError } from "./sharing/vault-conflicts";

export function NotificationCenter() {
	const router = useRouter();
	const queryClient = useQueryClient();
	const authedFetch = useAuthedFetch();
	const [open, setOpen] = useState(false);

	function refetchMembershipDerived() {
		for (const queryKey of NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS) {
			queryClient.invalidateQueries({ queryKey });
		}
	}

	const invitations = useQuery({
		queryKey: NOTIFICATION_CENTER_QUERY_KEY,
		queryFn: async (): Promise<ProjectInvitationNotification[]> => {
			const response = await authedFetch("/api/me/invitations");
			return response.json();
		},
		refetchOnWindowFocus: true,
	});

	const accept = useMutation({
		mutationFn: async ({
			id,
		}: {
			id: string;
			projectName: string;
		}): Promise<AcceptInvitationResponse> => {
			const response = await authedFetch(`/api/me/invitations/${id}/accept`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			return response.json();
		},
		onSuccess: (result, variables) => {
			refetchMembershipDerived();
			const copy = getAcceptedProjectInvitationToastCopy(variables.projectName);
			toast.success(copy.title, {
				description: copy.description,
				action: {
					label: "Open project",
					onClick: () => router.push(`/projects/${result.project_id}`),
				},
			});
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
	const count = getPendingNotificationCount(items);
	const triggerLabel = getNotificationCenterTriggerLabel(count);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className={cn("relative", count > 0 && "text-foreground")}
					aria-label={triggerLabel}
					title={triggerLabel}
				>
					<InboxIcon className="size-4" />
					{count > 0 ? (
						<Badge className="-right-1 -top-1 absolute h-4 min-w-4 rounded-full px-1 text-[10px] leading-none">
							{count > 99 ? "99+" : count}
						</Badge>
					) : null}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[min(calc(100vw-2rem),26rem)] p-0">
				<PopoverHeader className="px-4 py-3">
					<div className="flex items-center justify-between gap-3">
						<PopoverTitle>{getNotificationCenterTitle(count)}</PopoverTitle>
						{count > 0 ? <Badge variant="secondary">{count} pending</Badge> : null}
					</div>
					<PopoverDescription>{getProjectInvitationAccessCopy()}</PopoverDescription>
				</PopoverHeader>
				<Separator />
				<NotificationCenterContent
					invitations={items}
					isLoading={invitations.isLoading}
					error={invitations.error}
					onRetry={() => invitations.refetch()}
					acceptInvitation={(invitation) =>
						accept.mutate({ id: invitation.id, projectName: invitation.project_name })
					}
					declineInvitation={(invitation) => decline.mutate(invitation.id)}
					acceptingId={accept.isPending ? accept.variables?.id : undefined}
					decliningId={decline.isPending ? decline.variables : undefined}
				/>
			</PopoverContent>
		</Popover>
	);
}

function NotificationCenterContent({
	invitations,
	isLoading,
	error,
	onRetry,
	acceptInvitation,
	declineInvitation,
	acceptingId,
	decliningId,
}: {
	invitations: ProjectInvitationNotification[];
	isLoading: boolean;
	error: Error | null;
	onRetry: () => void;
	acceptInvitation: (invitation: ProjectInvitationNotification) => void;
	declineInvitation: (invitation: ProjectInvitationNotification) => void;
	acceptingId?: string;
	decliningId?: string;
}) {
	if (isLoading) {
		return (
			<div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
				<Spinner className="size-3.5" />
				Loading invitations...
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-3 px-4 py-4">
				<div className="space-y-1">
					<div className="text-sm font-medium">Couldn't load invitations</div>
					<p className="text-xs text-muted-foreground">{errorMessage(error)}</p>
				</div>
				<Button size="sm" variant="outline" onClick={onRetry}>
					Retry
				</Button>
			</div>
		);
	}

	if (invitations.length === 0) {
		const empty = getNotificationCenterEmptyCopy();
		return (
			<div className="flex items-start gap-3 px-4 py-5">
				<div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
					<MailOpen className="size-4 text-muted-foreground" />
				</div>
				<div className="space-y-1">
					<div className="text-sm font-medium">{empty.title}</div>
					<p className="text-xs text-muted-foreground">{empty.description}</p>
				</div>
			</div>
		);
	}

	return (
		<ul className="max-h-[26rem] overflow-y-auto">
			{invitations.map((invitation, index) => {
				const accepting = acceptingId === invitation.id;
				const declining = decliningId === invitation.id;
				const busy = accepting || declining;

				return (
					<li key={invitation.id}>
						<div className="space-y-3 px-4 py-3">
							<div className="min-w-0 space-y-1">
								<div className="flex min-w-0 items-start justify-between gap-3">
									<div className="min-w-0">
										<div className="truncate text-sm font-medium">{invitation.project_name}</div>
										<div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
											<span>
												from {invitation.owner_display}{" "}
												<span className="font-mono">@{invitation.owner_handle}</span>
											</span>
											<span aria-hidden="true">·</span>
											<span>{formatInvitationDate(invitation.created_at)}</span>
										</div>
									</div>
									<Badge variant="outline" className="shrink-0">
										viewer
									</Badge>
								</div>
								<p className="text-xs text-muted-foreground">
									Open project after accepting to review shared context. Use with agent remains
									separate.
								</p>
							</div>
							<div className="flex justify-end gap-1.5">
								<Button
									size="sm"
									variant="ghost"
									onClick={() => declineInvitation(invitation)}
									disabled={busy}
								>
									<XCircle className="size-3.5" />
									{declining ? "Declining..." : "Decline"}
								</Button>
								<Button size="sm" onClick={() => acceptInvitation(invitation)} disabled={busy}>
									<CheckCircle2 className="size-3.5" />
									{accepting ? "Joining..." : "Accept"}
								</Button>
							</div>
						</div>
						{index < invitations.length - 1 ? <Separator /> : null}
					</li>
				);
			})}
		</ul>
	);
}

function formatInvitationDate(createdAt: string): string {
	return new Date(createdAt).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}
