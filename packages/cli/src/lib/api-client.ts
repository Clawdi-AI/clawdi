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

/** Whether a request should be retried on 5xx / network failure. Upload calls opt out. */
interface RequestOptions extends RequestInit {
	retry?: boolean;
	timeoutMs?: number;
}

export class ApiClient {
	private baseUrl: string;
	private apiKey: string;

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
	}

	private async fetchWithTimeout(
		url: string,
		init: RequestInit,
		timeoutMs: number,
	): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await fetch(url, { ...init, signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}
	}

	private async requestOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
		try {
			return await this.fetchWithTimeout(url, init, timeoutMs);
		} catch (e: unknown) {
			const err = e as { name?: string; message?: string };
			const isTimeout = err?.name === "AbortError";
			throw new ApiError({
				status: 0,
				body: err?.message ?? String(e),
				hint: isTimeout ? "Request timed out; the service may be slow or unreachable." : hintFor(0),
				isNetwork: true,
				isTimeout,
			});
		}
	}

	private async send(
		path: string,
		init: RequestInit,
		opts: { retry: boolean; timeoutMs: number },
	): Promise<Response> {
		const url = `${this.baseUrl}${path}`;
		const maxAttempts = opts.retry ? MAX_RETRIES : 1;
		let lastErr: ApiError | undefined;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (attempt > 0) {
				const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
				await sleep(delay);
			}

			let res: Response;
			try {
				res = await this.requestOnce(url, init, opts.timeoutMs);
			} catch (e) {
				lastErr = e as ApiError;
				if (opts.retry) continue;
				throw e;
			}

			if (res.ok) return res;

			if (res.status === 429 && opts.retry) {
				const retryAfter = Number(res.headers.get("retry-after"));
				if (Number.isFinite(retryAfter) && retryAfter > 0) {
					await sleep(retryAfter * 1000);
					continue;
				}
			}

			if (res.status >= 500 && opts.retry && attempt < maxAttempts - 1) {
				const body = await res.text();
				lastErr = new ApiError({ status: res.status, body, hint: hintFor(res.status) });
				continue;
			}

			const body = await res.text();
			throw new ApiError({ status: res.status, body, hint: hintFor(res.status) });
		}

		throw (
			lastErr ?? new ApiError({ status: 0, body: "unknown", hint: hintFor(0), isNetwork: true })
		);
	}

	async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
		const { retry, timeoutMs, ...init } = options;
		const res = await this.send(
			path,
			{
				...init,
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
					...(init.headers ?? {}),
				},
			},
			{ retry: retry ?? true, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS },
		);
		return (await res.json()) as T;
	}

	async get<T>(path: string): Promise<T> {
		return this.request<T>(path);
	}

	async post<T>(path: string, body?: unknown, opts?: { retry?: boolean }): Promise<T> {
		return this.request<T>(path, {
			method: "POST",
			body: body ? JSON.stringify(body) : undefined,
			// Default: don't retry POST; callers with read-only / idempotent POSTs can opt in.
			retry: opts?.retry ?? false,
		});
	}

	async delete<T>(path: string): Promise<T> {
		return this.request<T>(path, { method: "DELETE", retry: false });
	}

	/** Multipart upload; never retried (non-idempotent). */
	async uploadFile<T>(
		path: string,
		fields: Record<string, string>,
		file: Buffer,
		filename: string,
	): Promise<T> {
		const formData = new FormData();
		for (const [k, v] of Object.entries(fields)) {
			formData.append(k, v);
		}
		formData.append("file", new Blob([new Uint8Array(file)]), filename);

		const res = await this.send(
			path,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${this.apiKey}` },
				body: formData,
			},
			{ retry: false, timeoutMs: DEFAULT_TIMEOUT_MS },
		);
		return (await res.json()) as T;
	}

	async getBytes(path: string): Promise<Buffer> {
		const res = await this.send(
			path,
			{
				headers: { Authorization: `Bearer ${this.apiKey}` },
			},
			{ retry: true, timeoutMs: DEFAULT_TIMEOUT_MS },
		);
		return Buffer.from(await res.arrayBuffer());
	}
}
