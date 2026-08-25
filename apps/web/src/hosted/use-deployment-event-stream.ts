"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isDeployApiConfigured, useBillingClient } from "@/hosted/billing/billing-client";
import {
	applyDeploymentEventStreamHandoff,
	consumeServerSentEvents,
	deploymentEventSignal,
	eventStreamReconnectDelay,
	invalidateDeploymentEventQueries,
} from "@/hosted/deployment-event-stream";

export type DeploymentEventStreamStatus =
	| "idle"
	| "connecting"
	| "connected"
	| "disconnected"
	| "paused";

const STABLE_CONNECTION_MS = 10_000;

function retryAfterMs(response: Response): number | null {
	const seconds = Number(response.headers.get("Retry-After"));
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : null;
}

function pageIsHidden(): boolean {
	return document.visibilityState === "hidden";
}

export function useDeploymentEventStream({
	deploymentId = null,
	agentId = null,
	enabled = true,
}: {
	deploymentId?: string | null;
	agentId?: string | null;
	enabled?: boolean;
} = {}) {
	const client = useBillingClient();
	const queryClient = useQueryClient();
	const [status, setStatus] = useState<DeploymentEventStreamStatus>("idle");
	const streamEnabled = enabled && isDeployApiConfigured();

	useEffect(() => {
		if (!streamEnabled) {
			setStatus("idle");
			return;
		}

		let disposed = false;
		let cursor: string | null = null;
		let reconnectAttempt = 0;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let activeController: AbortController | null = null;

		const schedule = (delayMs: number) => {
			if (disposed || pageIsHidden() || retryTimer !== null) return;
			retryTimer = globalThis.setTimeout(() => {
				retryTimer = null;
				void connect();
			}, delayMs);
		};

		const connect = async () => {
			if (disposed || pageIsHidden() || activeController !== null) {
				return;
			}

			const controller = new AbortController();
			activeController = controller;
			setStatus("connecting");
			let retryDelay: number | null = null;
			let connectionStartedAt = 0;
			let receivedEvent = false;

			try {
				if (cursor === null) {
					const handoff = await client.getDeploymentEventStreamHandoff(controller.signal);
					cursor = handoff.event_stream_cursor;
					await applyDeploymentEventStreamHandoff(queryClient, handoff, agentId, deploymentId);
				}
				const response = await client.openDeploymentEventStream(
					deploymentId,
					cursor,
					controller.signal,
				);
				if (!response.ok) {
					if (response.status === 410) cursor = null;
					retryDelay = retryAfterMs(response);
					throw new Error(`Deployment event stream returned ${response.status}`);
				}
				if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
					throw new Error("Deployment event stream returned an unexpected content type");
				}
				if (!response.body) throw new Error("Deployment event stream returned no body");

				connectionStartedAt = Date.now();
				setStatus("connected");
				await consumeServerSentEvents(response.body, (message) => {
					if (message.id) cursor = message.id;
					const event = deploymentEventSignal(message);
					if (!event) return;
					receivedEvent = true;
					void invalidateDeploymentEventQueries(queryClient, event, agentId);
				});
				throw new Error("Deployment event stream disconnected");
			} catch {
				if (disposed || controller.signal.aborted) return;
				const stableConnection =
					receivedEvent ||
					(connectionStartedAt > 0 && Date.now() - connectionStartedAt >= STABLE_CONNECTION_MS);
				reconnectAttempt = stableConnection ? 0 : reconnectAttempt + 1;
				setStatus("disconnected");
				schedule(retryDelay ?? eventStreamReconnectDelay(reconnectAttempt - 1));
			} finally {
				if (activeController === controller) activeController = null;
				if (!disposed && !pageIsHidden() && retryTimer === null) {
					schedule(0);
				}
			}
		};

		const onVisibilityChange = () => {
			if (pageIsHidden()) {
				if (retryTimer !== null) globalThis.clearTimeout(retryTimer);
				retryTimer = null;
				activeController?.abort();
				setStatus("paused");
				return;
			}
			schedule(0);
		};

		document.addEventListener("visibilitychange", onVisibilityChange);
		if (pageIsHidden()) setStatus("paused");
		else schedule(0);

		return () => {
			disposed = true;
			document.removeEventListener("visibilitychange", onVisibilityChange);
			if (retryTimer !== null) globalThis.clearTimeout(retryTimer);
			activeController?.abort();
		};
	}, [agentId, client, deploymentId, queryClient, streamEnabled]);

	return { status, active: status === "connected" } as const;
}
