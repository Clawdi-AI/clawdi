import createClient from "openapi-fetch";
import type { DeployComponents, DeployPaths } from "./deploy";
import {
	ApiClientError,
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

export type DeploymentUpdate = DeployComponents["schemas"]["V2UpdateDeploymentRequest"];
export type DeploymentMutation =
	| { action: "start" | "stop" | "restart" | "reset_runtime_ui_access" }
	| { action: "update"; body: DeploymentUpdate };
export function deploymentLifecycleAvailable(
	action: "start" | "stop" | "restart",
	state:
		| DeployComponents["schemas"]["HostedDeploymentStatus"]["summary_state"]
		| "unknown"
		| undefined,
): boolean {
	switch (action) {
		case "start":
			return state === "stopped" || state === "failed";
		case "stop":
			return state === "running" || state === "starting";
		case "restart":
			return state === "running" || state === "failed";
	}
}
export function strongDeploymentEtag(value: string): string {
	if (typeof value !== "string" || !/^[\x21-\x7e]{1,128}$/.test(value) || /["\\]/.test(value))
		throw new ApiClientResponseError();
	return `"${value}"`;
}
export function deploymentMutationHeaders(resourceVersion: string, key: string) {
	if (typeof key !== "string" || !/^[\x21-\x7e]{1,255}$/.test(key))
		throw new ApiClientError(400, "invalid_idempotency_key");
	return { "If-Match": strongDeploymentEtag(resourceVersion), "Idempotency-Key": key };
}

/** Caller owns confirmation and exact-attempt recovery; never refreshes ETags or retries writes. */
export function createDeploymentMutationClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<DeployPaths>({
		baseUrl: readApiBaseUrl(options.baseUrl, true),
		fetch: transport.fetch,
	});
	return {
		apply: async (
			id: string,
			resourceVersion: string,
			key: string,
			mutation: DeploymentMutation,
			signal?: AbortSignal,
		) => {
			const params = {
				path: { deployment_id: readResourceId(id) },
				header: deploymentMutationHeaders(resourceVersion, key),
			};
			const operation = await transport.read((init) => {
				switch (mutation.action) {
					case "start":
						return api.POST("/v2/deployments/{deployment_id}/start", { ...init, params });
					case "stop":
						return api.POST("/v2/deployments/{deployment_id}/stop", { ...init, params });
					case "restart":
						return api.POST("/v2/deployments/{deployment_id}/restart", { ...init, params });
					case "reset_runtime_ui_access":
						return api.POST("/v2/deployments/{deployment_id}/runtime-ui/access/reset", {
							...init,
							params,
						});
					case "update":
						return api.PATCH("/v2/deployments/{deployment_id}", {
							...init,
							params,
							body: mutation.body,
						});
				}
			}, signal);
			if (
				!operation ||
				operation.metadata?.deploymentId !== id ||
				operation.metadata.verb !== mutation.action ||
				!/^operations\/[A-Za-z0-9_-]+$/.test(operation.name) ||
				typeof operation.done !== "boolean"
			)
				throw new ApiClientResponseError();
			return operation;
		},
	};
}
export type DeploymentMutationClient = ReturnType<typeof createDeploymentMutationClient>;
