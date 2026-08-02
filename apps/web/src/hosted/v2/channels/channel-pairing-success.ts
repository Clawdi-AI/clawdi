"use client";

import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";

type PairingAttempt = {
	key: string;
	baselineBindingCount: number;
	completed: boolean;
};

export function pairingCountIncreased(bindingCount: number, baselineBindingCount: number): boolean {
	return bindingCount > baselineBindingCount;
}

export function pairingSuccessDescription(provider: string): string {
	if (provider === "discord") {
		return "Discord chat is ready.";
	}
	if (provider === "telegram") {
		return "Telegram chat is ready.";
	}
	return "The chat is ready.";
}

export function usePairingSuccess({
	open,
	onOpenChange,
	accountId,
	agentLinkId,
	provider,
	bindingCount,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	accountId: string;
	agentLinkId: string;
	provider: string;
	bindingCount: number;
}) {
	const attemptKey = `${accountId}:${agentLinkId}`;
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

	// Every open session snapshots the latest aggregate for this exact link. Closing
	// clears the attempt so a later reopen cannot reuse an older baseline.
	if (!open) {
		attemptRef.current = null;
	} else if (attemptRef.current?.key !== attemptKey) {
		attemptRef.current = {
			key: attemptKey,
			baselineBindingCount: bindingCount,
			completed: false,
		};
	}

	useEffect(() => {
		const attempt = attemptRef.current;
		if (!open || !openRef.current || !attempt || attempt.key !== attemptKey || attempt.completed) {
			return;
		}
		if (!pairingCountIncreased(bindingCount, attempt.baselineBindingCount)) return;

		// Lock before closing so a refetch or parent rerender cannot duplicate feedback.
		attempt.completed = true;
		openRef.current = false;
		onOpenChange(false);
		toast.success("Chat paired", {
			description: pairingSuccessDescription(provider),
		});
	}, [attemptKey, bindingCount, onOpenChange, open, provider]);

	return handleOpenChange;
}
