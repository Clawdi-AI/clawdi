"use client";

import type { InboxAPI } from "@customerio/cdp-analytics-browser";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { NotificationCenter } from "@/components/notification-center";
import type { InboxNotification } from "@/components/notification-center.logic";
import { useHostedProductAccessProfileQuery } from "@/hosted/access/product-access";
import type { HostedCustomerIOIdentity, InboxMessage } from "@/hosted/customerio";
import {
	getHostedCustomerIOInbox,
	isCanonicalHostedCustomerId,
	resolveHostedNotificationUrl,
} from "@/hosted/customerio";
import { useDashboardAuth } from "@/lib/auth-client";

type CustomerIOInboxItem = InboxNotification & {
	actionUrl: string | null;
	message: InboxMessage;
};

export function CustomerIONotificationCenter() {
	const { isSignedIn } = useDashboardAuth();
	const profile = useHostedProductAccessProfileQuery();
	const [messages, setMessages] = useState<InboxMessage[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const [busyId, setBusyId] = useState<string>();
	const [retryKey, setRetryKey] = useState(0);
	const inboxRef = useRef<InboxAPI | null>(null);

	const customerId = profile.data?.id ?? null;
	const identity = useMemo<HostedCustomerIOIdentity | null>(() => {
		if (!isSignedIn || !isCanonicalHostedCustomerId(customerId)) return null;
		return { customerId };
	}, [customerId, isSignedIn]);
	const identityLoading = Boolean(isSignedIn && profile.isLoading);
	const identityError =
		isSignedIn && profile.error ? new Error("hosted_identity_unavailable") : null;

	useEffect(() => {
		let active = true;
		let unsubscribe: (() => void) | undefined;
		inboxRef.current = null;
		setMessages([]);
		setError(null);

		if (!identity) {
			setLoading(false);
			return;
		}

		setLoading(true);
		void getHostedCustomerIOInbox(identity)
			.then(async (inbox) => {
				if (!active || !inbox) return;
				inboxRef.current = inbox;
				const initialMessages = await inbox.messages();
				if (!active) return;
				setMessages(initialMessages);
				unsubscribe = inbox.onUpdates((updatedMessages) => {
					if (active) setMessages(updatedMessages);
				});
			})
			.catch(() => {
				if (active) setError(new Error("customerio_inbox_unavailable"));
			})
			.finally(() => {
				if (active) setLoading(false);
			});

		return () => {
			active = false;
			unsubscribe?.();
		};
	}, [identity, retryKey]);

	const items = useMemo(
		() => messages.filter((message) => message.type.startsWith("v2_")).map(toInboxItem),
		[messages],
	);

	async function refreshMessages() {
		const inbox = inboxRef.current;
		if (!inbox) return;
		setMessages(await inbox.messages());
	}

	function retryInbox() {
		setRetryKey((key) => key + 1);
		if (profile.error) void profile.refetch();
	}

	async function runMessageAction(
		notification: InboxNotification,
		action: (item: CustomerIOInboxItem) => Promise<void>,
	) {
		const item = items.find((candidate) => candidate.id === notification.id);
		if (!item) return;
		setBusyId(item.id);
		try {
			await action(item);
			await refreshMessages();
		} catch {
			toast.error("Couldn't update notification");
		} finally {
			setBusyId(undefined);
		}
	}

	return (
		<div data-hosted="true" className="contents">
			<NotificationCenter
				inboxNotifications={items}
				inboxLoading={loading || identityLoading}
				inboxError={error ?? identityError}
				busyInboxId={busyId}
				onRetryInbox={retryInbox}
				onMarkInboxOpened={(notification) =>
					void runMessageAction(notification, (item) => item.message.markOpened())
				}
				onDeleteInbox={(notification) =>
					void runMessageAction(notification, (item) => item.message.markDeleted())
				}
				onOpenInboxAction={(notification) =>
					void runMessageAction(notification, async (item) => {
						if (!item.opened) await item.message.markOpened();
						item.message.trackClick(item.actionLabel);
						if (item.actionUrl) openNotificationUrl(item.actionUrl);
					})
				}
			/>
		</div>
	);
}

function toInboxItem(message: InboxMessage): CustomerIOInboxItem {
	const properties = message.properties;
	const action = parseAction(properties.cta ?? properties.messageAction, properties);
	return {
		id: message.messageId,
		title: stringProperty(properties.title) ?? "Clawdi update",
		description:
			stringProperty(properties.body) ??
			stringProperty(properties.description) ??
			"Open Clawdi for details.",
		badge: stringProperty(properties.badge) ?? badgeForMessageType(message.type),
		sentAt: message.sentAt,
		opened: message.opened,
		actionLabel: action?.label,
		actionUrl: action?.url ?? null,
		severity: severityProperty(properties.severity),
		message,
	};
}

function parseAction(
	value: unknown,
	properties: Record<string, unknown>,
): { label: string; url: string } | null {
	const action = recordProperty(value);
	const url =
		stringProperty(action?.url) ??
		stringProperty(action?.href) ??
		stringProperty(action?.action) ??
		stringProperty(properties.action_url);
	if (!url) return null;
	return {
		label:
			stringProperty(action?.label) ??
			stringProperty(action?.name) ??
			stringProperty(properties.action_label) ??
			"Open",
		url,
	};
}

function stringProperty(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordProperty(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: null;
}

function severityProperty(value: unknown): InboxNotification["severity"] {
	return value === "warning" || value === "destructive" ? value : "info";
}

function badgeForMessageType(type: string): string {
	if (type.startsWith("v2_wallet_")) return "Wallet";
	if (type.startsWith("v2_")) return "Account";
	return "Update";
}

function openNotificationUrl(value: string) {
	const target = resolveHostedNotificationUrl(value, window.location.origin);
	if (!target) {
		toast.error("This notification link is invalid");
		return;
	}
	if (target.kind === "same-origin") {
		window.location.assign(target.url);
		return;
	}
	window.open(target.url, "_blank", "noopener,noreferrer");
}

export default CustomerIONotificationCenter;
