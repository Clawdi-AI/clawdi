import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { HostedDeployment } from "@/hosted/billing/contracts";
import { billingKeys } from "@/hosted/billing/query-keys";
import {
	applyDeploymentEventStreamHandoff,
	consumeServerSentEvents,
	createDeploymentEventInvalidationBatch,
	type DeploymentEventSignal,
	deploymentEventQueryBelongsToAgent,
	deploymentEventSignal,
	EVENT_STREAM_INVALIDATION_BATCH_MS,
	eventStreamReconnectDelay,
	eventStreamResponseResetsCursor,
	invalidateDeploymentEventQueries,
	type ServerSentEvent,
} from "@/hosted/deployment-event-stream";
import { hostedDeploymentFixture } from "@/hosted/hosted-deployment.test-fixture";
import { eventStreamFallbackInterval } from "@/lib/event-stream-refresh";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const DEPLOYMENT_ID = "hdep_events";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

function event(overrides: Partial<ServerSentEvent> = {}): ServerSentEvent {
	return {
		id: "cursor-2",
		event: "deployment.state.changed",
		data: JSON.stringify({
			event_id: "event-2",
			stream_sequence: 2,
			deployment_id: DEPLOYMENT_ID,
			event_type: "deployment.state.changed",
			operation_name: "operations/restart-2",
		}),
		...overrides,
	};
}

describe("deployment event stream protocol", () => {
	test("parses CRLF frames split across arbitrary network chunks", async () => {
		const events: ServerSentEvent[] = [];
		await consumeServerSentEvents(
			streamFrom([
				": keepalive\r",
				'\nid: cursor-2\r\nevent: deployment.state.changed\r\ndata: {"first":\r\n',
				"data: true}\r\n\r\n",
			]),
			(next) => events.push(next),
		);

		expect(events).toEqual([
			{
				id: "cursor-2",
				event: "deployment.state.changed",
				data: '{"first":\ntrue}',
			},
		]);
	});

	test("accepts only matching deployment envelopes", () => {
		expect(deploymentEventSignal(event())).toEqual({
			deploymentId: DEPLOYMENT_ID,
			eventType: "deployment.state.changed",
			operationName: "operations/restart-2",
		});
		expect(deploymentEventSignal(event({ event: "deployment.operation.succeeded" }))).toBeNull();
		expect(deploymentEventSignal(event({ data: "not-json" }))).toBeNull();
	});

	test("uses 10x polling only while connected and jitters capped exponential reconnects", () => {
		expect(eventStreamFallbackInterval(5_000, false)).toBe(5_000);
		expect(eventStreamFallbackInterval(5_000, true)).toBe(50_000);
		expect(eventStreamFallbackInterval(false, true)).toBe(false);
		expect([0, 1, 2, 8].map((attempt) => eventStreamReconnectDelay(attempt, () => 0.5))).toEqual([
			1_000, 2_000, 4_000, 30_000,
		]);
		expect(eventStreamReconnectDelay(0, () => 0)).toBe(800);
		expect(eventStreamReconnectDelay(8, () => 1)).toBe(36_000);
	});

	test("resets cursors rejected by validation, authorization, or retention", () => {
		expect([400, 403, 410].every(eventStreamResponseResetsCursor)).toBe(true);
		expect([401, 404, 429, 500].some(eventStreamResponseResetsCursor)).toBe(false);
	});
});

describe("deployment event query invalidation", () => {
	test("matches only the affected Agent projections", () => {
		expect(
			deploymentEventQueryBelongsToAgent(
				[
					"get",
					"/v1/agents/{agent_id}/agent-plugins",
					{ params: { path: { agent_id: AGENT_ID } } },
				],
				AGENT_ID,
			),
		).toBe(true);
		expect(
			deploymentEventQueryBelongsToAgent(
				["skills", "agent-projects", OTHER_AGENT_ID, "fence"],
				AGENT_ID,
			),
		).toBe(false);
		expect(
			deploymentEventQueryBelongsToAgent(
				["skill", "review/code", "project-1", `agent:${JSON.stringify([AGENT_ID, "project-1"])}`],
				AGENT_ID,
			),
		).toBe(true);
	});

	test("applies the handoff snapshot before later stream events", async () => {
		const queryClient = new QueryClient();
		const deployments = [hostedDeploymentFixture({ id: DEPLOYMENT_ID, agentId: AGENT_ID })];
		await applyDeploymentEventStreamHandoff(
			queryClient,
			{
				snapshot_isolation: "REPEATABLE READ",
				read_only: true,
				deployments,
				operations: [],
				event_stream_cursor: "cursor-2",
			},
			AGENT_ID,
			DEPLOYMENT_ID,
		);
		expect(queryClient.getQueryData<HostedDeployment[]>(billingKeys.deployments)).toEqual(
			deployments,
		);
	});

	test("invalidates deployment, operation projection, and scoped runtime caches", async () => {
		const queryClient = new QueryClient();
		const affected = [
			billingKeys.deployments,
			billingKeys.workspaceSkills(DEPLOYMENT_ID),
			[
				"get",
				"/v1/agents/{agent_id}/agent-plugins",
				{ params: { path: { agent_id: AGENT_ID } } },
			] as const,
			["skills", "agent-projects", AGENT_ID, "fence"] as const,
			["get", "/v1/channels/agent-links", { params: { query: { agent_id: AGENT_ID } } }] as const,
			[
				"get",
				"/v1/sessions",
				{ params: { query: { environment_id: AGENT_ID, page: 1 } } },
			] as const,
		];
		const unaffected = [
			billingKeys.workspaceSkills("hdep_other"),
			["skills", "agent-projects", OTHER_AGENT_ID, "fence"] as const,
		];
		for (const key of [...affected, ...unaffected]) queryClient.setQueryData(key, {});

		await invalidateDeploymentEventQueries(
			queryClient,
			[
				{
					deploymentId: DEPLOYMENT_ID,
					eventType: "deployment.operation.succeeded",
					operationName: "operations/restart-2",
				},
			],
			AGENT_ID,
		);

		for (const key of affected) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
		for (const key of unaffected) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
	});

	test("micro-batches burst events and preserves each affected deployment", async () => {
		const queryClient = new QueryClient();
		const otherDeploymentId = "hdep_other";
		const batches: Array<readonly DeploymentEventSignal[]> = [];
		const batch = createDeploymentEventInvalidationBatch((events) => batches.push(events), 1);
		const first = deploymentEventSignal(event());
		const second = deploymentEventSignal(
			event({
				id: "cursor-3",
				data: JSON.stringify({
					event_id: "event-3",
					stream_sequence: 3,
					deployment_id: otherDeploymentId,
					event_type: "deployment.state.changed",
					operation_name: null,
				}),
			}),
		);
		if (!first || !second) throw new Error("Expected valid deployment events");

		batch.enqueue(first);
		batch.enqueue(first);
		batch.enqueue(second);
		expect(EVENT_STREAM_INVALIDATION_BATCH_MS).toBeGreaterThanOrEqual(50);
		expect(EVENT_STREAM_INVALIDATION_BATCH_MS).toBeLessThanOrEqual(100);
		expect(batches).toHaveLength(0);
		await Bun.sleep(10);
		expect(batches).toHaveLength(1);
		expect(batches[0]?.map((item) => item.deploymentId)).toEqual([
			DEPLOYMENT_ID,
			otherDeploymentId,
		]);

		queryClient.setQueryData(billingKeys.workspaceSkills(DEPLOYMENT_ID), {});
		queryClient.setQueryData(billingKeys.workspaceSkills(otherDeploymentId), {});
		await invalidateDeploymentEventQueries(queryClient, [first, second], AGENT_ID);
		expect(
			queryClient.getQueryState(billingKeys.workspaceSkills(DEPLOYMENT_ID))?.isInvalidated,
		).toBe(true);
		expect(
			queryClient.getQueryState(billingKeys.workspaceSkills(otherDeploymentId))?.isInvalidated,
		).toBe(true);
		batch.dispose();
	});
});
