import { ApiClientError, type components } from "@clawdi/shared/api";
import { notificationCenterClasses as styles } from "@clawdi/shared/ui";
import {
	type AccountNotification,
	notificationCenterCopy as copy,
	formatNotificationTime,
	getAcceptedProjectInvitationToastCopy,
	getNotificationCenterDescription,
	getNotificationCenterEmptyCopy,
	getNotificationCenterTriggerLabel,
	getPendingNotificationCount,
	getProjectInvitationAccessCopy,
	notificationBadgeLabel,
	projectDetailHref,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import { type Href, router, useFocusEffect } from "expo-router";
import Bell from "lucide-react-native/icons/bell";
import CircleAlert from "lucide-react-native/icons/circle-alert";
import CheckCircle2 from "lucide-react-native/icons/circle-check";
import XCircle from "lucide-react-native/icons/circle-x";
import MoreHorizontal from "lucide-react-native/icons/ellipsis";
import ExternalLink from "lucide-react-native/icons/external-link";
import FolderInput from "lucide-react-native/icons/folder-input";
import MailOpen from "lucide-react-native/icons/mail-open";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import { type ReactElement, useCallback, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { IconChip } from "@/components/icon-chip";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { NativeList } from "@/components/ui/native-list";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { WebIcon, WebText, WebView } from "@/components/ui/web-layout";
import { usePullRefresh } from "@/hooks/use-pull-refresh";
import {
	type AccountNotificationSource,
	useAccountNotificationCenter,
	useAccountNotifications,
} from "@/hosted/notification-center";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeHeader } from "@/platform/navigation/native-header";
import type { HeaderAction } from "@/platform/navigation/native-header-types";
import { SafeAreaScreen } from "@/platform/safe-area-screen";

type Invitation = components["schemas"]["InvitationResponse"];

const bellIcon = require("../../assets/icons/notifications.xml");

/** Shared with the Projects invitations sheet, so both read one cache entry. */
function useReceivedInvitations() {
	const scope = useAccountScope();
	const read = useAccountRead();
	const { sharing } = useMobileApi();
	return useQuery({
		queryKey: accountQueryKey(scope, "received-invitations"),
		queryFn: ({ signal }) =>
			read((requestSignal) => sharing.listReceivedInvitations(requestSignal), signal),
		enabled: scope.isReady,
		retry: false,
		refetchOnWindowFocus: true,
	});
}

/** Web's header bell: invitations plus unread account updates, as a native header action. */
export function useNotificationBell(): HeaderAction {
	const invitations = useReceivedInvitations();
	const account = useAccountNotifications();
	const count = getPendingNotificationCount(
		invitations.data,
		account.data?.pages[0]?.unread_count ?? 0,
	);
	return {
		id: "notifications",
		label: getNotificationCenterTriggerLabel(count),
		icon: { ios: "bell", android: bellIcon },
		badge: notificationBadgeLabel(count),
		// `navigate` reuses the focused route, so a double tap cannot stack two inboxes.
		onPress: () => router.navigate("/notifications"),
	};
}

type Row =
	| { key: string; kind: "section"; title: string }
	| { key: string; kind: "account"; notification: AccountNotification }
	| { key: string; kind: "invitation"; invitation: Invitation }
	| { key: string; kind: "status"; element: ReactElement };

type InvitationNotice =
	| { kind: "joined"; projectId: string; projectName: string }
	| { kind: "declined" }
	| { kind: "canceled" }
	| { kind: "failed"; title?: string; error: unknown };

/** Web NotificationCenter's popover content as a pushed native screen; focus is "open". */
export function NotificationCenterScreen() {
	const scope = useAccountScope();
	return <NotificationCenter key={`${scope.identity}:${scope.generation}`} />;
}

function NotificationCenter() {
	const [open, setOpen] = useState(false);
	useFocusEffect(
		useCallback(() => {
			setOpen(true);
			return () => setOpen(false);
		}, []),
	);
	const scope = useAccountScope();
	const read = useAccountRead();
	const cache = useQueryClient();
	const { sharing } = useMobileApi();
	const invitations = useReceivedInvitations();
	const account = useAccountNotificationCenter(open);
	const pull = usePullRefresh(() => Promise.all([account?.refresh(), invitations.refetch()]));
	const action = useAuthAction(scope);
	const [responding, setResponding] = useState<{ id: string; accept: boolean } | null>(null);
	const [invitationNotice, setInvitationNotice] = useState<InvitationNotice | null>(null);

	const sendResponse = async (
		invitation: Invitation,
		accept: boolean,
		signal: AbortSignal,
	): Promise<InvitationNotice> => {
		if (accept) {
			const joined = await read(
				(requestSignal) => sharing.acceptInvitation(invitation.id, requestSignal),
				signal,
			);
			return { kind: "joined", projectId: joined.project_id, projectName: invitation.project_name };
		}
		await read((requestSignal) => sharing.declineInvitation(invitation.id, requestSignal), signal);
		return { kind: "declined" };
	};

	const respond = (invitation: Invitation, accept: boolean) => {
		const signal = scope.signal;
		setInvitationNotice(null);
		setResponding({ id: invitation.id, accept });
		void action
			.run(async (current) => {
				try {
					const notice = await sendResponse(invitation, accept, signal);
					if (!current()) return;
					await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
					setInvitationNotice(notice);
				} catch (error) {
					if (!current()) return;
					setInvitationNotice(
						accept && error instanceof ApiClientError && error.status === 410
							? { kind: "canceled" }
							: { kind: "failed", title: accept ? undefined : copy.declineFailed, error },
					);
				}
			})
			.finally(() => setResponding(null));
	};

	const invitationItems = invitations.data ?? [];
	const accountItems = account?.items ?? [];
	const rows: Row[] = [];
	if (accountItems.length > 0) {
		rows.push({ key: "account-section", kind: "section", title: copy.accountSection });
		for (const notification of accountItems)
			rows.push({ key: `account-${notification.id}`, kind: "account", notification });
	}
	if (account?.loading && accountItems.length === 0)
		rows.push({
			key: "account-loading",
			kind: "status",
			element: <SourceLoading label={copy.loadingAccount} />,
		});
	if (account?.error)
		rows.push({
			key: "account-error",
			kind: "status",
			element: (
				<SourceError
					title={copy.accountUnavailableTitle}
					description={copy.accountUnavailableDescription}
					onRetry={() => void account.refresh()}
				/>
			),
		});
	if (invitationItems.length > 0) {
		rows.push({ key: "invitation-section", kind: "section", title: copy.invitationsSection });
		for (const invitation of invitationItems)
			rows.push({ key: `invitation-${invitation.id}`, kind: "invitation", invitation });
	}
	if (invitations.isLoading && invitationItems.length === 0)
		rows.push({
			key: "invitation-loading",
			kind: "status",
			element: <SourceLoading label={copy.loadingInvitations} />,
		});
	const invitationsError = invitations.data ? null : invitations.error;
	if (invitationsError)
		rows.push({
			key: "invitation-error",
			kind: "status",
			element: (
				<AppView className="px-4 py-4">
					<ApiErrorPanel
						title={copy.invitationsUnavailableTitle}
						error={invitationsError}
						onRetry={() => void invitations.refetch()}
					/>
				</AppView>
			),
		});

	const renderRow = ({ item }: { item: Row }) => {
		switch (item.kind) {
			case "section":
				return (
					<WebView recipe={styles.sectionHeader} accessibilityRole="header">
						<WebText recipe={styles.sectionTitle}>{item.title}</WebText>
					</WebView>
				);
			case "account":
				return account ? (
					<AccountNotificationRow
						notification={item.notification}
						busy={account.removingIds.has(item.notification.id)}
						fresh={account.freshIds.has(item.notification.id)}
						onDelete={account.onDelete}
						onOpenAction={account.onOpenAction}
					/>
				) : null;
			case "invitation":
				return (
					<ProjectInvitationRow
						invitation={item.invitation}
						accepting={responding?.id === item.invitation.id && responding.accept}
						declining={responding?.id === item.invitation.id && !responding.accept}
						disabled={action.busy}
						onAccept={(invitation) => respond(invitation, true)}
						onDecline={(invitation) => respond(invitation, false)}
					/>
				);
			case "status":
				return item.element;
		}
	};

	return (
		<SafeAreaScreen testID="notification-center-screen">
			<NativeHeader title={copy.title} />
			<NativeList
				data={rows}
				keyExtractor={(row) => row.key}
				renderItem={renderRow}
				// Web's `divide-y`; section headers draw their own bottom border.
				ItemSeparatorComponent={({ leadingItem }: { leadingItem: Row }) =>
					leadingItem.kind === "section" ? null : <AppView className="h-px bg-border" />
				}
				contentContainerStyle={{ gap: 0, paddingHorizontal: 0 }}
				refreshing={pull.refreshing}
				onRefresh={pull.onRefresh}
				header={
					<AppView className="gap-3 px-4 pb-3">
						<Text className="text-sm text-muted-foreground">
							{getNotificationCenterDescription()}
						</Text>
						{account?.notice ? (
							account.notice.error ? (
								<ApiErrorPanel title={account.notice.title} error={account.notice.error} />
							) : (
								<Alert variant="destructive" icon={CircleAlert} title={account.notice.title} />
							)
						) : null}
						<InvitationNoticeView notice={invitationNotice} />
					</AppView>
				}
				empty={
					!account?.loading && !invitations.isLoading && !account?.hasMore ? <EmptyState /> : null
				}
				footer={
					account?.hasMore ? (
						<WebView recipe={styles.loadMore}>
							<Button
								variant="ghost"
								size="xs"
								disabled={account.loadingMore}
								onPress={account.onLoadMore}
							>
								{account.loadingMore ? <Spinner /> : <Icon as={RefreshCw} />}
								<Text>{copy.loadEarlier}</Text>
							</Button>
						</WebView>
					) : null
				}
			/>
		</SafeAreaScreen>
	);
}

function InvitationNoticeView({ notice }: { notice: InvitationNotice | null }) {
	if (!notice) return null;
	if (notice.kind === "canceled")
		return <Alert variant="destructive" icon={CircleAlert} title={copy.invitationCanceled} />;
	if (notice.kind === "failed") return <ApiErrorPanel title={notice.title} error={notice.error} />;
	if (notice.kind === "declined") return <Alert icon={CheckCircle2} title={copy.declined} />;
	const joined = getAcceptedProjectInvitationToastCopy(notice.projectName);
	return (
		<Alert icon={CheckCircle2} title={joined.title}>
			<AppView className="items-start gap-2">
				<Text>{joined.description}</Text>
				<Button
					size="xs"
					variant="outline"
					onPress={() => router.push(projectDetailHref(notice.projectId) as Href)}
				>
					<Text>{copy.openProject}</Text>
				</Button>
			</AppView>
		</Alert>
	);
}

function AccountNotificationRow({
	notification,
	busy,
	fresh,
	onDelete,
	onOpenAction,
}: {
	notification: AccountNotification;
	busy: boolean;
	fresh: boolean;
	onDelete: AccountNotificationSource["onDelete"];
	onOpenAction: AccountNotificationSource["onOpenAction"];
}) {
	const isNew = fresh || !notification.read;
	return (
		<WebView
			recipe={cn(styles.accountRow, isNew && styles.accountRowNew)}
			testID={`notification-${notification.id}`}
		>
			{isNew ? <WebView recipe={styles.newDot} /> : null}
			<WebView recipe={styles.rowLayout}>
				<IconChip size="sm" tint={styles.severityTint[notification.severity]}>
					<Icon as={Bell} />
				</IconChip>
				<WebView recipe={styles.rowBody}>
					<WebView recipe={styles.rowHead}>
						<WebView recipe={styles.rowTitleGroup}>
							<WebText
								recipe={cn(
									styles.accountTitle,
									isNew ? styles.accountTitleNew : styles.accountTitleRead,
								)}
								accessibilityLabel={`${notification.title}${isNew ? copy.newSuffix : ""}`}
							>
								{notification.title}
							</WebText>
							<WebText recipe={styles.time}>
								{formatNotificationTime(notification.createdAt)}
							</WebText>
						</WebView>
						<WebView recipe={styles.rowTrailing}>
							<Badge variant="outline">
								<Text>{notification.category}</Text>
							</Badge>
							<DropdownMenu>
								<DropdownMenuTrigger
									disabled={busy}
									render={
										<Button
											variant="ghost"
											size="icon-xs"
											disabled={busy}
											accessibilityLabel={copy.moreActions(notification.title)}
										>
											{busy ? <Spinner /> : <Icon as={MoreHorizontal} />}
										</Button>
									}
								/>
								<DropdownMenuContent>
									<DropdownMenuItem
										label={copy.remove}
										variant="destructive"
										onSelect={() => onDelete(notification)}
									/>
								</DropdownMenuContent>
							</DropdownMenu>
						</WebView>
					</WebView>
					<WebText recipe={styles.description}>{notification.description}</WebText>
					{notification.actionLabel && notification.actionUrl ? (
						<WebView recipe={styles.action} className="items-start">
							<Button
								variant="outline"
								size="xs"
								disabled={busy}
								onPress={() => onOpenAction(notification)}
							>
								<Icon as={ExternalLink} />
								<Text>{notification.actionLabel}</Text>
							</Button>
						</WebView>
					) : null}
				</WebView>
			</WebView>
		</WebView>
	);
}

function ProjectInvitationRow({
	invitation,
	accepting,
	declining,
	disabled,
	onAccept,
	onDecline,
}: {
	invitation: Invitation;
	accepting: boolean;
	declining: boolean;
	disabled: boolean;
	onAccept: (invitation: Invitation) => void;
	onDecline: (invitation: Invitation) => void;
}) {
	const busy = accepting || declining || disabled;
	return (
		<WebView recipe={styles.invitationRow} testID={`invitation-${invitation.id}`}>
			<WebView recipe={styles.rowLayout}>
				<IconChip size="sm">
					<Icon as={FolderInput} />
				</IconChip>
				<WebView recipe={styles.rowBody}>
					<WebView recipe={styles.rowHead}>
						<WebView recipe={styles.rowTitleGroup}>
							<WebText recipe={styles.invitationName} numberOfLines={1}>
								{invitation.project_name}
							</WebText>
							<WebText recipe={styles.invitationMeta}>
								{copy.from(invitation.owner_display)}{" "}
								<WebText recipe={styles.invitationHandle}>@{invitation.owner_handle}</WebText>
								{" · "}
								{formatNotificationTime(new Date(invitation.created_at))}
							</WebText>
						</WebView>
						<Badge variant="secondary">
							<Text>{copy.viewer}</Text>
						</Badge>
					</WebView>
					<WebText recipe={styles.description}>{getProjectInvitationAccessCopy()}</WebText>
					<WebView recipe={styles.invitationActions}>
						<Button size="xs" variant="ghost" onPress={() => onDecline(invitation)} disabled={busy}>
							<Icon as={XCircle} />
							<Text>{declining ? copy.declining : copy.decline}</Text>
						</Button>
						<Button size="xs" onPress={() => onAccept(invitation)} disabled={busy}>
							<Icon as={CheckCircle2} />
							<Text>{accepting ? copy.accepting : copy.accept}</Text>
						</Button>
					</WebView>
				</WebView>
			</WebView>
		</WebView>
	);
}

function SourceLoading({ label }: { label: string }) {
	return (
		<WebView recipe={styles.sourceLoading} accessibilityRole="progressbar">
			<Spinner label={label} />
			<Text>{label}</Text>
		</WebView>
	);
}

function SourceError({
	title,
	description,
	onRetry,
}: {
	title: string;
	description: string;
	onRetry: () => void;
}) {
	return (
		<WebView recipe={styles.sourceError} accessibilityRole="alert">
			<IconChip size="sm" tint={styles.sourceErrorTint}>
				<Icon as={CircleAlert} />
			</IconChip>
			<WebView recipe={styles.rowBody}>
				<WebText recipe={styles.sourceErrorTitle}>{title}</WebText>
				<WebText recipe={styles.sourceErrorDescription}>{description}</WebText>
				<WebView recipe={styles.sourceErrorRetry}>
					<Button size="xs" variant="outline" onPress={onRetry}>
						<Icon as={RefreshCw} />
						<Text>{copy.retry}</Text>
					</Button>
				</WebView>
			</WebView>
		</WebView>
	);
}

function EmptyState() {
	const empty = getNotificationCenterEmptyCopy();
	return (
		<WebView recipe={styles.empty}>
			<WebView recipe={styles.emptyIcon}>
				<WebIcon as={MailOpen} recipe={styles.emptyGlyph} />
			</WebView>
			<WebText recipe={styles.emptyTitle}>{empty.title}</WebText>
			<WebText recipe={styles.emptyDescription}>{empty.description}</WebText>
		</WebView>
	);
}
