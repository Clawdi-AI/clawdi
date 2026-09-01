"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
	Bell,
	Check,
	CheckCircle2,
	CircleAlert,
	ExternalLink,
	FolderInput,
	MailOpen,
	MoreHorizontal,
	RefreshCw,
	Trash2,
	XCircle,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { IconChip } from "@/components/icon-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import { projectDetailHref } from "@/lib/project-resource-model";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";
import {
	type AcceptInvitationResponse,
	type AccountNotification,
	filterAccountNotifications,
	getAcceptedProjectInvitationToastCopy,
	getNotificationCenterDescription,
	getNotificationCenterEmptyCopy,
	getNotificationCenterTriggerLabel,
	getPendingNotificationCount,
	getProjectInvitationAccessCopy,
	NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS,
	type NotificationCenterView,
	type ProjectInvitationNotification,
} from "./notification-center.logic";

export type AccountNotificationSource = {
	items: readonly AccountNotification[];
	unreadCount: number;
	hasMore: boolean;
	loading: boolean;
	loadingMore: boolean;
	error: Error | null;
	busyId?: string;
	actionsDisabled: boolean;
	markingAllRead: boolean;
	onRetry: () => void;
	onLoadMore: () => void;
	onMarkAllRead: () => void;
	onMarkRead: (notification: AccountNotification) => void;
	onMarkUnread: (notification: AccountNotification) => void;
	onDelete: (notification: AccountNotification) => void;
	onOpenAction: (notification: AccountNotification) => void;
};

export function NotificationCenter({ account }: { account?: AccountNotificationSource }) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const api = useApi();
	const $api = useOpenApi();
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<NotificationCenterView>("all");

	function refetchMembershipDerived() {
		for (const queryKey of NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS) {
			queryClient.invalidateQueries({ queryKey });
		}
	}

	const invitations = $api.useQuery(
		"get",
		"/v1/me/invitations",
		{},
		{ refetchOnWindowFocus: true },
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
		onError: (error) => {
			toast.error(
				error instanceof ApiError && error.status === 410
					? "This invitation was canceled. Ask the owner to send a new one."
					: normalizeApiError(error),
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
		onError: (error) => {
			toast.error("Couldn't decline invitation", {
				description: normalizeApiError(error),
			});
		},
	});

	const invitationItems = invitations.data ?? [];
	const attentionCount = getPendingNotificationCount(invitationItems, account?.unreadCount);
	const triggerLabel = getNotificationCenterTriggerLabel(attentionCount);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className={cn("relative", attentionCount > 0 && "text-foreground")}
						aria-label={triggerLabel}
						title={triggerLabel}
					/>
				}
			>
				<Bell className="size-4" />
				{attentionCount > 0 ? (
					<span
						aria-hidden="true"
						className="-right-1 -top-1 absolute flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-semibold text-[9px] text-destructive-foreground leading-none ring-2 ring-background"
					>
						{attentionCount > 9 ? "9+" : attentionCount}
					</span>
				) : null}
			</PopoverTrigger>
			<PopoverContent
				align="end"
				sideOffset={8}
				className="w-[min(calc(100vw-1rem),28rem)] gap-0 overflow-hidden p-0"
			>
				<PopoverHeader className="gap-2 px-4 pt-4 pb-3">
					<div className="flex items-start justify-between gap-3">
						<div className="min-w-0">
							<PopoverTitle className="text-base">Notifications</PopoverTitle>
							<PopoverDescription className="mt-0.5 text-xs">
								{getNotificationCenterDescription()}
							</PopoverDescription>
						</div>
						{account && account.unreadCount > 0 ? (
							<Button
								type="button"
								variant="ghost"
								size="xs"
								disabled={account.actionsDisabled}
								onClick={account.onMarkAllRead}
							>
								{account.markingAllRead ? <Spinner /> : <Check />}
								Mark all read
							</Button>
						) : null}
					</div>
				</PopoverHeader>

				<Tabs
					value={view}
					onValueChange={(value) => {
						if (value === "all" || value === "unread") setView(value);
					}}
					className="gap-0"
				>
					<div className="px-4">
						<TabsList variant="line" aria-label="Notification filters" className="h-9 w-full">
							<TabsTrigger value="all" className="justify-start">
								All
							</TabsTrigger>
							<TabsTrigger value="unread" className="justify-start">
								Unread <TabCount>{attentionCount}</TabCount>
							</TabsTrigger>
						</TabsList>
					</div>
					<Separator />

					{(["all", "unread"] as const).map((tab) => (
						<TabsContent key={tab} value={tab} className="min-h-0">
							<NotificationCenterContent
								view={tab}
								invitations={invitationItems}
								account={account}
								invitationsLoading={invitations.isLoading}
								invitationsError={
									shouldBlockQueryError(invitations.error, invitations.data)
										? invitations.error
										: null
								}
								onRetryInvitations={() => invitations.refetch()}
								acceptInvitation={(invitation) =>
									accept.mutate({ id: invitation.id, projectName: invitation.project_name })
								}
								declineInvitation={(invitation) => decline.mutate(invitation.id)}
								acceptingId={accept.isPending ? accept.variables?.id : undefined}
								decliningId={decline.isPending ? decline.variables : undefined}
								onOpenAccountAction={() => setOpen(false)}
							/>
						</TabsContent>
					))}
				</Tabs>
			</PopoverContent>
		</Popover>
	);
}

function TabCount({ children }: { children: number }) {
	return (
		<span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground leading-none">
			{children > 99 ? "99+" : children}
		</span>
	);
}

type NotificationCenterContentProps = {
	view: NotificationCenterView;
	invitations: ProjectInvitationNotification[];
	account?: AccountNotificationSource;
	invitationsLoading: boolean;
	invitationsError: Error | null;
	onRetryInvitations: () => void;
	acceptInvitation: (invitation: ProjectInvitationNotification) => void;
	declineInvitation: (invitation: ProjectInvitationNotification) => void;
	acceptingId?: string;
	decliningId?: string;
	onOpenAccountAction: () => void;
};

function NotificationCenterContent({
	view,
	invitations,
	account,
	invitationsLoading,
	invitationsError,
	onRetryInvitations,
	acceptInvitation,
	declineInvitation,
	acceptingId,
	decliningId,
	onOpenAccountAction,
}: NotificationCenterContentProps) {
	const accountNotifications = filterAccountNotifications(account?.items ?? [], view);
	const hasVisibleNotifications = accountNotifications.length > 0 || invitations.length > 0;
	const hasSourceStatus =
		Boolean(account?.loading) || invitationsLoading || Boolean(account?.error || invitationsError);
	const canLoadMoreAccount = Boolean(account?.hasMore);

	return (
		<div className="max-h-[min(34rem,calc(100vh-10rem))] overflow-y-auto overscroll-contain">
			{accountNotifications.length > 0 ? (
				<NotificationSection title="Account updates">
					{accountNotifications.map((notification) => (
						<AccountNotificationRow
							key={notification.id}
							notification={notification}
							busy={account?.busyId === notification.id}
							disabled={Boolean(account?.actionsDisabled)}
							onMarkRead={account?.onMarkRead}
							onMarkUnread={account?.onMarkUnread}
							onDelete={account?.onDelete}
							onOpenAction={(item) => {
								onOpenAccountAction();
								account?.onOpenAction(item);
							}}
						/>
					))}
				</NotificationSection>
			) : null}

			{account?.loading && accountNotifications.length === 0 ? (
				<SourceLoading label="Loading account updates…" />
			) : null}
			{account?.error ? (
				<SourceError
					title="Account updates unavailable"
					description="We couldn't load account updates. Check your connection and try again."
					onRetry={account.onRetry}
				/>
			) : null}

			{invitations.length > 0 ? (
				<NotificationSection title="Project invitations">
					{invitations.map((invitation) => (
						<ProjectInvitationRow
							key={invitation.id}
							invitation={invitation}
							accepting={acceptingId === invitation.id}
							declining={decliningId === invitation.id}
							onAccept={acceptInvitation}
							onDecline={declineInvitation}
						/>
					))}
				</NotificationSection>
			) : null}

			{invitationsLoading && invitations.length === 0 ? (
				<SourceLoading label="Loading project invitations…" />
			) : null}
			{invitationsError ? (
				<SourceError
					title="Project invitations unavailable"
					description={normalizeApiError(invitationsError)}
					onRetry={onRetryInvitations}
				/>
			) : null}

			{!hasVisibleNotifications && !hasSourceStatus && !canLoadMoreAccount ? (
				<EmptyState view={view} />
			) : null}

			{canLoadMoreAccount ? (
				<div className="border-t px-4 py-3 text-center">
					<Button
						type="button"
						variant="ghost"
						size="xs"
						disabled={account?.loadingMore}
						onClick={account?.onLoadMore}
					>
						{account?.loadingMore ? <Spinner /> : <RefreshCw />}
						Load earlier
					</Button>
				</div>
			) : null}
		</div>
	);
}

function NotificationSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section aria-label={title}>
			<div className="sticky top-0 z-10 border-b bg-popover/95 px-4 py-2 text-xs backdrop-blur-sm supports-backdrop-filter:bg-popover/85">
				<span className="font-medium text-muted-foreground">{title}</span>
			</div>
			<ul className="divide-y">{children}</ul>
		</section>
	);
}

type AccountNotificationRowProps = {
	notification: AccountNotification;
	busy: boolean;
	disabled: boolean;
	onMarkRead?: (notification: AccountNotification) => void;
	onMarkUnread?: (notification: AccountNotification) => void;
	onDelete?: (notification: AccountNotification) => void;
	onOpenAction: (notification: AccountNotification) => void;
};

function AccountNotificationRow({
	notification,
	busy,
	disabled,
	onMarkRead,
	onMarkUnread,
	onDelete,
	onOpenAction,
}: AccountNotificationRowProps) {
	return (
		<li
			className={cn(
				"group relative px-4 py-3.5 transition-colors",
				!notification.read && "bg-muted/35",
			)}
		>
			{!notification.read ? (
				<span
					aria-hidden="true"
					className="absolute top-5 left-1.5 size-1.5 rounded-full bg-primary"
				/>
			) : null}
			<div className="flex items-start gap-3">
				<IconChip size="sm" tint={notificationIconTint(notification.severity)}>
					<Bell />
				</IconChip>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-start justify-between gap-3">
						<div className="min-w-0">
							<div className={cn("text-sm", notification.read ? "font-medium" : "font-semibold")}>
								{notification.title}
								{!notification.read ? <span className="sr-only"> (unread)</span> : null}
							</div>
							<time
								dateTime={notification.createdAt.toISOString()}
								title={notification.createdAt.toLocaleString()}
								className="mt-0.5 block text-xs text-muted-foreground"
							>
								{formatRelativeDate(notification.createdAt)}
							</time>
						</div>
						<div className="flex shrink-0 items-center gap-1">
							<Badge variant="outline">{notification.category}</Badge>
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											disabled={disabled}
											aria-label={`More actions for ${notification.title}`}
										/>
									}
								>
									{busy ? <Spinner /> : <MoreHorizontal />}
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-44">
									{notification.read ? (
										<DropdownMenuItem onClick={() => onMarkUnread?.(notification)}>
											<RefreshCw />
											Mark as unread
										</DropdownMenuItem>
									) : (
										<DropdownMenuItem onClick={() => onMarkRead?.(notification)}>
											<Check />
											Mark as read
										</DropdownMenuItem>
									)}
									<DropdownMenuSeparator />
									<DropdownMenuItem variant="destructive" onClick={() => onDelete?.(notification)}>
										<Trash2 />
										Remove
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					</div>
					<p className="mt-2 text-xs text-muted-foreground leading-relaxed">
						{notification.description}
					</p>
					{notification.actionLabel && notification.actionUrl ? (
						<div className="mt-3">
							<Button
								type="button"
								variant="outline"
								size="xs"
								disabled={disabled}
								onClick={() => onOpenAction(notification)}
							>
								<ExternalLink />
								{notification.actionLabel}
							</Button>
						</div>
					) : null}
				</div>
			</div>
		</li>
	);
}

function ProjectInvitationRow({
	invitation,
	accepting,
	declining,
	onAccept,
	onDecline,
}: {
	invitation: ProjectInvitationNotification;
	accepting: boolean;
	declining: boolean;
	onAccept: (invitation: ProjectInvitationNotification) => void;
	onDecline: (invitation: ProjectInvitationNotification) => void;
}) {
	const busy = accepting || declining;
	return (
		<li className="px-4 py-3.5">
			<div className="flex items-start gap-3">
				<IconChip size="sm">
					<FolderInput />
				</IconChip>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-start justify-between gap-3">
						<div className="min-w-0">
							<div className="truncate text-sm font-semibold">{invitation.project_name}</div>
							<div className="mt-0.5 text-xs text-muted-foreground">
								From {invitation.owner_display}{" "}
								<span className="font-mono">@{invitation.owner_handle}</span>
								<span aria-hidden="true"> · </span>
								{formatRelativeDate(new Date(invitation.created_at))}
							</div>
						</div>
						<Badge variant="secondary">Viewer</Badge>
					</div>
					<p className="mt-2 text-xs text-muted-foreground leading-relaxed">
						{getProjectInvitationAccessCopy()}
					</p>
					<div className="mt-3 flex justify-end gap-1.5">
						<Button
							type="button"
							size="xs"
							variant="ghost"
							onClick={() => onDecline(invitation)}
							disabled={busy}
						>
							<XCircle />
							{declining ? "Declining…" : "Decline"}
						</Button>
						<Button type="button" size="xs" onClick={() => onAccept(invitation)} disabled={busy}>
							<CheckCircle2 />
							{accepting ? "Joining…" : "Accept"}
						</Button>
					</div>
				</div>
			</div>
		</li>
	);
}

function SourceLoading({ label }: { label: string }) {
	return (
		<div
			className="flex items-center gap-2 border-b px-4 py-4 text-xs text-muted-foreground"
			role="status"
		>
			<Spinner className="size-3.5" />
			{label}
		</div>
	);
}

function SourceError({
	title,
	description,
	onRetry,
}: {
	title: string;
	description: string;
	onRetry?: () => void;
}) {
	return (
		<div className="flex items-start gap-3 border-b px-4 py-4" role="status">
			<IconChip size="sm" tint="bg-muted text-muted-foreground">
				<CircleAlert />
			</IconChip>
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium">{title}</div>
				<p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">{description}</p>
				{onRetry ? (
					<Button type="button" size="xs" variant="outline" className="mt-2.5" onClick={onRetry}>
						<RefreshCw />
						Retry
					</Button>
				) : null}
			</div>
		</div>
	);
}

function EmptyState({ view }: { view: NotificationCenterView }) {
	const empty = getNotificationCenterEmptyCopy(view);
	return (
		<div className="flex min-h-48 flex-col items-center justify-center px-8 py-10 text-center">
			<div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
				<MailOpen className="size-4" />
			</div>
			<div className="mt-3 text-sm font-medium">{empty.title}</div>
			<p className="mt-1 max-w-64 text-xs text-muted-foreground leading-relaxed">
				{empty.description}
			</p>
		</div>
	);
}

function notificationIconTint(severity: AccountNotification["severity"]): string | undefined {
	if (severity === "destructive") return "bg-destructive/10 text-destructive";
	if (severity === "warning") return "bg-warning/10 text-warning-foreground";
	return undefined;
}

function formatRelativeDate(value: Date): string {
	const seconds = Math.round((value.getTime() - Date.now()) / 1_000);
	const absoluteSeconds = Math.abs(seconds);
	if (absoluteSeconds < 45) return "Now";

	const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	if (absoluteSeconds < 60 * 60) return formatter.format(Math.round(seconds / 60), "minute");
	if (absoluteSeconds < 60 * 60 * 24) return formatter.format(Math.round(seconds / 3_600), "hour");
	if (absoluteSeconds < 60 * 60 * 24 * 7)
		return formatter.format(Math.round(seconds / 86_400), "day");

	return value.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(value.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
	});
}
