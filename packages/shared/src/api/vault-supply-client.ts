import createClient from "openapi-fetch";
import type { paths } from "./api.generated";
import { createPublicTransport, type PublicApiClientOptions } from "./public-transport";
import { ApiClientError, ApiClientResponseError, readApiBaseUrl } from "./read-transport";

/** Public capability transport: no account token, cookies, redirects, retries or observers. */
export function createVaultSupplyClient(options: PublicApiClientOptions) {
	const transport = createPublicTransport(options);
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		fetch: transport.fetch,
	});
	async function send(
		token: string,
		input:
			| { kind: "inspect"; fields?: string[] }
			| { kind: "supply"; fields: Record<string, string> },
		signal?: AbortSignal,
	) {
		if (!/^v2_[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiClientError(422);
		const result = await transport.read(
			(init) =>
				input.kind === "supply"
					? api.POST("/v1/vault/requests/supply", {
							...init,
							body: { token, fields: input.fields },
						})
					: api.POST("/v1/vault/requests/inspect", {
							...init,
							body: { token, ...(input.fields === undefined ? {} : { fields: input.fields }) },
						}),
			signal,
		);
		if (!result) throw new ApiClientResponseError();
		return result;
	}
	return {
		inspect: (token: string, fields?: string[], signal?: AbortSignal) =>
			send(token, { kind: "inspect", fields }, signal),
		supply: (token: string, fields: Record<string, string>, signal?: AbortSignal) =>
			send(token, { kind: "supply", fields }, signal),
	};
}
