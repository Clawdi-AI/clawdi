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
import { resolveRuntimeUiCredentials } from "./runtime-navigation";

export type DeploymentUpdate = DeployComponents["schemas"]["V2UpdateDeploymentRequest"];
export type DeploymentMutation =
	| { action: "start" | "stop" | "restart" | "reset_runtime_ui_access" }
	| { action: "update"; body: DeploymentUpdate }
	| { action: "delete"; body: DeployComponents["schemas"]["V2DeleteDeploymentRequest"] };
/** Web's cancel eligibility: any in-flight operation except backend-managed image cohorts. */
export function canCancelDeploymentOperation(
	operation: DeployComponents["schemas"]["LongRunningOperation"] | null | undefined,
): boolean {
	if (!operation || operation.done) return false;
	return (
		operation.metadata.verb !== "migrate_image" && operation.metadata.verb !== "rollback_image"
	);
}

export function deploymentIdempotencyHeaders(key: string) {
	if (typeof key !== "string" || !/^[\x21-\x7e]{1,255}$/.test(key))
		throw new ApiClientError(400, "invalid_idempotency_key");
	return { "Idempotency-Key": key };
}
export function deploymentLifecycleAvailable(
	action: "start" | "stop" | "restart" | "delete",
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
		case "delete":
			return (
				typeof state === "string" &&
				[
					"creating",
					"starting",
					"running",
					"stopping",
					"stopped",
					"restarting",
					"updating",
					"failed",
				].includes(state)
			);
	}
}
export function strongDeploymentEtag(value: string): string {
	if (typeof value !== "string" || !/^[\x21-\x7e]{1,128}$/.test(value) || /["\\]/.test(value))
		throw new ApiClientResponseError();
	return `"${value}"`;
}
export function deploymentMutationHeaders(resourceVersion: string, key: string) {
	return {
		...deploymentIdempotencyHeaders(key),
		"If-Match": strongDeploymentEtag(resourceVersion),
	};
}

/** Caller owns confirmation and exact-attempt recovery; never refreshes ETags or retries writes. */
export function createDeploymentMutationClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<DeployPaths>({
		baseUrl: readApiBaseUrl(options.baseUrl, true),
		fetch: transport.fetch,
	});
	return {
		/** Explicit owner handoff; never cache credentials or retry issuance. */
		runtimeCredentials: async (
			id: string,
			version: string,
			endpoint: string,
			signal?: AbortSignal,
		) => {
			const params = {
				path: { deployment_id: readResourceId(id) },
				header: { "If-Match": strongDeploymentEtag(version) },
			};
			const result = await transport.read(
				(init) =>
					api.POST("/v2/deployments/{deployment_id}/runtime-ui/credentials", { ...init, params }),
				signal,
			);
			const credentials = resolveRuntimeUiCredentials(result, endpoint, version);
			if (!credentials) throw new ApiClientResponseError();
			return credentials;
		},
		cancel: async (operationName: string, key: string, signal?: AbortSignal): Promise<void> => {
			const match = /^operations\/([A-Za-z0-9_-]{1,180})$/.exec(operationName);
			if (!match?.[1]) throw new ApiClientError(400, "invalid_operation_name");
			const params = {
				path: { operation_id: match[1] },
				header: deploymentIdempotencyHeaders(key),
			};
			const response = await transport.read(
				(init) => api.POST("/v2/operations/{operation_id}:cancel", { ...init, params, body: {} }),
				signal,
			);
			if (
				!response ||
				typeof response !== "object" ||
				Array.isArray(response) ||
				Object.keys(response).length !== 0
			)
				throw new ApiClientResponseError();
		},
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
					case "delete":
						return api.DELETE("/v2/deployments/{deployment_id}", {
							...init,
							params,
							body: mutation.body,
						});
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
			if (operation && "status" in operation) {
				if (
					mutation.action !== "delete" ||
					operation.status !== "absent" ||
					operation.deployment_id !== id
				)
					throw new ApiClientResponseError();
				return operation;
			}
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
