import { type components, extractApiDetail, type paths } from "@clawdi/shared/api";
import createClient, { type Client } from "openapi-fetch";
import { getAuth, getConfig } from "./config";

type SkillUploadResponse = components["schemas"]["SkillUploadResponse"];
type SessionUploadResponse = components["schemas"]["SessionUploadResponse"];

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
	// Snapshot the request once so the body stream survives retries — the
	// very first `fetch` drains `req.body`, after which `req.clone()` would
	// throw `TypeError: cannot clone a disturbed body`. Keeping the base
	// pristine lets us hand a fresh clone to every attempt including the
	// first, even for PUT/PATCH with JSON bodies.
	const base = req.clone();
	let lastErr: ApiError | undefined;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			await sleep(RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		let res: Response;
		try {
			res = await fetch(base.clone(), { signal: controller.signal });
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

	/**
	 * @param opts.requireAuth — Default true. Set false for the device-flow
	 *   login bootstrap, which has to call `/api/cli/auth/device` and
	 *   `/api/cli/auth/poll` before any credentials exist. Unauthenticated
	 *   instances skip the Authorization header entirely.
	 */
	constructor(opts: { requireAuth?: boolean } = {}) {
		const requireAuth = opts.requireAuth ?? true;
		const config = getConfig();
		const auth = getAuth();
		if (requireAuth && !auth) {
			throw new ApiError({
				status: 401,
				body: "",
				hint: "Not logged in. Run `clawdi auth login` first.",
			});
		}
		this.baseUrl = config.apiUrl;
		this.apiKey = auth?.apiKey ?? "";
		this.client = createClient<paths>({
			baseUrl: this.baseUrl,
			fetch: (req) => retryingFetch(req, DEFAULT_TIMEOUT_MS),
		});
		this.client.use({
			onRequest: ({ request }) => {
				if (this.apiKey) {
					request.headers.set("Authorization", `Bearer ${this.apiKey}`);
				}
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

	/**
	 * Upload a skill archive (`.tar.gz`) to `/api/skills/upload`. openapi-fetch
	 * can't model multipart today, so this stays hand-rolled — but the
	 * response shape is still typed from the generated schema.
	 */
	async uploadSkill(
		skillKey: string,
		file: Buffer,
		filename: string,
		contentHash?: string,
	): Promise<SkillUploadResponse> {
		// `content_hash` is optional server-side (added 0.3.4). Omit the
		// field entirely when the caller doesn't have one — server falls
		// back to computing it from the uploaded tar.
		const fields: Record<string, string> = { skill_key: skillKey };
		if (contentHash) fields.content_hash = contentHash;
		return this.multipartPost<SkillUploadResponse>("/api/skills/upload", fields, file, filename);
	}

	/** Upload per-session content JSON to `/api/sessions/{id}/upload`. */
	async uploadSessionContent(
		localSessionId: string,
		file: Buffer,
		filename: string,
	): Promise<SessionUploadResponse> {
		return this.multipartPost<SessionUploadResponse>(
			`/api/sessions/${encodeURIComponent(localSessionId)}/upload`,
			{},
			file,
			filename,
		);
	}

	/** Download session content (an array of messages) from the cloud. */
	async getSessionContent(sessionId: string): Promise<Buffer> {
		return this.getBytes(`/api/sessions/${encodeURIComponent(sessionId)}/content`);
	}

	/** Shared multipart POST; never retried (non-idempotent). */
	private async multipartPost<T>(
		path: string,
		fields: Record<string, string>,
		file: Buffer,
		filename: string,
	): Promise<T> {
		const formData = new FormData();
		for (const [k, v] of Object.entries(fields)) formData.append(k, v);
		// Buffer → Uint8Array: Buffer's `ArrayBufferLike` doesn't satisfy
		// `BlobPart` under strict TS (`SharedArrayBuffer` vs `ArrayBuffer`).
		// Wrapping narrows it without a cast.
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
 *
 * On 2xx-with-no-body the return is `undefined as T`. The backend always
 * returns a typed response envelope, so this is a belt-and-braces fallback
 * rather than a routine case — a caller that dereferences `.foo` on a
 * true 204 will runtime-crash, which is the right failure mode for a
 * contract violation.
 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
	if (result.error !== undefined) {
		throw new ApiError({
			status: result.response.status,
			body: extractApiDetail(result.error),
			hint: hintFor(result.response.status),
		});
	}
	return result.data as T;
}
