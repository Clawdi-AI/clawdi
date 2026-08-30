"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
	AlertTriangle,
	ArrowRight,
	CheckCircle2,
	InboxIcon,
	MailOpen,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { IconChip } from "@/components/icon-chip";
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
import { ApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import { projectDetailHref } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";
import {
	type AcceptInvitationResponse,
	type ActionRequiredNotification,
	getAcceptedProjectInvitationToastCopy,
	getNotificationCenterDescription,
	getNotificationCenterEmptyCopy,
	getNotificationCenterTitle,
	getNotificationCenterTriggerLabel,
	getPendingNotificationCount,
	getProjectInvitationAccessCopy,
	NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS,
	type ProjectInvitationNotification,
} from "./notification-center.logic";

export function NotificationCenter({
	actionRequired = [],
	onActionRequired,
}: {
	actionRequired?: readonly ActionRequiredNotification[];
	onActionRequired?: (notification: ActionRequiredNotification) => void;
}) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const api = useApi();
	const $api = useOpenApi();
	const [open, setOpen] = useState(false);

	function refetchMembershipDerived() {
		for (const queryKey of NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS) {
			queryClient.invalidateQueries({ queryKey });
		}
	}

	const invitations = $api.useQuery(
		"get",
		"/v1/me/invitations",
		{},
		{
			refetchOnWindowFocus: true,
		},
	);

	const accept = useMutation({
		mutationFn: async ({
			id,
		}: {
			id: string;
			projectName: string;
		}): Promise<AcceptInvitationResponse> =>
			unwrap(
				await api.POST("/v1/me/invitations/{invitation_id}/accept", {
					params: { path: { invitation_id: id } },
					body: { use_as: "attached" },
				}),
			),
		onSuccess: (result, variables) => {
			refetchMembershipDerived();
			const copy = getAcceptedProjectInvitationToastCopy(variables.projectName);
			toast.success(copy.title, {
				description: copy.description,
				action: {
					label: "Open Project",
					onClick: () => void router.navigate({ href: projectDetailHref(result.project_id) }),
				},
			});
		},
		onError: (e) => {
			toast.error(
				e instanceof ApiError && e.status === 410
					? "This invitation was canceled. Ask the owner to send a new one."
					: normalizeApiError(e),
			);
		},
	});

	const decline = useMutation({
		mutationFn: async (id: string) => {
			await unwrap(
				await api.POST("/v1/me/invitations/{invitation_id}/decline", {
					params: { path: { invitation_id: id } },
				}),
			);
		},
		onSuccess: () => {
			refetchMembershipDerived();
			toast.success("Invitation declined");
		},
		onError: (e) => {
			toast.error("Couldn't decline invitation", {
				description: normalizeApiError(e),
			});
		},
	});

	const items = invitations.data ?? [];
	const count = getPendingNotificationCount(items, actionRequired);
	const triggerLabel = getNotificationCenterTriggerLabel(count);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className={cn("relative", count > 0 && "text-foreground")}
						aria-label={triggerLabel}
						title={triggerLabel}
					/>
				}
			>
				<InboxIcon className="size-4" />
				{count > 0 ? (
					<Badge className="-right-1 -top-1 absolute h-4 min-w-4 rounded-full px-1 text-3xs leading-none">
						{count > 99 ? "99+" : count}
					</Badge>
				) : null}
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[min(calc(100vw-2rem),26rem)] p-0">
				<PopoverHeader className="px-4 py-3">
					<div className="flex items-center justify-between gap-3">
						<PopoverTitle>{getNotificationCenterTitle(count)}</PopoverTitle>
						{count > 0 ? <Badge variant="secondary">{count} Pending</Badge> : null}
					</div>
					<PopoverDescription>{getNotificationCenterDescription()}</PopoverDescription>
				</PopoverHeader>
				<Separator />
				<NotificationCenterContent
					invitations={items}
					actionRequired={actionRequired}
					isLoading={invitations.isLoading}
					error={
						shouldBlockQueryError(invitations.error, invitations.data) ? invitations.error : null
					}
					onRetry={() => invitations.refetch()}
					acceptInvitation={(invitation) =>
						accept.mutate({ id: invitation.id, projectName: invitation.project_name })
					}
					declineInvitation={(invitation) => decline.mutate(invitation.id)}
					acceptingId={accept.isPending ? accept.variables?.id : undefined}
					decliningId={decline.isPending ? decline.variables : undefined}
					onActionRequired={(notification) => {
						setOpen(false);
						onActionRequired?.(notification);
					}}
				/>
				{items.length > 0 ? (
					<>
						<Separator />
						<div className="flex items-center justify-between gap-3 px-4 py-3">
							<p className="text-xs text-muted-foreground">
								Accepted invites appear under Shared Projects.
							</p>
							<Button
								render={<Link to="/projects" />}
								nativeButton={false}
								variant="ghost"
								size="sm"
								onClick={() => setOpen(false)}
							>
								View Accepted Invites
							</Button>
						</div>
					</>
				) : null}
			</PopoverContent>
		</Popover>
	);
}

function NotificationCenterContent({
	invitations,
	actionRequired,
	isLoading,
	error,
	onRetry,
	acceptInvitation,
	declineInvitation,
	acceptingId,
	decliningId,
	onActionRequired,
}: {
	invitations: ProjectInvitationNotification[];
	actionRequired: readonly ActionRequiredNotification[];
	isLoading: boolean;
	error: Error | null;
	onRetry: () => void;
	acceptInvitation: (invitation: ProjectInvitationNotification) => void;
	declineInvitation: (invitation: ProjectInvitationNotification) => void;
	acceptingId?: string;
	decliningId?: string;
	onActionRequired: (notification: ActionRequiredNotification) => void;
}) {
	const hasNotifications = actionRequired.length > 0 || invitations.length > 0;

	if (isLoading && !hasNotifications) {
		return (
			<div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
				<Spinner className="size-3.5" />
				Loading Invitations…
			</div>
		);
	}

	if (error && !hasNotifications) {
		return (
			<div className="space-y-3 px-4 py-4">
				<div className="space-y-1">
					<div className="text-sm font-medium">Couldn&apos;t Load Invitations</div>
					<p className="text-xs text-muted-foreground">{normalizeApiError(error)}</p>
				</div>
				<Button size="sm" variant="outline" onClick={onRetry}>
					Retry
				</Button>
			</div>
		);
	}

	if (!hasNotifications) {
		const empty = getNotificationCenterEmptyCopy();
		return (
			<div className="flex items-start gap-3 px-4 py-5">
				<IconChip size="sm" tint="bg-muted text-muted-foreground">
					<MailOpen className="size-4 text-muted-foreground" />
				</IconChip>
				<div className="space-y-1">
					<div className="text-sm font-medium">{empty.title}</div>
					<p className="text-xs text-muted-foreground">{empty.description}</p>
				</div>
			</div>
		);
	}

	return (
		<ul className="max-h-[26rem] divide-y overflow-y-auto">
			{actionRequired.map((notification) => (
				<li key={notification.id}>
					<div className="flex items-start gap-3 px-4 py-3">
						<IconChip
							size="sm"
							tint={
								notification.severity === "destructive"
									? "bg-destructive/10 text-destructive"
									: undefined
							}
						>
							<AlertTriangle />
						</IconChip>
						<div className="min-w-0 flex-1 space-y-2">
							<div className="flex min-w-0 items-start justify-between gap-3">
								<div className="text-sm font-medium">{notification.title}</div>
								<Badge
									variant={
										notification.severity === "destructive" ? "destructive" : "outline"
									}
								>
									{notification.badge}
								</Badge>
							</div>
							<p className="text-xs text-muted-foreground">{notification.description}</p>
							<Button size="sm" onClick={() => onActionRequired(notification)}>
								<ArrowRight />
								{notification.actionLabel}
							</Button>
						</div>
					</div>
				</li>
			))}
			{isLoading ? (
				<li className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
					<Spinner className="size-3.5" />
					Loading Invitations…
				</li>
			) : error ? (
				<li className="space-y-3 px-4 py-4">
					<div className="space-y-1">
						<div className="text-sm font-medium">Couldn&apos;t Load Invitations</div>
						<p className="text-xs text-muted-foreground">{normalizeApiError(error)}</p>
					</div>
					<Button size="sm" variant="outline" onClick={onRetry}>
						Retry
					</Button>
				</li>
			) : null}
			{invitations.map((invitation) => {
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
												From {invitation.owner_display}{" "}
												<span className="font-mono">@{invitation.owner_handle}</span>
											</span>
											<span aria-hidden="true">·</span>
											<span>{formatInvitationDate(invitation.created_at)}</span>
										</div>
									</div>
									<div className="flex shrink-0 flex-col items-end gap-1">
										<Badge variant="secondary">Project Invite</Badge>
										<Badge variant="outline">Viewer</Badge>
									</div>
								</div>
								<p className="text-xs text-muted-foreground">
									{getProjectInvitationAccessCopy()}
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
									{declining ? "Declining…" : "Decline"}
								</Button>
								<Button size="sm" onClick={() => acceptInvitation(invitation)} disabled={busy}>
									<CheckCircle2 className="size-3.5" />
									{accepting ? "Joining…" : "Accept"}
								</Button>
							</div>
						</div>
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
