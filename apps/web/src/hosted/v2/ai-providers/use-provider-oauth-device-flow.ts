"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OAuthIssue } from "@/hosted/v2/ai-providers/provider-oauth-flow";
import type { AiProviderOAuthDevicePollResponse } from "@/hosted/v2/ai-providers/types";

export type OAuthMode = "accept" | "reconnect";

export interface OAuthSession {
	mode: OAuthMode;
	providerId: string;
	state: string;
	verificationUrl: string;
	userCode: string;
	expiresAt: string;
	pollIntervalSeconds: number;
}

export function isCurrentOAuthGeneration(input: {
	stopped: boolean;
	completed: boolean;
	generation: number;
	currentGeneration: number;
}): boolean {
	return !input.stopped && !input.completed && input.generation === input.currentGeneration;
}

export function useProviderOAuthDeviceFlow({
	poll,
	onReady,
}: {
	poll: (session: OAuthSession) => Promise<AiProviderOAuthDevicePollResponse | null>;
	onReady: (session: OAuthSession) => void;
}) {
	const [session, setSession] = useState<OAuthSession | null>(null);
	const [issue, setIssue] = useState<OAuthIssue | null>(null);
	const completedRef = useRef(false);
	const generationRef = useRef(0);
	const pollRef = useRef(poll);
	const onReadyRef = useRef(onReady);
	pollRef.current = poll;
	onReadyRef.current = onReady;

	const start = useCallback((next: OAuthSession) => {
		generationRef.current += 1;
		completedRef.current = false;
		setIssue(null);
		setSession(next);
	}, []);

	const cancel = useCallback(() => {
		generationRef.current += 1;
		completedRef.current = true;
		setIssue(null);
		setSession(null);
	}, []);

	const restart = useCallback(
		async (factory: () => Promise<OAuthSession | null>) => {
			cancel();
			const next = await factory();
			if (next) start(next);
		},
		[cancel, start],
	);

	useEffect(() => {
		if (!session) return;
		const generation = generationRef.current;
		let stopped = false;
		let consecutiveFailures = 0;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		const schedule = (seconds: number) => {
			if (stopped) return;
			pollTimer = setTimeout(() => void check(), Math.max(seconds, 1) * 1000);
		};
		const check = async () => {
			if (
				!isCurrentOAuthGeneration({
					stopped,
					completed: completedRef.current,
					generation,
					currentGeneration: generationRef.current,
				})
			)
				return;
			const result = await pollRef.current(session);
			if (
				!isCurrentOAuthGeneration({
					stopped,
					completed: completedRef.current,
					generation,
					currentGeneration: generationRef.current,
				})
			)
				return;
			if (!result) {
				consecutiveFailures += 1;
				if (consecutiveFailures >= 3) {
					stopped = true;
					setIssue("failed");
				} else {
					schedule(session.pollIntervalSeconds);
				}
				return;
			}
			consecutiveFailures = 0;
			if (result.status === "pending") {
				schedule(result.retry_after_seconds);
				return;
			}
			completedRef.current = true;
			setSession(null);
			onReadyRef.current(session);
		};
		schedule(session.pollIntervalSeconds);
		const remaining = new Date(session.expiresAt).getTime() - Date.now();
		const expiry = Number.isFinite(remaining)
			? setTimeout(
					() => {
						if (
							isCurrentOAuthGeneration({
								stopped,
								completed: completedRef.current,
								generation,
								currentGeneration: generationRef.current,
							})
						) {
							stopped = true;
							setIssue("expired");
						}
					},
					Math.max(remaining, 0),
				)
			: undefined;
		return () => {
			stopped = true;
			if (pollTimer) clearTimeout(pollTimer);
			if (expiry) clearTimeout(expiry);
		};
	}, [session]);

	return { session, issue, start, cancel, restart };
}
