import type { DesktopAgentType, DesktopDetectedAgent } from "@clawdi/shared/desktop";
import { allAdapterEntries } from "../adapters/registry";
import { listRegisteredAgentTypes } from "../lib/select-adapter";

interface DetectableAgentEntry {
	agentType: DesktopAgentType;
	displayName: string;
	create(): {
		detect(): Promise<boolean>;
		getVersion(): Promise<string | null>;
	};
}

export async function detectLocalAgents(
	entries: readonly DetectableAgentEntry[] = allAdapterEntries(),
	registeredTypes: ReadonlySet<string> = new Set(listRegisteredAgentTypes()),
): Promise<DesktopDetectedAgent[]> {
	return Promise.all(
		entries.map(async (entry) => {
			const adapter = entry.create();
			try {
				const detected = await adapter.detect();
				return {
					type: entry.agentType,
					displayName: entry.displayName,
					detected,
					registered: registeredTypes.has(entry.agentType),
					version: detected ? await adapter.getVersion() : null,
					inspection: "complete" as const,
				};
			} catch {
				return {
					type: entry.agentType,
					displayName: entry.displayName,
					detected: false,
					registered: registeredTypes.has(entry.agentType),
					version: null,
					inspection: "failed" as const,
				};
			}
		}),
	);
}

export async function agentDetectCommand(opts: { json?: boolean } = {}): Promise<void> {
	const agents = await detectLocalAgents();
	if (opts.json || !process.stdout.isTTY) {
		console.log(JSON.stringify({ schemaVersion: "clawdi.agentDetection.v1", agents }, null, 2));
		return;
	}

	for (const agent of agents) {
		const state = agent.registered
			? "connected"
			: agent.detected
				? agent.version
					? agent.version
					: "data found"
				: agent.inspection === "failed"
					? "inspection failed"
					: "not found";
		console.log(`${agent.displayName}: ${state}`);
	}
}
