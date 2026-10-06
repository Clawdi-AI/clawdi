import {
	ApiClientError,
	type ApiClientFetch,
	ApiClientNetworkError,
	ApiClientResponseError,
} from "./read-transport";

export type PublicApiClientOptions = { baseUrl: string; fetch: ApiClientFetch; timeoutMs?: number };
const publicPolicy = {
	credentials: "omit",
	cache: "no-store",
	redirect: "error",
	referrerPolicy: "no-referrer",
} as const;

/** Capability requests never attach account credentials, cookies or observers. */
export function createPublicTransport(options: PublicApiClientOptions) {
	const timeoutMs = options.timeoutMs ?? 20000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("Invalid timeout");
	const fetch: ApiClientFetch = (request) => options.fetch(request, publicPolicy);
	async function read<Data>(
		send: (
			init: typeof publicPolicy & { signal: AbortSignal },
		) => Promise<{ data?: Data; response: Response }>,
		caller?: AbortSignal,
	): Promise<Data> {
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
			const result = await send({ ...publicPolicy, signal: controller.signal });
			if (controller.signal.aborted) throw reason;
			if (!result.response.ok) throw new ApiClientError(result.response.status);
			if (result.data === undefined || result.data === null) throw new ApiClientResponseError();
			return result.data;
		};
		try {
			return await Promise.race([perform(), aborted]);
		} catch (error) {
			if (controller.signal.aborted) throw reason;
			if (error instanceof ApiClientError || error instanceof ApiClientResponseError) throw error;
			if (error instanceof SyntaxError) throw new ApiClientResponseError();
			throw new ApiClientNetworkError("offline");
		} finally {
			clearTimeout(timer);
			caller?.removeEventListener("abort", abort);
		}
	}
	return { fetch, read };
}
