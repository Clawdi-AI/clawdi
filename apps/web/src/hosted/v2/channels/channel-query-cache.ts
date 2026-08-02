import type { QueryClient } from "@tanstack/react-query";

export const channelKeys = {
	list: ["get", "/v1/channels"] as const,
	pool: ["get", "/v1/channels/bot-pool"] as const,
	health: ["get", "/v1/channels/health", {}] as const,
	channel: (id: string) =>
		["get", "/v1/channels/{account_id}", { params: { path: { account_id: id } } }] as const,
	agentLinks: (id: string) =>
		[
			"get",
			"/v1/channels/{account_id}/agent-links",
			{ params: { path: { account_id: id } } },
		] as const,
	bindings: (id: string) =>
		[
			"get",
			"/v1/channels/{account_id}/bindings",
			{ params: { path: { account_id: id } } },
		] as const,
	activity: (id: string) =>
		[
			"get",
			"/v1/channels/{account_id}/activity",
			{ params: { path: { account_id: id }, query: { limit: 50 } } },
		] as const,
};

export async function invalidateCreatedChannelQueries(
	qc: QueryClient,
	created: { id: string; agent_id?: string | null },
): Promise<void> {
	const invalidations = [
		qc.invalidateQueries({ queryKey: channelKeys.list }),
		qc.invalidateQueries({ queryKey: channelKeys.pool }),
		qc.invalidateQueries({ queryKey: channelKeys.health }),
		qc.invalidateQueries({ queryKey: channelKeys.agentLinks(created.id) }),
	];
	if (created.agent_id) {
		invalidations.push(
			qc.invalidateQueries({ queryKey: ["agent-channel-links", created.agent_id] }),
		);
	}
	await Promise.all(invalidations);
}

export async function removeDeletedChannelQueries(
	qc: QueryClient,
	channelId: string,
): Promise<void> {
	qc.removeQueries({ queryKey: channelKeys.channel(channelId) });
	// Bespoke command projections still use this non-OpenAPI cache namespace.
	qc.removeQueries({ queryKey: ["channel", channelId] });
	qc.removeQueries({ queryKey: channelKeys.agentLinks(channelId) });
	qc.removeQueries({ queryKey: channelKeys.bindings(channelId) });
	qc.removeQueries({ queryKey: channelKeys.activity(channelId) });

	await Promise.all([
		qc.invalidateQueries({ queryKey: channelKeys.list }),
		qc.invalidateQueries({ queryKey: channelKeys.pool }),
		qc.invalidateQueries({ queryKey: channelKeys.health }),
		qc.invalidateQueries({ queryKey: ["agent-channel-links"] }),
	]);
}
