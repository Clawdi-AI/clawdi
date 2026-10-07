"use client";

import { notificationCenterClasses as styles } from "@clawdi/shared/ui";
import {
	notificationCenterCopy as copy,
	formatNotificationTime,
	notificationBadgeLabel,
	projectDetailHref,
} from "@clawdi/shared/view";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import {
	Bell,
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
import { Spinner } from "@/components/ui/spinner";
import { ApiError, unwrap, useApi, useOpenApi } from "@/lib/api";
import { normalizeApiError } from "@/lib/api-errors";
import { shouldBlockQueryError } from "@/lib/query-state";
import { cn } from "@/lib/utils";
import {
	type AcceptInvitationResponse,
	type AccountNotification,
	getAcceptedProjectInvitationToastCopy,
	getNotificationCenterDescription,
	getNotificationCenterEmptyCopy,
	getNotificationCenterTriggerLabel,
	getPendingNotificationCount,
	getProjectInvitationAccessCopy,
	NOTIFICATION_CENTER_MEMBERSHIP_QUERY_KEYS,
	type ProjectInvitationNotification,
} from "./notification-center.logic";

export type AccountNotificationSource = {
	items: readonly AccountNotification[];
	unreadCount: number;
	hasMore: boolean;
	loading: boolean;
	loadingMore: boolean;
	error: Error | null;
	removingIds: ReadonlySet<string>;
	onRetry: () => void;
	onLoadMore: () => void;
	onOpen: () => void;
	onClose: () => void;
	onDelete: (notification: AccountNotification) => void;
	onOpenAction: (notification: AccountNotification) => void;
	freshIds: ReadonlySet<string>;
};

export function NotificationCenter({ account }: { account?: AccountNotificationSource }) {
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
			const joined = getAcceptedProjectInvitationToastCopy(variables.projectName);
			toast.success(joined.title, {
				description: joined.description,
				action: {
					label: copy.openProject,
					onClick: () => void router.navigate({ href: projectDetailHref(result.project_id) }),
				},
			});
		},
		onError: (error) => {
			toast.error(
				error instanceof ApiError && error.status === 410
					? copy.invitationCanceled
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
			toast.success(copy.declined);
		},
		onError: (error) => {
			toast.error(copy.declineFailed, {
				description: normalizeApiError(error),
			});
		},
	});

	const invitationItems = invitations.data ?? [];
	const attentionCount = getPendingNotificationCount(invitationItems, account?.unreadCount);
	const triggerLabel = getNotificationCenterTriggerLabel(attentionCount);
	const badge = notificationBadgeLabel(attentionCount);

	function handleOpenChange(nextOpen: boolean) {
		setOpen(nextOpen);
		if (nextOpen) account?.onOpen();
		else account?.onClose();
	}

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
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
				{badge ? (
					<span
						aria-hidden="true"
						className="-right-1 -top-1 absolute flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-semibold text-[9px] text-destructive-foreground leading-none ring-2 ring-background"
					>
						{badge}
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
						<div className={styles.rowTitleGroup}>
							<PopoverTitle className="text-base">{copy.title}</PopoverTitle>
							<PopoverDescription className="mt-0.5 text-xs">
								{getNotificationCenterDescription()}
							</PopoverDescription>
						</div>
					</div>
				</PopoverHeader>
				<NotificationCenterContent
					invitations={invitationItems}
					account={account}
					invitationsLoading={invitations.isLoading}
					invitationsError={
						shouldBlockQueryError(invitations.error, invitations.data) ? invitations.error : null
					}
					onRetryInvitations={() => invitations.refetch()}
					acceptInvitation={(invitation) =>
						accept.mutate({ id: invitation.id, projectName: invitation.project_name })
					}
					declineInvitation={(invitation) => decline.mutate(invitation.id)}
					acceptingId={accept.isPending ? accept.variables?.id : undefined}
					decliningId={decline.isPending ? decline.variables : undefined}
					onOpenAccountAction={() => handleOpenChange(false)}
				/>
			</PopoverContent>
		</Popover>
	);
}

type NotificationCenterContentProps = {
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
	const accountNotifications = account?.items ?? [];
	const hasVisibleNotifications = accountNotifications.length > 0 || invitations.length > 0;
	const hasSourceStatus =
		Boolean(account?.loading) || invitationsLoading || Boolean(account?.error || invitationsError);
	const canLoadMoreAccount = Boolean(account?.hasMore);

	return (
		<div className="max-h-[min(34rem,calc(100vh-10rem))] overflow-y-auto overscroll-contain">
			{accountNotifications.length > 0 ? (
				<NotificationSection title={copy.accountSection}>
					{accountNotifications.map((notification) => (
						<AccountNotificationRow
							key={notification.id}
							notification={notification}
							busy={account?.removingIds.has(notification.id) ?? false}
							fresh={account?.freshIds.has(notification.id) ?? false}
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
				<SourceLoading label={copy.loadingAccount} />
			) : null}
			{account?.error ? (
				<SourceError
					title={copy.accountUnavailableTitle}
					description={copy.accountUnavailableDescription}
					onRetry={account.onRetry}
				/>
			) : null}

			{invitations.length > 0 ? (
				<NotificationSection title={copy.invitationsSection}>
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
				<SourceLoading label={copy.loadingInvitations} />
			) : null}
			{invitationsError ? (
				<SourceError
					title={copy.invitationsUnavailableTitle}
					description={normalizeApiError(invitationsError)}
					onRetry={onRetryInvitations}
				/>
			) : null}

			{!hasVisibleNotifications && !hasSourceStatus && !canLoadMoreAccount ? <EmptyState /> : null}

			{canLoadMoreAccount ? (
				<div className={styles.loadMore}>
					<Button
						type="button"
						variant="ghost"
						size="xs"
						disabled={account?.loadingMore}
						onClick={account?.onLoadMore}
					>
						{account?.loadingMore ? <Spinner /> : <RefreshCw />}
						{copy.loadEarlier}
					</Button>
				</div>
			) : null}
		</div>
	);
}

function NotificationSection({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section aria-label={title}>
			<div className={styles.sectionHeader}>
				<span className={styles.sectionTitle}>{title}</span>
			</div>
			<ul className={styles.list}>{children}</ul>
		</section>
	);
}

type AccountNotificationRowProps = {
	notification: AccountNotification;
	busy: boolean;
	onDelete?: (notification: AccountNotification) => void;
	onOpenAction: (notification: AccountNotification) => void;
	fresh: boolean;
};

function AccountNotificationRow({
	notification,
	busy,
	onDelete,
	onOpenAction,
	fresh,
}: AccountNotificationRowProps) {
	const isNew = fresh || !notification.read;
	return (
		<li className={cn(styles.accountRow, isNew && styles.accountRowNew)}>
			{isNew ? <span aria-hidden="true" className={styles.newDot} /> : null}
			<div className={styles.rowLayout}>
				<IconChip size="sm" tint={styles.severityTint[notification.severity]}>
					<Bell />
				</IconChip>
				<div className={styles.rowBody}>
					<div className={styles.rowHead}>
						<div className={styles.rowTitleGroup}>
							<div
								className={cn(
									styles.accountTitle,
									isNew ? styles.accountTitleNew : styles.accountTitleRead,
								)}
							>
								{notification.title}
								{isNew ? <span className="sr-only">{copy.newSuffix}</span> : null}
							</div>
							<time
								dateTime={notification.createdAt.toISOString()}
								title={notification.createdAt.toLocaleString()}
								className={styles.time}
							>
								{formatNotificationTime(notification.createdAt)}
							</time>
						</div>
						<div className={styles.rowTrailing}>
							<Badge variant="outline">{notification.category}</Badge>
							<DropdownMenu>
								<DropdownMenuTrigger
									render={
										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											disabled={busy}
											aria-label={copy.moreActions(notification.title)}
										/>
									}
								>
									{busy ? <Spinner /> : <MoreHorizontal />}
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-44">
									<DropdownMenuItem variant="destructive" onClick={() => onDelete?.(notification)}>
										<Trash2 />
										{copy.remove}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					</div>
					<p className={styles.description}>{notification.description}</p>
					{notification.actionLabel && notification.actionUrl ? (
						<div className={styles.action}>
							<Button
								type="button"
								variant="outline"
								size="xs"
								disabled={busy}
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
		<li className={styles.invitationRow}>
			<div className={styles.rowLayout}>
				<IconChip size="sm">
					<FolderInput />
				</IconChip>
				<div className={styles.rowBody}>
					<div className={styles.rowHead}>
						<div className={styles.rowTitleGroup}>
							<div className={styles.invitationName}>{invitation.project_name}</div>
							<div className={styles.invitationMeta}>
								{copy.from(invitation.owner_display)}{" "}
								<span className={styles.invitationHandle}>@{invitation.owner_handle}</span>
								<span aria-hidden="true"> · </span>
								{formatNotificationTime(new Date(invitation.created_at))}
							</div>
						</div>
						<Badge variant="secondary">{copy.viewer}</Badge>
					</div>
					<p className={styles.description}>{getProjectInvitationAccessCopy()}</p>
					<div className={styles.invitationActions}>
						<Button
							type="button"
							size="xs"
							variant="ghost"
							onClick={() => onDecline(invitation)}
							disabled={busy}
						>
							<XCircle />
							{declining ? copy.declining : copy.decline}
						</Button>
						<Button type="button" size="xs" onClick={() => onAccept(invitation)} disabled={busy}>
							<CheckCircle2 />
							{accepting ? copy.accepting : copy.accept}
						</Button>
					</div>
				</div>
			</div>
		</li>
	);
}

function SourceLoading({ label }: { label: string }) {
	return (
		<div className={styles.sourceLoading} role="status">
			<Spinner className={styles.sourceLoadingSpinner} />
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
		<div className={styles.sourceError} role="status">
			<IconChip size="sm" tint={styles.sourceErrorTint}>
				<CircleAlert />
			</IconChip>
			<div className={styles.rowBody}>
				<div className={styles.sourceErrorTitle}>{title}</div>
				<p className={styles.sourceErrorDescription}>{description}</p>
				{onRetry ? (
					<Button
						type="button"
						size="xs"
						variant="outline"
						className={styles.sourceErrorRetry}
						onClick={onRetry}
					>
						<RefreshCw />
						{copy.retry}
					</Button>
				) : null}
			</div>
		</div>
	);
}

function EmptyState() {
	const empty = getNotificationCenterEmptyCopy();
	return (
		<div className={styles.empty}>
			<div className={styles.emptyIcon}>
				<MailOpen className={styles.emptyGlyph} />
			</div>
			<div className={styles.emptyTitle}>{empty.title}</div>
			<p className={styles.emptyDescription}>{empty.description}</p>
		</div>
	);
}
