"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAccountSuspension } from "@/lib/account-suspension";
import { useAuthToken, useSessionIdentity } from "@/lib/auth-client";
import { env } from "@/lib/env";
import { consumeServerSentEvents } from "@/lib/server-sent-events";
import { observeSessionContent, parseContentVersion } from "@/lib/session-content-events";

export function useSessionContentEvents(sessionId: string) {
	const queryClient = useQueryClient();
	const { getToken } = useAuthToken();
	const identity = useSessionIdentity();
	const suspension = useAccountSuspension();

	useEffect(() => {
		if (!identity) return;
		let disposed = false;
		let active: AbortController | null = null;
		let retry: ReturnType<typeof setTimeout> | null = null;
		let attempt = 0;
		const observer = observeSessionContent(queryClient, sessionId);
		const schedule = (delay: number) => {
			if (disposed || document.hidden || retry !== null) return;
			retry = setTimeout(() => {
				retry = null;
				void connect();
			}, delay);
		};
		const connect = async () => {
			if (disposed || document.hidden || active) return;
			const controller = new AbortController();
			active = controller;
			let liveness: ReturnType<typeof setTimeout> | null = null;
			let retryMs: number | null = null;
			let terminal = false;
			const armLiveness = () => {
				if (liveness !== null) clearTimeout(liveness);
				liveness = setTimeout(() => controller.abort(), 60_000);
			};
			try {
				armLiveness();
				const token = await getToken();
				if (disposed || controller.signal.aborted) return;
				const base = env.VITE_CLAWDI_API_URL.replace(/\/$/, "");
				const response = await fetch(
					`${base}/v1/sessions/${encodeURIComponent(sessionId)}/content-events`,
					{
						headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
						signal: controller.signal,
					},
				);
				await suspension.observeResponse(response);
				if (!response.ok) {
					terminal = [403, 404].includes(response.status);
					const seconds = Number(response.headers.get("Retry-After"));
					if (Number.isFinite(seconds) && seconds > 0) retryMs = seconds * 1000;
					throw new Error("Session content stream rejected");
				}
				if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream"))
					throw new Error("Invalid session content stream");
				// Observe transport bytes (including heartbeat comments) without
				// turning liveness into a timer that queries session content.
				const stream = response.body.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(chunk, output) {
							armLiveness();
							output.enqueue(chunk);
						},
					}),
					{ signal: controller.signal },
				);
				await consumeServerSentEvents(stream, (event) => {
					if (disposed || controller.signal.aborted || event.event !== "content-version") return;
					const version = parseContentVersion(event.data);
					if (!version) throw new Error("Invalid session content version");
					attempt = 0;
					observer.receive(version);
				});
			} catch {
				// Reconnect with fresh credentials and a fresh authorized version.
			} finally {
				controller.abort();
				if (liveness !== null) clearTimeout(liveness);
				if (active === controller) active = null;
				if (!terminal)
					schedule(
						retryMs ??
							Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)) * (0.8 + Math.random() * 0.4),
					);
			}
		};
		const visibility = () => {
			if (document.hidden) {
				if (retry !== null) clearTimeout(retry);
				retry = null;
				observer.clear();
				active?.abort();
			} else schedule(0);
		};
		document.addEventListener("visibilitychange", visibility);
		if (!document.hidden) void connect();
		return () => {
			disposed = true;
			observer.dispose();
			document.removeEventListener("visibilitychange", visibility);
			if (retry !== null) clearTimeout(retry);
			active?.abort();
		};
	}, [getToken, identity, queryClient, sessionId, suspension]);
}
