export class FetchTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`request timed out after ${timeoutMs}ms`);
		this.name = "FetchTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export async function timedFetch(
	input: RequestInfo | URL,
	init: RequestInit = {},
	timeoutMs: number,
): Promise<Response> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error("fetch timeout must be a positive finite number");
	}
	const controller = new AbortController();
	const externalSignal = init.signal;
	const onExternalAbort = () => controller.abort(externalSignal?.reason);
	if (externalSignal?.aborted) controller.abort(externalSignal.reason);
	else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const response = await fetch(input, { ...init, signal: controller.signal });
		const body = await response.arrayBuffer();
		const method = init.method?.toUpperCase();
		const hasNullBody =
			method === "HEAD" ||
			response.status === 204 ||
			response.status === 205 ||
			response.status === 304;
		return new Response(hasNullBody ? null : body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error) {
		if (timedOut) throw new FetchTimeoutError(timeoutMs);
		throw error;
	} finally {
		clearTimeout(timer);
		externalSignal?.removeEventListener("abort", onExternalAbort);
	}
}
