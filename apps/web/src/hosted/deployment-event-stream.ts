import type { DeploymentEvent, DeploymentEventType } from "@clawdi/shared/api";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
	HostedDeployment,
	HostedEventStreamSnapshotHandoff,
} from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";

export const EVENT_STREAM_RECONNECT_BASE_MS = 1_000;
export const EVENT_STREAM_RECONNECT_MAX_MS = 30_000;

export type DeploymentEventSignal = {
	deploymentId: DeploymentEvent["deployment_id"];
	eventType: DeploymentEventType;
	operationName: string | null;
};

const DEPLOYMENT_EVENT_TYPES = [
	"deployment.operation.accepted",
	"deployment.operation.cancel_requested",
	"deployment.reconcile.repair_requested",
	"deployment.operation.started",
	"deployment.operation.succeeded",
	"deployment.operation.failed",
	"deployment.operation.aborted",
	"deployment.operation.cancelled",
	"deployment.delivery.lineage_advanced",
	"deployment.delivery.terminated",
	"deployment.state.changed",
	"deployment.condition.changed",
	"deployment.drift.detected",
	"deployment.drift.repaired",
	"deployment.reconcile.quarantined",
] as const satisfies readonly DeploymentEventType[];

export type ServerSentEvent = {
	id: string | null;
	event: string;
	data: string;
};

type ServerSentEventState = {
	data: string[];
	event: string;
	lastEventId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dispatchEvent(
	state: ServerSentEventState,
	onEvent: (event: ServerSentEvent) => void,
): void {
	if (state.data.length === 0) return;
	onEvent({ id: state.lastEventId, event: state.event || "message", data: state.data.join("\n") });
	state.data = [];
	state.event = "";
}

function consumeLine(
	line: string,
	state: ServerSentEventState,
	onEvent: (event: ServerSentEvent) => void,
): void {
	if (line === "") {
		dispatchEvent(state, onEvent);
		return;
	}
	if (line.startsWith(":")) return;

	const separator = line.indexOf(":");
	const field = separator === -1 ? line : line.slice(0, separator);
	let value = separator === -1 ? "" : line.slice(separator + 1);
	if (value.startsWith(" ")) value = value.slice(1);

	if (field === "data") state.data.push(value);
	else if (field === "event") state.event = value;
	else if (field === "id" && !value.includes("\0")) state.lastEventId = value;
}

/** Consume a WHATWG SSE stream without assuming network chunk boundaries align to frames. */
export async function consumeServerSentEvents(
	stream: ReadableStream<Uint8Array>,
	onEvent: (event: ServerSentEvent) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const state: ServerSentEventState = { data: [], event: "", lastEventId: null };
	let pending = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			pending += decoder.decode(value, { stream: !done });

			let lineStart = 0;
			for (let index = 0; index < pending.length; index += 1) {
				const character = pending[index];
				if (character !== "\n" && character !== "\r") continue;
				if (character === "\r" && index === pending.length - 1 && !done) break;
				consumeLine(pending.slice(lineStart, index), state, onEvent);
				if (character === "\r" && pending[index + 1] === "\n") index += 1;
				lineStart = index + 1;
			}
			pending = pending.slice(lineStart);
			if (done) return;
		}
	} finally {
		reader.releaseLock();
	}
}

export function deploymentEventSignal(event: ServerSentEvent): DeploymentEventSignal | null {
	const eventType = DEPLOYMENT_EVENT_TYPES.find((candidate) => candidate === event.event);
	if (!eventType) return null;
	try {
		const payload: unknown = JSON.parse(event.data);
		if (
			!isRecord(payload) ||
			payload.event_type !== eventType ||
			typeof payload.deployment_id !== "string" ||
			!payload.deployment_id ||
			typeof payload.event_id !== "string" ||
			!payload.event_id ||
			typeof payload.stream_sequence !== "number" ||
			!Number.isInteger(payload.stream_sequence) ||
			payload.stream_sequence < 1
		) {
			return null;
		}
		return {
			deploymentId: payload.deployment_id,
			eventType,
			operationName: typeof payload.operation_name === "string" ? payload.operation_name : null,
		};
	} catch {
		return null;
	}
}

export function eventStreamReconnectDelay(attempt: number): number {
	const exponent = Math.max(0, Math.floor(attempt));
	return Math.min(EVENT_STREAM_RECONNECT_BASE_MS * 2 ** exponent, EVENT_STREAM_RECONNECT_MAX_MS);
}

function openApiParamMatches(
	queryKey: QueryKey,
	path: string,
	parameterGroup: "path" | "query",
	parameter: string,
	value: string,
): boolean {
	if (!Array.isArray(queryKey) || queryKey[1] !== path) return false;
	const init = queryKey[2];
	if (!isRecord(init) || !isRecord(init.params)) return false;
	const group = init.params[parameterGroup];
	return isRecord(group) && group[parameter] === value;
}

export function deploymentEventQueryBelongsToAgent(queryKey: QueryKey, agentId: string): boolean {
	return (
		(Array.isArray(queryKey) &&
			queryKey[0] === "skills" &&
			queryKey[1] === "agent-projects" &&
			queryKey[2] === agentId) ||
		skillDetailQueryBelongsToAgent(queryKey, agentId) ||
		openApiParamMatches(
			queryKey,
			"/v1/agents/{agent_id}/agent-plugins",
			"path",
			"agent_id",
			agentId,
		) ||
		openApiParamMatches(queryKey, "/v1/channels/agent-links", "query", "agent_id", agentId) ||
		openApiParamMatches(queryKey, "/v1/sessions", "query", "environment_id", agentId) ||
		openApiParamMatches(queryKey, "/v1/agents/{agent_id}", "path", "agent_id", agentId)
	);
}

function skillDetailQueryBelongsToAgent(queryKey: QueryKey, agentId: string): boolean {
	if (!Array.isArray(queryKey) || queryKey[0] !== "skill" || typeof queryKey[3] !== "string") {
		return false;
	}
	const prefix = "agent:";
	if (!queryKey[3].startsWith(prefix)) return false;
	try {
		const scope: unknown = JSON.parse(queryKey[3].slice(prefix.length));
		return Array.isArray(scope) && scope[0] === agentId;
	} catch {
		return false;
	}
}

/** Seed the exact snapshot paired with a fresh cursor before consuming later events. */
export function applyDeploymentEventStreamHandoff(
	queryClient: QueryClient,
	handoff: HostedEventStreamSnapshotHandoff,
	agentId: string | null,
	deploymentId: string | null,
): Promise<void> {
	queryClient.setQueryData<HostedDeployment[]>(billingKeys.deployments, handoff.deployments);
	const invalidations = [queryClient.invalidateQueries({ queryKey: ["get", "/v1/agents"] })];
	if (deploymentId) {
		invalidations.push(
			queryClient.invalidateQueries({
				queryKey: billingKeys.workspaceSkills(deploymentId),
				exact: true,
			}),
		);
	}
	if (agentId) {
		invalidations.push(
			queryClient.invalidateQueries({
				predicate: (query) => deploymentEventQueryBelongsToAgent(query.queryKey, agentId),
			}),
		);
	}
	return Promise.allSettled(invalidations).then(() => undefined);
}

/** Deployment snapshots also carry the accepted operation projection. */
export function invalidateDeploymentEventQueries(
	queryClient: QueryClient,
	event: DeploymentEventSignal,
	agentId: string | null,
): Promise<void> {
	const invalidations = [
		queryClient.invalidateQueries({ queryKey: billingKeys.deployments, exact: true }),
		queryClient.invalidateQueries({
			queryKey: billingKeys.workspaceSkills(event.deploymentId),
			exact: true,
		}),
		queryClient.invalidateQueries({ queryKey: ["get", "/v1/agents"] }),
	];
	if (agentId) {
		invalidations.push(
			queryClient.invalidateQueries({
				predicate: (query) => deploymentEventQueryBelongsToAgent(query.queryKey, agentId),
			}),
		);
	}
	return Promise.allSettled(invalidations).then(() => undefined);
}
