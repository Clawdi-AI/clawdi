"use client";

import type { DeployComponents, DeployPaths } from "@clawdi/shared/api";
import {
	type InfiniteData,
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import createClient from "openapi-fetch";
import { useEffect, useMemo, useRef, useState } from "react";
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
type NotificationQueryData = InfiniteData<NotificationPage, string | null>;

const PAGE_SIZE = 50;
const notificationApi = createClient<DeployPaths>({
	baseUrl: hostedApiBaseUrl(DEPLOY_API_URL),
});

const accountNotificationKeys = {
	all: (userId: string) => ["hosted-account-notifications", userId] as const,
};

function responseError(response: Response): ApiError {
	return new ApiError(response.status, response.statusText || "Notification request failed");
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
	const router = useRouter();
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
				headers: { Authorization: `Bearer ${await getToken()}` },
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

	const [popoverOpen, setPopoverOpen] = useState(false);
	const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(() => new Set());
	const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(() => new Set());
	const lastMarkedNewestId = useRef<string | null>(null);

	const markSeen = useMutation({
		mutationFn: async ({ upToId }: { upToId: string }) => {
			const result = await notificationApi.POST("/v1/me/notifications/read-all", {
				body: { up_to_id: upToId },
				headers: { Authorization: `Bearer ${await getToken()}` },
			});
			if (!result.response.ok || !result.data) throw responseError(result.response);
			return result.data;
		},
		onMutate: async () => {
			await queryClient.cancelQueries({ queryKey });
			const previous = queryClient.getQueryData<NotificationQueryData>(queryKey);
			if (!previous) return { previous };

			const readAt = new Date().toISOString();
			const pages = previous.pages.map((page) => ({
				...page,
				items: page.items.map((item) => {
					if (item.read_at != null) return item;
					return { ...item, read_at: readAt };
				}),
			}));
			const optimistic = {
				pages: pages.map((page) => ({
					...page,
					unread_count: 0,
				})),
				pageParams: previous.pageParams,
			};
			queryClient.setQueryData(queryKey, optimistic);
			return { previous };
		},
		onError: (_error, _variables, context) => {
			if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
		},
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey });
		},
	});

	const deleteNotification = useMutation({
		mutationFn: async (id: string) => {
			const result = await notificationApi.DELETE("/v1/me/notifications/{notification_id}", {
				params: { path: { notification_id: id } },
				headers: { Authorization: `Bearer ${await getToken()}` },
			});
			if (!result.response.ok) throw responseError(result.response);
		},
		onMutate: async (id) => {
			setRemovingIds((current) => new Set(current).add(id));
			await queryClient.cancelQueries({ queryKey });
			const previous = queryClient.getQueryData<NotificationQueryData>(queryKey);
			if (!previous) return { previous };

			let wasUnread = false;
			const pages = previous.pages.map((page) => {
				const item = page.items.find((notification) => notification.id === id);
				const removedUnread = item !== undefined && item.read_at == null;
				if (removedUnread) wasUnread = true;
				return {
					...page,
					items: page.items.filter((notification) => notification.id !== id),
				};
			});
			const optimistic = {
				pages: wasUnread
					? pages.map((page) => ({
							...page,
							unread_count: Math.max(0, page.unread_count - 1),
						}))
					: pages,
				pageParams: previous.pageParams,
			};
			queryClient.setQueryData(queryKey, optimistic);
			return {
				previous,
			};
		},
		onError: (error, _id, context) => {
			if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
			toast.error("Couldn't remove notification", { description: normalizeApiError(error) });
		},
		onSettled: (_data, _error, id) => {
			setRemovingIds((current) => {
				const next = new Set(current);
				next.delete(id);
				return next;
			});
			void queryClient.invalidateQueries({ queryKey });
		},
	});

	const firstPage = notifications.data?.pages[0];

	useEffect(() => {
		if (!popoverOpen) return;
		if (notifications.isLoading || notifications.isFetching || notifications.error) return;
		if (!firstPage || firstPage.unread_count <= 0 || firstPage.items.length === 0) return;
		const newest = firstPage.items[0];
		if (lastMarkedNewestId.current === newest.id) return;
		lastMarkedNewestId.current = newest.id;
		setFreshIds((current) => {
			const next = new Set(current);
			for (const item of notifications.data?.pages.flatMap((page) => page.items) ?? []) {
				if (item.read_at == null) next.add(item.id);
			}
			return next;
		});
		markSeen.mutate({ upToId: newest.id });
	}, [
		firstPage,
		markSeen,
		notifications.data?.pages,
		notifications.error,
		notifications.isFetching,
		notifications.isLoading,
		popoverOpen,
	]);

	function handleOpen() {
		lastMarkedNewestId.current = null;
		setFreshIds(new Set());
		setPopoverOpen(true);
	}

	function handleClose() {
		setPopoverOpen(false);
		lastMarkedNewestId.current = null;
		setFreshIds(new Set());
	}
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
		try {
			if (target.kind === "same-origin") {
				const { pathname, search, hash } = target.url;
				await router.navigate({ href: `${pathname}${search}${hash}` });
			} else {
				window.location.assign(target.url.href);
			}
		} catch {
			toast.error("Couldn't open notification link");
		}
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
					removingIds,
					onRetry: () => void notifications.refetch(),
					onLoadMore: () => void notifications.fetchNextPage(),
					onDelete: (notification) => deleteNotification.mutate(notification.id),
					onOpenAction: (notification) => void openNotificationAction(notification),
					onOpen: handleOpen,
					onClose: handleClose,
					freshIds,
				}}
			/>
		</div>
	);
}

export default HostedNotificationCenter;
