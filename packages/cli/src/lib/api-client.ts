import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./api-types.generated";
import { getAuth, getConfig } from "./config";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [100, 400, 1600] as const;

/** Error thrown by ApiClient. Carries HTTP status and a human-facing hint. */
export class ApiError extends Error {
	readonly status: number;
	readonly hint: string;
	readonly body: string;
	readonly isNetwork: boolean;
	readonly isTimeout: boolean;

	constructor(opts: {
		status: number;
		body: string;
		hint: string;
		isNetwork?: boolean;
		isTimeout?: boolean;
	}) {
		super(`API error ${opts.status}: ${opts.body || opts.hint}`);
		this.name = "ApiError";
		this.status = opts.status;
		this.body = opts.body;
		this.hint = opts.hint;
		this.isNetwork = opts.isNetwork ?? false;
		this.isTimeout = opts.isTimeout ?? false;
	}
}

function hintFor(status: number): string {
	if (status === 401) return "Run `clawdi auth login` to authenticate.";
	if (status === 403) return "Your API key does not have permission for this action.";
	if (status === 404) return "Resource not found; double-check the name or path.";
	if (status === 429) return "Rate limited; retry after a short wait.";
	if (status >= 500) return "Service unavailable; retry later or run `clawdi doctor`.";
	if (status === 0) return "Network error; check connectivity and `CLAWDI_API_URL`.";
	return "";
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// GET/HEAD/PUT/DELETE are safe to retry on 5xx + network errors; POST/PATCH
// skip retry because they may have side effects.
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

async function retryingFetch(req: Request, timeoutMs: number): Promise<Response> {
	const retry = IDEMPOTENT_METHODS.has(req.method);
	const maxAttempts = retry ? MAX_RETRIES : 1;
	let lastErr: ApiError | undefined;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		let res: Response;
		try {
			res = await fetch(attempt === 0 ? req : req.clone(), { signal: controller.signal });
		} catch (e: unknown) {
			clearTimeout(timer);
			const err = e as { name?: string; message?: string };
			const isTimeout = err?.name === "AbortError";
			lastErr = new ApiError({
				status: 0,
				body: err?.message ?? String(e),
				hint: isTimeout ? "Request timed out; the service may be slow or unreachable." : hintFor(0),
				isNetwork: true,
				isTimeout,
			});
			if (retry) continue;
			throw lastErr;
		}
		clearTimeout(timer);

		if (res.ok) return res;

		if (res.status === 429 && retry && attempt < maxAttempts - 1) {
			const retryAfter = Number(res.headers.get("retry-after"));
			if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(retryAfter * 1000);
			continue;
		}

		if (res.status >= 500 && retry && attempt < maxAttempts - 1) continue;

		return res;
	}

	throw (
		lastErr ?? new ApiError({ status: 0, body: "unknown error", hint: hintFor(0), isNetwork: true })
	);
}

function extractDetail(err: unknown): string {
	if (typeof err === "object" && err !== null && "detail" in err) {
		const d = (err as { detail: unknown }).detail;
		if (typeof d === "string") return d;
		if (Array.isArray(d)) {
			return d
				.map((e) => {
					const loc = Array.isArray((e as { loc?: unknown[] })?.loc)
						? ((e as { loc: unknown[] }).loc as unknown[]).join(".")
						: "";
					const msg = (e as { msg?: string })?.msg ?? "";
					return loc ? `${loc}: ${msg}` : msg;
				})
				.filter(Boolean)
				.join("; ");
		}
	}
	return typeof err === "string" ? err : JSON.stringify(err);
}

/**
 * openapi-fetch client configured for the CLI: `Authorization: Bearer`
 * auth, network + 5xx retry, and per-request timeout. Typecheck sees the
 * full OpenAPI `paths` map, so call sites never pass a manual generic.
 *
 * Use together with `unwrap()` to get a plain `data` value + thrown
 * `ApiError` on non-2xx responses — same pattern as the web client.
 */
export class ApiClient {
	readonly baseUrl: string;
	readonly apiKey: string;
	private readonly client: Client<paths>;

	constructor() {
		const config = getConfig();
		const auth = getAuth();
		if (!auth) {
			throw new ApiError({
				status: 401,
				body: "",
				hint: "Not logged in. Run `clawdi auth login` first.",
			});
		}
		this.baseUrl = config.apiUrl;
		this.apiKey = auth.apiKey;
		this.client = createClient<paths>({
			baseUrl: this.baseUrl,
			fetch: (req) => retryingFetch(req, DEFAULT_TIMEOUT_MS),
		});
		this.client.use({
			onRequest: ({ request }) => {
				request.headers.set("Authorization", `Bearer ${this.apiKey}`);
				return request;
			},
		});
	}

	get GET(): Client<paths>["GET"] {
		return this.client.GET.bind(this.client);
	}
	get POST(): Client<paths>["POST"] {
		return this.client.POST.bind(this.client);
	}
	get PUT(): Client<paths>["PUT"] {
		return this.client.PUT.bind(this.client);
	}
	get DELETE(): Client<paths>["DELETE"] {
		return this.client.DELETE.bind(this.client);
	}
	get PATCH(): Client<paths>["PATCH"] {
		return this.client.PATCH.bind(this.client);
	}

	/** Multipart upload; never retried (non-idempotent). */
	async uploadFile<T>(
		path: string,
		fields: Record<string, string>,
		file: Buffer,
		filename: string,
	): Promise<T> {
		const formData = new FormData();
		for (const [k, v] of Object.entries(fields)) formData.append(k, v);
		formData.append("file", new Blob([new Uint8Array(file)]), filename);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		try {
			const res = await fetch(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${this.apiKey}` },
				body: formData,
				signal: controller.signal,
			});
			if (!res.ok) {
				const body = await res.text();
				throw new ApiError({ status: res.status, body, hint: hintFor(res.status) });
			}
			return (await res.json()) as T;
		} finally {
			clearTimeout(timer);
		}
	}

	async getBytes(path: string): Promise<Buffer> {
		const req = new Request(`${this.baseUrl}${path}`, {
			headers: { Authorization: `Bearer ${this.apiKey}` },
		});
		const res = await retryingFetch(req, DEFAULT_TIMEOUT_MS);
		if (!res.ok) {
			const body = await res.text();
			throw new ApiError({ status: res.status, body, hint: hintFor(res.status) });
		}
		return Buffer.from(await res.arrayBuffer());
	}
}

/**
 * Unwrap an openapi-fetch result: throw `ApiError` on non-2xx, return
 * `data` otherwise. Mirrors the web helper so call sites look identical.
 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
	if (result.error !== undefined) {
		throw new ApiError({
			status: result.response.status,
			body: extractDetail(result.error),
			hint: hintFor(result.response.status),
		});
	}
	return (result.data as T) ?? (undefined as T);
}
