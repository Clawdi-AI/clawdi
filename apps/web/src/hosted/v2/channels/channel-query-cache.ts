import type { QueryClient } from "@tanstack/react-query";

export const channelKeys = {
	list: ["channels"] as const,
	pool: ["channel-bot-pool"] as const,
	health: ["channel-health"] as const,
	channel: (id: string) => ["channel", id] as const,
	agentLinks: (id: string) => ["channel-agent-links", id] as const,
	bindings: (id: string) => ["channel-bindings", id] as const,
	activity: (id: string) => ["channel-activity", id] as const,
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
