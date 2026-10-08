"use client";

import {
	type AccountDeletionStoreNotice,
	accountDeletionCopy,
	accountDeletionStoreNotice,
	accountDeletionStoreNoticeCopy,
} from "@clawdi/shared/view";
import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { ComputeSubscriptionListItem } from "@/hosted/billing/contracts";
import { useSubscriptions } from "@/hosted/billing/hooks";

type SubscriptionPages = { pages: readonly { items?: ComputeSubscriptionListItem[] }[] };

/** Notice state from the subscriptions query; a failed or partial list stays generic. */
export function accountDeletionNoticeFromSubscriptions({
	data,
	hasNextPage,
	isFetchNextPageError,
}: {
	data: SubscriptionPages | undefined;
	hasNextPage: boolean;
	isFetchNextPageError: boolean;
}): AccountDeletionStoreNotice {
	const rows = data ? data.pages.flatMap((page) => page.items ?? []) : null;
	return accountDeletionStoreNotice(rows, !hasNextPage && !isFetchNextPageError);
}

/**
 * Reads the account's subscriptions (the same query as Billing) and keeps loading pages
 * until a renewable store subscription is found or the list is complete.
 */
export function useAccountDeletionStoreNotice(): AccountDeletionStoreNotice {
	const subscriptions = useSubscriptions();
	const notice = accountDeletionNoticeFromSubscriptions(subscriptions);
	const { fetchNextPage } = subscriptions;
	const loadMore =
		notice.kind === "generic" &&
		subscriptions.hasNextPage &&
		!subscriptions.isFetchingNextPage &&
		!subscriptions.isFetchNextPageError;
	useEffect(() => {
		if (loadMore) void fetchNextPage();
	}, [fetchNextPage, loadMore]);
	return notice;
}

/** Store billing continues after deletion; Web names the store but links to no store page. */
export function AccountDeletionStoreNoticeAlert({
	notice,
}: {
	notice: AccountDeletionStoreNotice;
}) {
	if (notice.kind === "none") return null;
	const copy =
		notice.kind === "store"
			? accountDeletionStoreNoticeCopy(notice.management.provider)
			: {
					title: accountDeletionCopy.storeNoticeTitle,
					description: accountDeletionCopy.storeNotice,
				};
	return (
		<Alert variant="destructive" data-store-notice={notice.kind}>
			<TriangleAlert />
			<AlertTitle>{copy.title}</AlertTitle>
			<AlertDescription>{copy.description}</AlertDescription>
		</Alert>
	);
}
