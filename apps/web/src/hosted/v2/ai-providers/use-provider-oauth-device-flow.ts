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

export interface OAuthSessionLifecycle {
	generation: number;
	completed: boolean;
}

export function cancelOAuthSessionLifecycle(lifecycle: OAuthSessionLifecycle): void {
	lifecycle.generation += 1;
	lifecycle.completed = true;
}

export async function runOAuthSessionTransition({
	lifecycle,
	factory,
	onStart,
}: {
	lifecycle: OAuthSessionLifecycle;
	factory: () => Promise<OAuthSession | null>;
	onStart: (session: OAuthSession) => void;
}): Promise<boolean> {
	cancelOAuthSessionLifecycle(lifecycle);
	const generation = lifecycle.generation;
	const next = await factory();
	if (!next || lifecycle.generation !== generation || !lifecycle.completed) return false;
	lifecycle.completed = false;
	onStart(next);
	return true;
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
	const lifecycleRef = useRef<OAuthSessionLifecycle>({ generation: 0, completed: true });
	const pollRef = useRef(poll);
	const onReadyRef = useRef(onReady);
	pollRef.current = poll;
	onReadyRef.current = onReady;

	const cancel = useCallback(() => {
		cancelOAuthSessionLifecycle(lifecycleRef.current);
		setIssue(null);
		setSession(null);
	}, []);

	const transition = useCallback(async (factory: () => Promise<OAuthSession | null>) => {
		setIssue(null);
		setSession(null);
		await runOAuthSessionTransition({
			lifecycle: lifecycleRef.current,
			factory,
			onStart: setSession,
		});
	}, []);

	useEffect(
		() => () => {
			cancelOAuthSessionLifecycle(lifecycleRef.current);
		},
		[],
	);

	useEffect(() => {
		if (!session) return;
		const generation = lifecycleRef.current.generation;
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
					completed: lifecycleRef.current.completed,
					generation,
					currentGeneration: lifecycleRef.current.generation,
				})
			)
				return;
			const result = await pollRef.current(session);
			if (
				!isCurrentOAuthGeneration({
					stopped,
					completed: lifecycleRef.current.completed,
					generation,
					currentGeneration: lifecycleRef.current.generation,
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
			lifecycleRef.current.completed = true;
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
								completed: lifecycleRef.current.completed,
								generation,
								currentGeneration: lifecycleRef.current.generation,
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

	return { session, issue, cancel, transition };
}
