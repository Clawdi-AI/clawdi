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
	const pollRef = useRef(poll);
	const onReadyRef = useRef(onReady);
	pollRef.current = poll;
	onReadyRef.current = onReady;

	const start = useCallback((next: OAuthSession) => {
		completedRef.current = false;
		setIssue(null);
		setSession(next);
	}, []);

	const cancel = useCallback(() => {
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
		let stopped = false;
		let consecutiveFailures = 0;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		const schedule = (seconds: number) => {
			if (stopped) return;
			pollTimer = setTimeout(() => void check(), Math.max(seconds, 1) * 1000);
		};
		const check = async () => {
			if (stopped || completedRef.current) return;
			const result = await pollRef.current(session);
			if (stopped) return;
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
						if (!completedRef.current) {
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
