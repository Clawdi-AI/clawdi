import createClient from "openapi-fetch";
import type { AiProviderRemovalImpact } from "./deploy";
import type { paths } from "./deploy.generated";
import {
	ApiClientError,
	type ApiClientOptions,
	ApiClientResponseError,
	createReadTransport,
	readApiBaseUrl,
	readResourceId,
} from "./read-transport";

export function providerRemovalHeaders(impactRevision: string, incarnation: string, key: string) {
	if (!/^[a-f0-9]{64}$/.test(impactRevision) || !/^[a-f0-9]{64}$/.test(incarnation))
		throw new ApiClientError(400, "invalid_provider_confirmation");
	if (!/^[\x21-\x7e]{1,255}$/.test(key)) throw new ApiClientError(400, "invalid_idempotency_key");
	return {
		"Impact-Revision": impactRevision,
		"Provider-Incarnation": incarnation,
		"Idempotency-Key": key,
	};
}

export function createProviderRemovalClient(options: ApiClientOptions) {
	const transport = createReadTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl, true),
		fetch: transport.fetch,
	});
	return {
		impact: async (providerId: string, signal?: AbortSignal) => {
			const result = await transport.read(
				(init) =>
					api.GET("/v2/ai-providers/{provider_id}/removal-impact", {
						...init,
						params: { path: { provider_id: readResourceId(providerId) } },
					}),
				signal,
			);
			if (
				!result ||
				result.provider_id !== providerId ||
				!Array.isArray(result.agents) ||
				result.agents.some(
					(agent) =>
						!agent ||
						typeof agent.deployment_id !== "string" ||
						!agent.deployment_id ||
						typeof agent.name !== "string",
				)
			)
				throw new ApiClientResponseError();
			providerRemovalHeaders(result.impact_revision, result.provider_incarnation_token, "validate");
			return result;
		},
		remove: async (impact: AiProviderRemovalImpact, key: string, signal?: AbortSignal) => {
			const header = providerRemovalHeaders(
				impact.impact_revision,
				impact.provider_incarnation_token,
				key,
			);
			const result = await transport.read(
				(init) =>
					api.DELETE("/v2/ai-providers/{provider_id}", {
						...init,
						params: { path: { provider_id: readResourceId(impact.provider_id) }, header },
					}),
				signal,
			);
			if (
				result?.status !== "removed" ||
				result.provider_id !== impact.provider_id ||
				(result.remote_revoke_status !== "pending" &&
					result.remote_revoke_status !== "not_required")
			)
				throw new ApiClientResponseError();
			return result;
		},
	};
}
export type ProviderRemovalClient = ReturnType<typeof createProviderRemovalClient>;
