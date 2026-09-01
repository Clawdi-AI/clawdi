"use client";

import type { DeployComponents, DeployPaths } from "@clawdi/shared/api";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import createClient from "openapi-fetch";
import { useMemo } from "react";
import { toast } from "sonner";
import { NotificationCenter } from "@/components/notification-center";
import {
	type AccountNotification,
	resolveNotificationUrl,
} from "@/components/notification-center.logic";
import { DEPLOY_API_URL, hostedApiBaseUrl, isDeployApiConfigured } from "@/hosted/access/api";
import { ApiError, normalizeApiError } from "@/lib/api-errors";
import { useDashboardAuth } from "@/lib/auth-client";

type ApiNotification = DeployComponents["schemas"]["AccountNotificationResponse"];
type NotificationPage = DeployComponents["schemas"]["AccountNotificationListResponse"];

const PAGE_SIZE = 50;
const notificationApi = createClient<DeployPaths>({
	baseUrl: hostedApiBaseUrl(DEPLOY_API_URL),
});

const accountNotificationKeys = {
	all: (userId: string) => ["hosted-account-notifications", userId] as const,
};

async function authorizationHeaders(
	getToken: () => Promise<string | null>,
): Promise<{ Authorization: string } | undefined> {
	const token = await getToken();
	return token ? { Authorization: `Bearer ${token}` } : undefined;
}

function responseError(response: Response): ApiError {
	return new ApiError(response.status, response.statusText || "Hosted notification request failed");
}

function toAccountNotification(item: ApiNotification): AccountNotification {
	return {
		id: item.id,
		title: item.title,
		description: item.description,
		category: item.category,
		createdAt: new Date(item.created_at),
		read: item.read_at != null,
		actionLabel: item.action_label ?? undefined,
		actionUrl: item.action_url ?? undefined,
		severity: item.severity,
	};
}

export function HostedNotificationCenter() {
	const { getToken, isSignedIn, userId } = useDashboardAuth();
	const queryClient = useQueryClient();
	const queryKey = accountNotificationKeys.all(userId ?? "signed-out");
	const enabled = isDeployApiConfigured() && Boolean(isSignedIn && userId);

	const notifications = useInfiniteQuery({
		queryKey,
		queryFn: async ({ pageParam, signal }): Promise<NotificationPage> => {
			const result = await notificationApi.GET("/v1/me/notifications", {
				params: {
					query: {
						limit: PAGE_SIZE,
						cursor: pageParam,
					},
				},
				headers: await authorizationHeaders(getToken),
				signal,
			});
			if (!result.response.ok || !result.data) throw responseError(result.response);
			return result.data;
		},
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
		enabled,
		staleTime: 30_000,
		refetchInterval: 60_000,
		refetchOnWindowFocus: true,
	});

	const accountNotifications = useMemo(() => {
		const unique = new Map<string, AccountNotification>();
		for (const item of notifications.data?.pages.flatMap((page) => page.items) ?? []) {
			unique.set(item.id, toAccountNotification(item));
		}
		return [...unique.values()];
	}, [notifications.data?.pages]);

	async function refreshNotifications() {
		await queryClient.invalidateQueries({ queryKey });
	}

	const updateNotification = useMutation({
		mutationFn: async ({ id, read }: { id: string; read: boolean }) => {
			const result = await notificationApi.PATCH("/v1/me/notifications/{notification_id}", {
				params: { path: { notification_id: id } },
				body: { read },
				headers: await authorizationHeaders(getToken),
			});
			if (!result.response.ok || !result.data) throw responseError(result.response);
			return result.data;
		},
		onSuccess: refreshNotifications,
		onError: (error) => {
			toast.error("Couldn't update notification", { description: normalizeApiError(error) });
		},
	});

	const deleteNotification = useMutation({
		mutationFn: async (id: string) => {
			const result = await notificationApi.DELETE("/v1/me/notifications/{notification_id}", {
				params: { path: { notification_id: id } },
				headers: await authorizationHeaders(getToken),
			});
			if (!result.response.ok) throw responseError(result.response);
		},
		onSuccess: refreshNotifications,
		onError: (error) => {
			toast.error("Couldn't remove notification", { description: normalizeApiError(error) });
		},
	});

	const markAllRead = useMutation({
		mutationFn: async () => {
			const result = await notificationApi.POST("/v1/me/notifications/read-all", {
				headers: await authorizationHeaders(getToken),
			});
			if (!result.response.ok || !result.data) throw responseError(result.response);
			return result.data;
		},
		onSuccess: refreshNotifications,
		onError: (error) => {
			toast.error("Couldn't mark notifications as read", {
				description: normalizeApiError(error),
			});
		},
	});

	const actionsDisabled =
		updateNotification.isPending || deleteNotification.isPending || markAllRead.isPending;
	const busyAccountId = updateNotification.isPending
		? updateNotification.variables?.id
		: deleteNotification.isPending
			? deleteNotification.variables
			: undefined;
	const firstPage = notifications.data?.pages[0];
	const accountError =
		notifications.error && accountNotifications.length === 0
			? notifications.error instanceof Error
				? notifications.error
				: new Error("hosted_notifications_unavailable")
			: null;

	async function openNotificationAction(notification: AccountNotification) {
		if (!notification.actionUrl) return;
		const target = resolveNotificationUrl(notification.actionUrl, window.location.origin);
		if (!target) {
			toast.error("This notification link is invalid");
			return;
		}
		if (!notification.read) {
			try {
				await updateNotification.mutateAsync({ id: notification.id, read: true });
			} catch {
				// The destination remains useful even if read-state persistence failed.
			}
		}
		window.location.assign(target.url.href);
	}

	return (
		<div data-hosted="true" className="contents">
			<NotificationCenter
				account={{
					items: accountNotifications,
					unreadCount: firstPage?.unread_count ?? 0,
					hasMore: notifications.hasNextPage,
					loading: notifications.isLoading,
					loadingMore: notifications.isFetchingNextPage,
					error: accountError,
					busyId: busyAccountId,
					actionsDisabled,
					markingAllRead: markAllRead.isPending,
					onRetry: () => void notifications.refetch(),
					onLoadMore: () => void notifications.fetchNextPage(),
					onMarkAllRead: () => markAllRead.mutate(),
					onMarkRead: (notification) =>
						updateNotification.mutate({ id: notification.id, read: true }),
					onMarkUnread: (notification) =>
						updateNotification.mutate({ id: notification.id, read: false }),
					onDelete: (notification) => deleteNotification.mutate(notification.id),
					onOpenAction: (notification) => void openNotificationAction(notification),
				}}
			/>
		</div>
	);
}

export default HostedNotificationCenter;
