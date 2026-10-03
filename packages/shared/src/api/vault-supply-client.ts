import createClient from "openapi-fetch";
import type { components, paths } from "./api.generated";
import {
	ApiClientError,
	type ApiClientFetch,
	ApiClientNetworkError,
	ApiClientResponseError,
	readApiBaseUrl,
} from "./read-transport";

/** Public capability transport: no account token, cookies, redirects, retries or observers. */
export function createVaultSupplyClient(options: {
	baseUrl: string;
	fetch: ApiClientFetch;
	timeoutMs?: number;
}) {
	const timeoutMs = options.timeoutMs ?? 20000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Invalid timeout");
	const api = createClient<paths>({
		baseUrl: readApiBaseUrl(options.baseUrl),
		// Preserve policy in Fetch init too: not every Request implementation
		// retains credentials/referrerPolicy on the constructed Request.
		fetch: (request) =>
			options.fetch(request, {
				credentials: "omit",
				cache: "no-store",
				redirect: "error",
				referrerPolicy: "no-referrer",
			}),
	});
	type Result = components["schemas"]["VaultSecretRequestStatus"];
	async function send(
		token: string,
		input:
			| { kind: "inspect"; fields?: string[] }
			| { kind: "supply"; fields: Record<string, string> },
		caller?: AbortSignal,
	): Promise<Result> {
		if (!/^v2_[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiClientError(422);
		const controller = new AbortController();
		const cancelled = new Error("Request cancelled");
		cancelled.name = "AbortError";
		let reason: Error = cancelled;
		let rejectAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_resolve, reject) => {
			rejectAbort = () => reject(reason);
		});
		const abort = () => {
			controller.abort();
			rejectAbort?.();
		};
		if (caller?.aborted) abort();
		else caller?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => {
			reason = new ApiClientNetworkError("timeout");
			abort();
		}, timeoutMs);
		const perform = async () => {
			if (controller.signal.aborted) throw reason;
			const init = {
				signal: controller.signal,
				credentials: "omit",
				cache: "no-store",
				redirect: "error",
				referrerPolicy: "no-referrer",
			} as const;
			const result =
				input.kind === "supply"
					? await api.POST("/v1/vault/requests/supply", {
							...init,
							body: { token, fields: input.fields },
						})
					: await api.POST("/v1/vault/requests/inspect", {
							...init,
							body: { token, ...(input.fields === undefined ? {} : { fields: input.fields }) },
						});
			if (controller.signal.aborted) throw reason;
			if (!result.response.ok) throw new ApiClientError(result.response.status);
			if (!result.data) throw new ApiClientResponseError();
			return result.data;
		};
		try {
			return await Promise.race([perform(), aborted]);
		} catch (error) {
			if (controller.signal.aborted) throw reason;
			if (error instanceof ApiClientError || error instanceof ApiClientResponseError) throw error;
			throw new ApiClientNetworkError("offline");
		} finally {
			clearTimeout(timer);
			caller?.removeEventListener("abort", abort);
		}
	}
	return {
		inspect: (token: string, fields?: string[], signal?: AbortSignal) =>
			send(token, { kind: "inspect", fields }, signal),
		supply: (token: string, fields: Record<string, string>, signal?: AbortSignal) =>
			send(token, { kind: "supply", fields }, signal),
	};
}
