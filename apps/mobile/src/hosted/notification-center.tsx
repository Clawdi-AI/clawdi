import {
	ACCOUNT_NOTIFICATIONS_PAGE_SIZE,
	type AccountNotification,
	type AccountNotificationPage,
	accountNotificationsFromPages,
	markNotificationPagesSeen,
	notificationCenterCopy,
	notificationToMarkSeen,
	removeNotificationFromPages,
	unreadNotificationIds,
} from "@clawdi/shared/view";
import {
	type InfiniteData,
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { type Href, router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMobileApi } from "@/lib/api-provider";
import { useMobileRuntimeConfig } from "@/lib/config/runtime";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { incomingVaultLink, notificationActionTarget } from "@/platform/incoming-link";
import { openBrowserLink } from "@/platform/native-intent";

type NotificationQueryData = InfiniteData<AccountNotificationPage, string | null>;

/** A failure Web reports as a toast; mobile shows it above the list. */
export type AccountNotificationNotice = { title: string; error?: unknown };

export type AccountNotificationSource = {
	items: readonly AccountNotification[];
	unreadCount: number;
	hasMore: boolean;
	loading: boolean;
	loadingMore: boolean;
	refreshing: boolean;
	error: unknown;
	notice: AccountNotificationNotice | null;
	removingIds: ReadonlySet<string>;
	freshIds: ReadonlySet<string>;
	onRefresh: () => void;
	onLoadMore: () => void;
	onDelete: (notification: AccountNotification) => void;
	onOpenAction: (notification: AccountNotification) => void;
};

/** Web HostedNotificationCenter's query: newest first, polled while the app is in the foreground. */
export function useAccountNotifications() {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	return useInfiniteQuery({
		queryKey: accountQueryKey(scope, "account-notifications"),
		queryFn: ({ pageParam, signal }) =>
			read((lease) => {
				if (!compute) throw new Error("Hosted account service unavailable");
				return compute.listNotifications(
					{ limit: ACCOUNT_NOTIFICATIONS_PAGE_SIZE, cursor: pageParam },
					lease,
				);
			}, signal),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
		enabled: scope.isReady && Boolean(compute),
		staleTime: 30_000,
		refetchInterval: 60_000,
		refetchOnWindowFocus: true,
	});
}

/**
 * Web's open-center semantics: while the center is open and settled on unread items, everything up
 * to the newest item is marked read once (`read-all` with `up_to_id`); those items stay highlighted
 * as new until the center closes.
 */
export function useAccountNotificationCenter(open: boolean): AccountNotificationSource | null {
	const { compute } = useMobileApi();
	const scope = useAccountScope();
	const read = useAccountRead();
	const config = useMobileRuntimeConfig();
	const cache = useQueryClient();
	const notifications = useAccountNotifications();
	const queryKey = accountQueryKey(scope, "account-notifications");
	const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(() => new Set());
	const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(() => new Set());
	const [notice, setNotice] = useState<AccountNotificationNotice | null>(null);
	const lastMarkedNewestId = useRef<string | null>(null);

	const markSeen = useMutation({
		mutationFn: (upToId: string) =>
			read((lease) => {
				if (!compute) throw new Error("Hosted account service unavailable");
				return compute.markNotificationsRead(upToId, lease);
			}, scope.signal),
		onMutate: async () => {
			await cache.cancelQueries({ queryKey });
			const previous = cache.getQueryData<NotificationQueryData>(queryKey);
			if (previous) {
				cache.setQueryData<NotificationQueryData>(queryKey, {
					pages: markNotificationPagesSeen(previous.pages, new Date().toISOString()),
					pageParams: previous.pageParams,
				});
			}
			return { previous };
		},
		onError: (_error, _upToId, context) => {
			if (context?.previous) cache.setQueryData(queryKey, context.previous);
		},
		onSettled: () => void cache.invalidateQueries({ queryKey }),
	});

	const deleteNotification = useMutation({
		mutationFn: (id: string) =>
			read((lease) => {
				if (!compute) throw new Error("Hosted account service unavailable");
				return compute.deleteNotification(id, lease);
			}, scope.signal),
		onMutate: async (id) => {
			setNotice(null);
			setRemovingIds((current) => new Set(current).add(id));
			await cache.cancelQueries({ queryKey });
			const previous = cache.getQueryData<NotificationQueryData>(queryKey);
			if (previous) {
				cache.setQueryData<NotificationQueryData>(queryKey, {
					pages: removeNotificationFromPages(previous.pages, id),
					pageParams: previous.pageParams,
				});
			}
			return { previous };
		},
		onError: (error, _id, context) => {
			if (context?.previous) cache.setQueryData(queryKey, context.previous);
			setNotice({ title: notificationCenterCopy.removeFailed, error });
		},
		onSettled: (_data, _error, id) => {
			setRemovingIds((current) => {
				const next = new Set(current);
				next.delete(id);
				return next;
			});
			void cache.invalidateQueries({ queryKey });
		},
	});

	const pages = notifications.data?.pages;
	const firstPage = pages?.[0];
	const { isLoading, isFetching, error } = notifications;
	const { mutate: markSeenUpTo } = markSeen;

	useEffect(() => {
		if (!open) {
			lastMarkedNewestId.current = null;
			setFreshIds(new Set());
			return;
		}
		if (isLoading || isFetching || error) return;
		const newestId = notificationToMarkSeen(firstPage, lastMarkedNewestId.current);
		if (!newestId) return;
		lastMarkedNewestId.current = newestId;
		setFreshIds((current) => new Set([...current, ...unreadNotificationIds(pages)]));
		markSeenUpTo(newestId);
	}, [error, firstPage, isFetching, isLoading, markSeenUpTo, open, pages]);

	const items = useMemo(() => accountNotificationsFromPages(pages), [pages]);
	if (!compute) return null;

	const openAction = async (notification: AccountNotification) => {
		if (!notification.actionUrl) return;
		setNotice(null);
		const target = notificationActionTarget(
			notification.actionUrl,
			config.ok ? (config.value.linkHosts ?? []) : [],
			(link) => incomingVaultLink.stage(randomUUID(), link),
		);
		if (!target) {
			setNotice({ title: notificationCenterCopy.invalidLink });
			return;
		}
		try {
			if (target.kind === "route") router.push(target.href as Href);
			else await openBrowserLink(target.url);
		} catch {
			setNotice({ title: notificationCenterCopy.openFailed });
		}
	};

	return {
		items,
		unreadCount: firstPage?.unread_count ?? 0,
		hasMore: notifications.hasNextPage,
		loading: notifications.isLoading,
		loadingMore: notifications.isFetchingNextPage,
		refreshing: notifications.isRefetching && !notifications.isFetchingNextPage,
		// Web keeps showing loaded items when a background refresh fails.
		error: items.length === 0 ? notifications.error : null,
		notice,
		removingIds,
		freshIds,
		onRefresh: () => void notifications.refetch(),
		onLoadMore: () => void notifications.fetchNextPage(),
		onDelete: (notification) => deleteNotification.mutate(notification.id),
		onOpenAction: (notification) => void openAction(notification),
	};
}
