import type { DesktopAgentType, DesktopDetectedAgent } from "@clawdi/shared/desktop";
import { allAdapterEntries } from "../adapters/registry";
import { ApiClient, ApiError, unwrap } from "../lib/api-client";
import { getAuth } from "../lib/config";
import {
	bindEnvironmentRegistrationUser,
	readEnvironmentRegistration,
} from "../lib/environment-registration";
import { listRegisteredAgentTypes } from "../lib/select-adapter";

interface DetectableAgentEntry {
	agentType: DesktopAgentType;
	displayName: string;
	create(): {
		detect(): Promise<boolean>;
		getVersion(): Promise<string | null>;
	};
}

type RegistrationInspection = "registered" | "not_registered" | "failed";

interface DetectLocalAgentsOptions {
	registeredTypes?: ReadonlySet<string>;
	inspectRegistration?(agentType: DesktopAgentType): Promise<RegistrationInspection>;
}

export async function detectLocalAgents(
	entries: readonly DetectableAgentEntry[] = allAdapterEntries(),
	options: DetectLocalAgentsOptions = {},
): Promise<DesktopDetectedAgent[]> {
	const registeredTypes = options.registeredTypes ?? new Set(listRegisteredAgentTypes());
	return Promise.all(
		entries.map(async (entry) => {
			const adapter = entry.create();
			const registration = registeredTypes.has(entry.agentType)
				? await (options.inspectRegistration?.(entry.agentType) ?? "registered")
				: "not_registered";
			try {
				const detected = await adapter.detect();
				return {
					type: entry.agentType,
					displayName: entry.displayName,
					detected,
					registered: registration === "registered",
					version: detected ? await adapter.getVersion() : null,
					inspection: registration === "failed" ? ("failed" as const) : ("complete" as const),
				};
			} catch {
				return {
					type: entry.agentType,
					displayName: entry.displayName,
					detected: false,
					registered: registration === "registered",
					version: null,
					inspection: "failed" as const,
				};
			}
		}),
	);
}

export async function inspectDesktopRegistration(
	agentType: DesktopAgentType,
	lookup: (environmentId: string) => Promise<void> = async (environmentId) => {
		unwrap(
			await new ApiClient().GET("/v1/agents/{agent_id}", {
				params: { path: { agent_id: environmentId } },
			}),
		);
	},
): Promise<RegistrationInspection> {
	const registration = readEnvironmentRegistration(agentType);
	if (!registration) return "not_registered";
	if (registration.userId) return "registered";
	try {
		await lookup(registration.id);
		const userId = getAuth()?.userId;
		if (userId && !bindEnvironmentRegistrationUser(agentType, registration.id, userId)) {
			const current = readEnvironmentRegistration(agentType);
			return current?.id === registration.id && current.userId === userId ? "registered" : "failed";
		}
		return "registered";
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) return "not_registered";
		return "failed";
	}
}

export async function agentDetectCommand(opts: { json?: boolean } = {}): Promise<void> {
	const jsonOutput = opts.json || !process.stdout.isTTY;
	const agents = await detectLocalAgents(allAdapterEntries(), {
		inspectRegistration: jsonOutput ? inspectDesktopRegistration : undefined,
	});
	if (jsonOutput) {
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
