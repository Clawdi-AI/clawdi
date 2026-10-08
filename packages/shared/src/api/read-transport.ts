export type ApiClientFetch = (request: Request, init?: RequestInit) => Promise<Response>;

export type ApiClientOptions = {
	baseUrl: string;
	getToken: () => Promise<string | null>;
	fetch: ApiClientFetch;
	timeoutMs?: number;
	observeResponse?: (response: Response) => Promise<void> | void;
};

export class ApiClientError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string | null = null,
		public readonly retryAfterMs: number | null = null,
	) {
		super(`API request failed (${status})`);
		this.name = "ApiClientError";
	}

	get category() {
		if (this.status === 401) return "unauthenticated";
		if (this.status === 403) return "forbidden";
		if (this.status === 404) return "not_found";
		if (this.status === 409 || this.status === 412) return "conflict";
		if (this.status === 429) return "rate_limited";
		if (this.status >= 500) return "server";
		return "invalid_request";
	}
}

export class ApiClientNetworkError extends Error {
	constructor(public readonly kind: "timeout" | "offline") {
		super(kind === "timeout" ? "API request timed out" : "API request failed");
		this.name = "ApiClientNetworkError";
	}
}

export class ApiClientResponseError extends Error {
	constructor() {
		super("API response could not be read");
		this.name = "ApiClientResponseError";
	}
}

type ReadResult<Data> = { data?: Data; error?: unknown; response: Response };
type AuthenticatedReadOptions = { headers: { Authorization: string }; signal: AbortSignal };

// RFC HTTP-date formats, matching the CLI's Retry-After parser.
const HTTP_DATE_PATTERN = new RegExp(
	"^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \\d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{4} \\d{2}:\\d{2}:\\d{2} GMT|" +
		"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\\d{2} \\d{2}:\\d{2}:\\d{2} GMT|" +
		"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:\\d{2}| \\d) \\d{2}:\\d{2}:\\d{2} \\d{4})$",
);

function retryAfterMs(response: Response): number | null {
	const header = response.headers.get("Retry-After")?.trim();
	if (!header) return null;
	const delay = /^\d+$/.test(header)
		? Number(header) * 1000
		: HTTP_DATE_PATTERN.test(header)
			? Math.max(0, Date.parse(header) - Date.now())
			: Number.NaN;
	// Timers cannot represent longer delays. Leave those responses for an explicit retry.
	return Number.isFinite(delay) && delay >= 0 && delay <= 2_147_483_647 ? delay : null;
}

function errorCode(value: unknown): string | null {
	if (typeof value !== "object" || value === null) return null;
	if ("code" in value && typeof value.code === "string") return value.code;
	if ("detail" in value) return errorCode(value.detail);
	return null;
}

export function readApiBaseUrl(baseUrl: string, hosted = false): string {
	const url = new URL(baseUrl);
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new TypeError(
			"API base URL must be an HTTP(S) URL without credentials, query or fragment",
		);
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	if (hosted) url.pathname = url.pathname.replace(/\/v2$/, "");
	return url.toString().replace(/\/$/, "");
}

export function readResourceId(value: string): string {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim() ||
		value === "." ||
		value === ".."
	) {
		throw new ApiClientError(400, "invalid_resource_id");
	}
	return value;
}

export function createReadTransport(options: ApiClientOptions) {
	const timeoutMs = options.timeoutMs ?? 20_000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new TypeError("API timeout must be a positive finite number");
	}

	const fetch: ApiClientFetch = async (request, init) => {
		let response: Response;
		try {
			response = await options.fetch(request, init);
		} catch {
			throw new ApiClientNetworkError("offline");
		}
		if (request.signal.aborted) throw new ApiClientNetworkError("offline");
		if (options.observeResponse) {
			try {
				await options.observeResponse(response.clone());
			} catch {
				throw new ApiClientResponseError();
			}
		}
		return response;
	};

	const read = async <Data>(
		send: (init: AuthenticatedReadOptions) => Promise<ReadResult<Data>>,
		caller?: AbortSignal,
	): Promise<Data> => {
		const controller = new AbortController();
		const cancelled = new Error("API request cancelled");
		cancelled.name = "AbortError";
		let abortReason: unknown = cancelled;
		const onCallerAbort = () => {
			if (controller.signal.aborted) return;
			abortReason = caller?.reason ?? cancelled;
			controller.abort();
		};
		if (caller?.aborted) onCallerAbort();
		else caller?.addEventListener("abort", onCallerAbort, { once: true });
		const checkAborted = () => {
			if (controller.signal.aborted) throw abortReason;
		};
		const timeout = setTimeout(() => {
			if (controller.signal.aborted) return;
			abortReason = new ApiClientNetworkError("timeout");
			controller.abort();
		}, timeoutMs);
		let rejectAborted: (() => void) | undefined;
		const aborted = new Promise<never>((_resolve, reject) => {
			rejectAborted = () => reject(abortReason);
			if (controller.signal.aborted) rejectAborted();
			else controller.signal.addEventListener("abort", rejectAborted, { once: true });
		});
		const perform = async () => {
			checkAborted();
			let token: string | null;
			try {
				token = await options.getToken();
			} catch {
				checkAborted();
				throw new ApiClientError(401, "token_unavailable");
			}
			checkAborted();
			if (typeof token !== "string" || !token || token !== token.trim() || /[\r\n]/.test(token)) {
				throw new ApiClientError(401, "authentication_required");
			}
			const result = await send({
				headers: { Authorization: `Bearer ${token}` },
				signal: controller.signal,
			});
			checkAborted();
			if (!result.response.ok) {
				throw new ApiClientError(
					result.response.status,
					errorCode(result.error),
					retryAfterMs(result.response),
				);
			}
			if (result.data === undefined) throw new ApiClientResponseError();
			return result.data;
		};
		try {
			return await Promise.race([perform(), aborted]);
		} catch (error) {
			checkAborted();
			if (
				error instanceof ApiClientError ||
				error instanceof ApiClientNetworkError ||
				error instanceof ApiClientResponseError
			) {
				throw error;
			}
			if (error instanceof SyntaxError) throw new ApiClientResponseError();
			throw new ApiClientNetworkError("offline");
		} finally {
			clearTimeout(timeout);
			caller?.removeEventListener("abort", onCallerAbort);
			if (rejectAborted) controller.signal.removeEventListener("abort", rejectAborted);
		}
	};

	return { fetch, read };
}
