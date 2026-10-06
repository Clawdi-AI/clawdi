import createClient from "openapi-fetch";
import type { DeployComponents, DeployPaths } from "./deploy";
import { deploymentMutationHeaders, strongDeploymentEtag } from "./deployment-mutation-client";
import {
	ApiClientError,
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

export type WorkspaceSkillMutation =
	| { action: "install"; request: DeployComponents["schemas"]["V2WorkspaceSkillInstallRequest"] }
	| { action: "uninstall"; skillKey: string };

function validSource(source: DeployComponents["schemas"]["V2WorkspaceSkillSource"] | undefined) {
	return (
		source?.type === "github" &&
		typeof source.url === "string" &&
		typeof source.path === "string" &&
		typeof source.commit === "string" &&
		Boolean(source.commit)
	);
}

/** Exact replay only: the resource version is part of the server fingerprint. */
export function createWorkspaceSkillClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<DeployPaths>({
		baseUrl: readApiBaseUrl(options.baseUrl, true),
		fetch: transport.fetch,
	});
	return {
		list: async (id: string, signal?: AbortSignal) => {
			const result = await transport.read(
				(init) =>
					api.GET("/v2/deployments/{deployment_id}/workspace-skills", {
						...init,
						params: { path: { deployment_id: readResourceId(id) } },
					}),
				signal,
			);
			if (
				!result ||
				result.deployment_id !== id ||
				typeof result.capability?.available !== "boolean"
			)
				throw new ApiClientResponseError();
			strongDeploymentEtag(result.deployment_resource_version);
			if (
				result.items !== undefined &&
				(!Array.isArray(result.items) ||
					result.items.some(
						(item) =>
							!item ||
							typeof item.skill_key !== "string" ||
							!item.skill_key ||
							!validSource(item.source) ||
							!["managed", "requested", "failed"].includes(item.status),
					))
			)
				throw new ApiClientResponseError();
			return result;
		},
		get: async (id: string, skillKey: string, signal?: AbortSignal) => {
			const result = await transport.read(
				(init) =>
					api.GET("/v2/deployments/{deployment_id}/workspace-skills/{skill_key}", {
						...init,
						params: {
							path: { deployment_id: readResourceId(id), skill_key: readResourceId(skillKey) },
						},
					}),
				signal,
			);
			if (
				!result ||
				result.skill_key !== skillKey ||
				typeof result.content !== "string" ||
				!validSource(result.source)
			)
				throw new ApiClientResponseError();
			return result;
		},
		apply: async (
			id: string,
			version: string,
			key: string,
			mutation: WorkspaceSkillMutation,
			signal?: AbortSignal,
		) => {
			const params = {
				path: { deployment_id: readResourceId(id) },
				header: deploymentMutationHeaders(version, key),
			};
			if (mutation.action === "uninstall" && mutation.skillKey === "clawdi")
				throw new ApiClientError(400, "reserved_skill");
			const result = await transport.read(
				(init) =>
					mutation.action === "install"
						? api.POST("/v2/deployments/{deployment_id}/workspace-skills", {
								...init,
								params,
								body: mutation.request,
							})
						: api.DELETE("/v2/deployments/{deployment_id}/workspace-skills/{skill_key}", {
								...init,
								params: {
									...params,
									path: { ...params.path, skill_key: readResourceId(mutation.skillKey) },
								},
							}),
				signal,
			);
			if (
				!result ||
				result.deployment_id !== id ||
				!result.skill_key ||
				result.desired_state !== (mutation.action === "install" ? "present" : "absent") ||
				(mutation.action === "uninstall" && result.skill_key !== mutation.skillKey) ||
				!["managed", "requested", "failed"].includes(result.status)
			)
				throw new ApiClientResponseError();
			strongDeploymentEtag(result.deployment_resource_version);
			return result;
		},
	};
}
export type WorkspaceSkillClient = ReturnType<typeof createWorkspaceSkillClient>;
