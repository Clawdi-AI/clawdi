"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import type { ChannelBinding } from "@/hosted/v2/channels/channel-types";

type PairingAttempt = {
	key: string;
	initialActiveBindingIds: ReadonlySet<string>;
	completed: boolean;
};

export function activeBindingsForPairingAttempt(
	bindings: readonly ChannelBinding[],
	accountId: string,
	agentLinkId: string,
): ChannelBinding[] {
	return bindings.filter(
		(binding) =>
			binding.account_id === accountId &&
			binding.agent_link_id === agentLinkId &&
			binding.status.toLowerCase() === "active",
	);
}

export function firstNewActivePairingBinding(
	activeBindings: readonly ChannelBinding[],
	initialActiveBindingIds: ReadonlySet<string>,
): ChannelBinding | null {
	return activeBindings.find((binding) => !initialActiveBindingIds.has(binding.id)) ?? null;
}

export function pairingSuccessDescription(provider: string, binding: ChannelBinding): string {
	const chatType = binding.external_chat_type?.toLowerCase();
	if (provider === "discord") {
		return ["dm", "direct_messages", "group_dm", "private"].includes(chatType ?? "")
			? "Discord direct message is ready."
			: "Discord server is ready.";
	}
	if (provider === "telegram") {
		return chatType === "private"
			? "Telegram private chat is ready."
			: chatType === "group" || chatType === "supergroup"
				? "Telegram group is ready."
				: "Telegram chat is ready.";
	}
	return "The chat is ready.";
}

export function usePairingSuccess({
	open,
	onOpenChange,
	accountId,
	agentLinkId,
	provider,
	bindings,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accountId: string;
	agentLinkId: string;
	provider: string;
	bindings: readonly ChannelBinding[] | undefined;
}) {
	const attemptKey = `${accountId}:${agentLinkId}`;
	const activeBindings = useMemo(
		() =>
			bindings ? activeBindingsForPairingAttempt(bindings, accountId, agentLinkId) : undefined,
		[accountId, agentLinkId, bindings],
	);
	const attemptRef = useRef<PairingAttempt | null>(null);
	const openRef = useRef(open);
	openRef.current = open;
	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			openRef.current = nextOpen;
			if (!nextOpen) attemptRef.current = null;
			onOpenChange(nextOpen);
		},
		[onOpenChange],
	);

	// Snapshot before effects can interpret the same query payload as a new binding.
	// Undefined means the parent binding query has not produced its first state yet.
	if (!open) {
		attemptRef.current = null;
	} else if (activeBindings && attemptRef.current?.key !== attemptKey) {
		attemptRef.current = {
			key: attemptKey,
			initialActiveBindingIds: new Set(activeBindings.map((binding) => binding.id)),
			completed: false,
		};
	}

	useEffect(() => {
		const attempt = attemptRef.current;
		if (
			!open ||
			!openRef.current ||
			!activeBindings ||
			!attempt ||
			attempt.key !== attemptKey ||
			attempt.completed
		) {
			return;
		}
		const binding = firstNewActivePairingBinding(activeBindings, attempt.initialActiveBindingIds);
		if (!binding) return;

		// Lock before closing so a refetch or parent rerender cannot duplicate feedback.
		attempt.completed = true;
		openRef.current = false;
		onOpenChange(false);
		toast.success("Chat paired", {
			description: pairingSuccessDescription(provider, binding),
		});
	}, [activeBindings, attemptKey, onOpenChange, open, provider]);

	return handleOpenChange;
}
