import createClient from "openapi-fetch";
import type { components, paths } from "./api.generated";
import {
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

function validatePlugin(
	value: components["schemas"]["AgentPluginDesiredStateResponse"],
	agentId: string,
	name?: string,
	version?: string,
) {
	if (
		!value ||
		value.agent_id !== agentId ||
		typeof value.plugin_name !== "string" ||
		!value.plugin_name ||
		typeof value.version !== "string" ||
		!value.version ||
		(name !== undefined && value.plugin_name !== name) ||
		(version !== undefined && value.version !== version) ||
		value.desired_state !== "present" ||
		!["installed", "failed", "not_observed"].includes(value.convergence)
	)
		throw new ApiClientResponseError();
	return value;
}

/** Desired-state requests only. No automatic mutation retry or implied runtime acceptance. */
export function createAgentExtensionsClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	return {
		catalog: async (signal?: AbortSignal) => {
			const result = await transport.read((init) => api.GET("/v1/plugin-catalog", init), signal);
			if (
				!result ||
				!Array.isArray(result.plugins) ||
				result.plugins.some(
					(entry) =>
						!entry ||
						typeof entry.name !== "string" ||
						!entry.name ||
						typeof entry.version !== "string" ||
						!entry.version ||
						typeof entry.display_name !== "string" ||
						typeof entry.category !== "string" ||
						typeof entry.installable !== "boolean" ||
						!Array.isArray(entry.runtimes) ||
						entry.runtimes.some((runtime) => runtime !== "openclaw" && runtime !== "hermes") ||
						![entry.keywords, entry.languages, entry.components?.skills].every(
							(value) => Array.isArray(value) && value.every((item) => typeof item === "string"),
						) ||
						!entry.components?.mcpServers ||
						typeof entry.components.mcpServers !== "object" ||
						Array.isArray(entry.components.mcpServers),
				)
			)
				throw new ApiClientResponseError();
			return result;
		},
		listPlugins: async (agentId: string, signal?: AbortSignal) => {
			const path = { agent_id: readResourceId(agentId) };
			const result = await transport.read(
				(init) => api.GET("/v1/agents/{agent_id}/agent-plugins", { ...init, params: { path } }),
				signal,
			);
			if (!result || !Array.isArray(result.plugins)) throw new ApiClientResponseError();
			for (const item of result.plugins) validatePlugin(item, agentId);
			return result;
		},
		getPlugin: async (agentId: string, name: string, signal?: AbortSignal) => {
			const path = { agent_id: readResourceId(agentId), plugin_name: readResourceId(name) };
			return validatePlugin(
				await transport.read(
					(init) =>
						api.GET("/v1/agents/{agent_id}/agent-plugins/{plugin_name}", {
							...init,
							params: { path },
						}),
					signal,
				),
				agentId,
				name,
			);
		},
		installPlugin: async (agentId: string, name: string, version: string, signal?: AbortSignal) => {
			const path = { agent_id: readResourceId(agentId), plugin_name: readResourceId(name) };
			const body = { version: readResourceId(version) };
			return validatePlugin(
				await transport.read(
					(init) =>
						api.PUT("/v1/agents/{agent_id}/agent-plugins/{plugin_name}", {
							...init,
							params: { path },
							body,
						}),
					signal,
				),
				agentId,
				name,
				version,
			);
		},
		removePlugin: async (agentId: string, name: string, signal?: AbortSignal) => {
			const path = { agent_id: readResourceId(agentId), plugin_name: readResourceId(name) };
			const result = await transport.read(
				(init) =>
					api.DELETE("/v1/agents/{agent_id}/agent-plugins/{plugin_name}", {
						...init,
						params: { path },
					}),
				signal,
			);
			if (
				!result ||
				result.agent_id !== agentId ||
				result.plugin_name !== name ||
				result.desired_state !== "absent" ||
				result.convergence !== "not_observed"
			)
				throw new ApiClientResponseError();
			return result;
		},
		listSkills: async (agentId: string, signal?: AbortSignal) => {
			const path = { agent_id: readResourceId(agentId) };
			const result = await transport.read(
				(init) => api.GET("/v1/agents/{agent_id}/skills", { ...init, params: { path } }),
				signal,
			);
			if (!result || result.agent_id !== agentId || !Array.isArray(result.skills))
				throw new ApiClientResponseError();
			if (
				result.skills.some(
					(item) =>
						!item ||
						typeof item.skill_key !== "string" ||
						!item.skill_key ||
						typeof item.name !== "string" ||
						typeof item.read_only !== "boolean" ||
						!["library", "github", "project", "bundled"].includes(item.source) ||
						item.desired_state !== "present" ||
						!["installed", "failed", "not_observed"].includes(item.convergence),
				)
			)
				throw new ApiClientResponseError();
			return result;
		},
		getLibrarySkill: async (agentId: string, skillId: string, signal?: AbortSignal) => {
			const path = { agent_id: readResourceId(agentId), skill_id: readResourceId(skillId) };
			const result = await transport.read(
				(init) =>
					api.GET("/v1/agents/{agent_id}/skill-references/{skill_id}", {
						...init,
						params: { path },
					}),
				signal,
			);
			if (!result || result.id !== skillId) throw new ApiClientResponseError();
			return result;
		},
		setLibraryReference: async (
			agentId: string,
			skillId: string,
			present: boolean,
			signal?: AbortSignal,
		) => {
			const path = { agent_id: readResourceId(agentId), skill_id: readResourceId(skillId) };
			const result = await transport.read(
				(init) =>
					present
						? api.PUT("/v1/agents/{agent_id}/skill-references/{skill_id}", {
								...init,
								params: { path },
							})
						: api.DELETE("/v1/agents/{agent_id}/skill-references/{skill_id}", {
								...init,
								params: { path },
							}),
				signal,
			);
			if (
				!result ||
				result.agent_id !== agentId ||
				result.skill_id !== skillId ||
				result.desired_state !== (present ? "present" : "absent")
			)
				throw new ApiClientResponseError();
			return result;
		},
	};
}

export type AgentExtensionsClient = ReturnType<typeof createAgentExtensionsClient>;
