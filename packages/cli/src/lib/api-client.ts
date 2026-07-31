import { randomUUID } from "node:crypto";
import { type components, extractApiDetail, type paths } from "@clawdi/shared/api";
import createClient, { type Client } from "openapi-fetch";
import { canonicalApiOrigin, normalizeCloudApiBaseUrl } from "./api-origin";
import { assertCloudCredentialEndpoint, getClawdiAccessToken } from "./clerk-oauth";
import { getAuth, getConfig } from "./config";
import { MAX_SAFE_RETRY_AFTER_MS, parseRetryAfter } from "./retry-after";
import { assertValidSkillKey } from "./skill-key";
import {
	SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
	SKILL_SYNC_PROTOCOL_HEADER,
} from "./skill-sync-protocol";
import { getCliVersion } from "./version";

type SkillUploadResponse = components["schemas"]["SkillUploadResponse"];
type SessionUploadResponse = components["schemas"]["SessionUploadResponse"];

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [100, 400, 1600] as const;
const USER_AGENT = `clawdi-cli/${getCliVersion()}`;
// Node-compatible timers cannot safely schedule a single delay above this
// value. Longer Retry-After waits are split into chunks without changing the
// server-requested REST delay.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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

/** A dedicated Agent Skill sync request returned 404.
 *
 * The response is deliberately ambiguous: a pre-authority backend may not
 * expose the route, while a current backend uses the same status to hide an
 * Agent identity the caller cannot prove. Callers must fail closed in both
 * cases. Durable projection queues keep this unresolved rather than issuing a
 * generic Project mutation or treating absence as success. */
export class AgentSkillSyncNotFoundError extends ApiError {
	constructor(body: string) {
		super({ status: 404, body, hint: hintFor(404) });
		this.name = "AgentSkillSyncNotFoundError";
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		let remainingMs = ms;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			if (timer !== undefined) clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const scheduleNextChunk = () => {
			if (remainingMs <= 0) {
				signal?.removeEventListener("abort", onAbort);
				resolve();
				return;
			}
			const chunkMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
			timer = setTimeout(() => {
				remainingMs -= chunkMs;
				scheduleNextChunk();
			}, chunkMs);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		scheduleNextChunk();
	});
}

// GET/HEAD/PUT/DELETE are safe to retry on 5xx + network errors; POST/PATCH
// skip retry because they may have side effects.
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);

export async function retryingFetch(
	req: Request,
	timeoutMs: number,
	externalSignal: AbortSignal | undefined,
): Promise<Response> {
	const retry = IDEMPOTENT_METHODS.has(req.method);
	const maxAttempts = retry ? MAX_RETRIES : 1;
	// Snapshot the request once so the body stream survives retries — the
	// very first `fetch` drains `req.body`, after which `req.clone()` would
	// throw `TypeError: cannot clone a disturbed body`. Keeping the base
	// pristine lets us hand a fresh clone to every attempt including the
	// first, even for PUT/PATCH with JSON bodies.
	const base = req.clone();
	let lastErr: ApiError | undefined;

	// External-signal short-circuit — stop retrying immediately
	// when the caller (e.g., the daemon's engine abort on SSE
	// auth failure) cancels. Without this, an in-flight call
	// keeps retrying on its own timeout long after the daemon
	// has decided to exit.
	if (externalSignal?.aborted) {
		throw new ApiError({
			status: 0,
			body: "aborted",
			hint: "Request aborted by caller.",
			isNetwork: true,
		});
	}

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			try {
				await sleep(
					RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)],
					externalSignal,
				);
			} catch {
				throw new ApiError({
					status: 0,
					body: "aborted",
					hint: "Request aborted between retries.",
					isNetwork: true,
				});
			}
			if (externalSignal?.aborted) {
				throw new ApiError({
					status: 0,
					body: "aborted",
					hint: "Request aborted between retries.",
					isNetwork: true,
				});
			}
		}

		// Combine per-request timeout with the external (daemon)
		// abort signal. Either firing cancels the in-flight fetch.
		const controller = new AbortController();
		const onExternalAbort = () => controller.abort();
		if (externalSignal) {
			if (externalSignal.aborted) controller.abort();
			else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
		}
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);

		let buffered: Response;
		try {
			const res = await fetch(base.clone(), { signal: controller.signal });
			// Own the complete REST response lifecycle here. Returning the
			// network-backed Response would detach the timeout and caller abort
			// before openapi-fetch (or a hand-written caller) consumes the body.
			// Buffering keeps cancellation effective through JSON, text, and
			// binary bodies, including error responses that are retried below.
			const body = await res.arrayBuffer();
			const hasNullBody =
				base.method === "HEAD" || res.status === 204 || res.status === 205 || res.status === 304;
			buffered = new Response(hasNullBody ? null : body, {
				status: res.status,
				statusText: res.statusText,
				headers: res.headers,
			});
		} catch (e: unknown) {
			if (externalSignal?.aborted) {
				throw new ApiError({
					status: 0,
					body: "aborted",
					hint: "Request aborted by caller.",
					isNetwork: true,
				});
			}
			const err = e as { name?: string; message?: string };
			const isTimeout = timedOut;
			lastErr = new ApiError({
				status: 0,
				body: err?.message ?? String(e),
				hint: isTimeout ? "Request timed out; the service may be slow or unreachable." : hintFor(0),
				isNetwork: true,
				isTimeout,
			});
			if (retry) continue;
			throw lastErr;
		} finally {
			clearTimeout(timer);
			if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
		}

		if (buffered.ok) return buffered;

		if (buffered.status === 429 && retry && attempt < maxAttempts - 1) {
			const retryAfterMs = parseRetryAfter(buffered.headers.get("retry-after"), {
				maxMs: MAX_SAFE_RETRY_AFTER_MS,
			});
			if (retryAfterMs !== null) {
				try {
					await sleep(retryAfterMs, externalSignal);
				} catch {
					throw new ApiError({
						status: 0,
						body: "aborted",
						hint: "Request aborted by caller.",
						isNetwork: true,
					});
				}
			}
			continue;
		}

		if (buffered.status >= 500 && retry && attempt < maxAttempts - 1) continue;

		return buffered;
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
	private readonly client: Client<paths>;
	private readonly abortSignal: AbortSignal | undefined;
	private readonly requireAuth: boolean;

	/**
	 * @param opts.requireAuth — Default true. Set false for public bootstrap
	 *   calls that run before credentials exist. Unauthenticated instances
	 *   skip the Authorization header entirely.
	 * @param opts.abortSignal — Optional engine-wide abort. When the
	 *   daemon's main `AbortController` fires (SSE auth failure,
	 *   shutdown), every in-flight ApiClient request unwinds
	 *   immediately instead of running its own retry/timeout to
	 *   completion.
	 */
	constructor(opts: { requireAuth?: boolean; abortSignal?: AbortSignal } = {}) {
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
		const baseUrl = normalizeCloudApiBaseUrl(config.apiUrl);
		this.baseUrl = baseUrl;
		this.requireAuth = requireAuth;
		this.abortSignal = opts.abortSignal;
		this.client = createClient<paths>({
			baseUrl: this.baseUrl,
			fetch: (req) => retryingFetch(req, DEFAULT_TIMEOUT_MS, this.abortSignal),
		});
		this.client.use({
			async onRequest({ request }) {
				if (requireAuth) {
					if (new URL(request.url).origin !== canonicalApiOrigin(baseUrl)) {
						throw new ApiError({
							status: 0,
							body: "",
							hint: "Cloud request origin changed before authorization. No credential was sent.",
						});
					}
					request.headers.set("Authorization", `Bearer ${await getClawdiAccessToken(baseUrl)}`);
				}
				request.headers.set("User-Agent", USER_AGENT);
				request.headers.set(SKILL_SYNC_PROTOCOL_HEADER, SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1);
				// Generate a per-request correlation ID. Backend's
				// RequestIDMiddleware accepts the header and echoes
				// it on the response + every log line, so an oncall
				// engineer can trace a CLI failure back to the exact
				// backend request without guessing. Pre-fix CLI
				// only sent Authorization, leaving CLI logs and
				// backend logs unjoinable.
				if (!request.headers.has("X-Request-ID")) {
					request.headers.set("X-Request-ID", randomUUID());
				}
				return request;
			},
		});
	}

	/** Current bearer snapshot for compatibility helpers; requests refresh it asynchronously. */
	get apiKey(): string {
		const auth = getAuth();
		if (!auth) return "";
		assertCloudCredentialEndpoint(auth, this.baseUrl);
		return auth.apiKey;
	}

	async getAccessToken(): Promise<string> {
		return this.requireAuth ? getClawdiAccessToken(this.baseUrl) : "";
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
	 * Upload a skill archive (`.tar.gz`) into the named project.
	 * One env binds to one project, so a daemon's writes always land
	 * in its own env's project. Single writer per env means no
	 * If-Match needed; last-write-wins by definition. openapi-fetch
	 * can't model multipart today, so this stays hand-rolled — but
	 * the response shape is still typed from the generated schema.
	 */
	async uploadSkill(
		projectId: string,
		skillKey: string,
		file: Buffer,
		filename: string,
		contentHash?: string,
	): Promise<SkillUploadResponse> {
		assertValidSkillKey(skillKey);
		// `content_hash` is optional server-side (added 0.3.4). Omit the
		// field entirely when the caller doesn't have one — server falls
		// back to computing it from the uploaded tar.
		const fields: Record<string, string> = { skill_key: skillKey };
		if (contentHash) fields.content_hash = contentHash;
		return this.multipartPost<SkillUploadResponse>(
			`/v1/projects/${encodeURIComponent(projectId)}/skills/upload`,
			fields,
			file,
			filename,
		);
	}

	/**
	 * Project a Skill authored in an Agent filesystem. The Agent id is the
	 * authority boundary; the server derives and fences the owning Project.
	 * Keep this separate from uploadSkill(): the project route remains the
	 * compatibility/cloud boundary and must never be used by new daemon code.
	 * The Project id remains in the call contract as the caller's durable queue
	 * fence, but is intentionally not sent as upload authority.
	 */
	async uploadAgentSkill(
		agentId: string,
		_projectId: string,
		skillKey: string,
		file: Buffer,
		filename: string,
		contentHash?: string,
	): Promise<SkillUploadResponse> {
		assertValidSkillKey(skillKey);
		const fields: Record<string, string> = { skill_key: skillKey };
		if (contentHash) fields.content_hash = contentHash;
		try {
			return await this.multipartPost<SkillUploadResponse>(
				`/v1/agents/${encodeURIComponent(agentId)}/skills/sync/upload`,
				fields,
				file,
				filename,
			);
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) {
				throw new AgentSkillSyncNotFoundError(error.body);
			}
			throw error;
		}
	}

	/** Report that an Agent-authoritative local Skill is absent. Idempotent. */
	async deleteAgentSkill(agentId: string, skillKey: string, projectId: string): Promise<void> {
		assertValidSkillKey(skillKey);
		const url = new URL(
			`${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}/skills/sync/${encodeURIComponent(skillKey)}`,
		);
		url.searchParams.set("project_id", projectId);
		const accessToken = await this.getAccessToken();
		const req = new Request(url, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"User-Agent": USER_AGENT,
				"X-Request-ID": randomUUID(),
				[SKILL_SYNC_PROTOCOL_HEADER]: SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
			},
		});
		const res = await retryingFetch(req, DEFAULT_TIMEOUT_MS, this.abortSignal);
		if (!res.ok) {
			const body = await res.text();
			if (res.status === 404) throw new AgentSkillSyncNotFoundError(body);
			throw new ApiError({ status: res.status, body, hint: hintFor(res.status) });
		}
	}

	/** Upload per-session content JSON to `/v1/sessions/{id}/upload`. */
	async uploadSessionContent(
		localSessionId: string,
		file: Buffer,
		filename: string,
	): Promise<SessionUploadResponse> {
		return this.multipartPost<SessionUploadResponse>(
			`/v1/sessions/${encodeURIComponent(localSessionId)}/upload`,
			{},
			file,
			filename,
		);
	}

	/** Download session content (an array of messages) from the cloud. */
	async getSessionContent(sessionId: string): Promise<Buffer> {
		return this.getBytes(`/v1/sessions/${encodeURIComponent(sessionId)}/content`);
	}

	/** Shared multipart POST; never retried (non-idempotent). */
	private async multipartPost<T>(
		path: string,
		fields: Record<string, string>,
		file: Buffer,
		filename: string,
		extraHeaders?: Record<string, string>,
	): Promise<T> {
		const accessToken = await this.getAccessToken();
		const formData = new FormData();
		for (const [k, v] of Object.entries(fields)) formData.append(k, v);
		// Buffer → Uint8Array: Buffer's `ArrayBufferLike` doesn't satisfy
		// `BlobPart` under strict TS (`SharedArrayBuffer` vs `ArrayBuffer`).
		// Wrapping narrows it without a cast.
		formData.append("file", new Blob([new Uint8Array(file)]), filename);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		// Mirror engine-wide abort onto this upload's controller so
		// `clawdi daemon` shutdown doesn't wait the full 30s timeout
		// for an in-flight upload to give up. Pre-fix the runtime
		// would hang on the active multipart fetch even after the
		// engine signalled abort, delaying SIGTERM cleanup and
		// frustrating systemd / launchd's restart cadence.
		const onEngineAbort = () => controller.abort();
		this.abortSignal?.addEventListener("abort", onEngineAbort, { once: true });
		try {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${accessToken}`,
				"User-Agent": USER_AGENT,
				[SKILL_SYNC_PROTOCOL_HEADER]: SKILL_SYNC_PROTOCOL_AGENT_AUTHORITATIVE_V1,
				...(extraHeaders ?? {}),
			};
			const res = await fetch(`${this.baseUrl}${path}`, {
				method: "POST",
				headers,
				body: formData,
				signal: controller.signal,
			});
			if (!res.ok) {
				const body = await res.text();
				throw new ApiError({ status: res.status, body, hint: hintFor(res.status) });
			}
			return await readJson<T>(res, "multipart upload response");
		} finally {
			clearTimeout(timer);
			this.abortSignal?.removeEventListener("abort", onEngineAbort);
		}
	}

	async postJson<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
		const accessToken = await this.getAccessToken();
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, value);
		}
		const req = new Request(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"X-Request-ID": randomUUID(),
			},
		});
		const res = await retryingFetch(req, DEFAULT_TIMEOUT_MS, this.abortSignal);
		if (!res.ok) {
			const body = await res.text();
			throw new ApiError({ status: res.status, body, hint: hintFor(res.status) });
		}
		return await readJson<T>(res, path);
	}

	async postJsonBody<T>(
		path: string,
		body: unknown,
		query?: Record<string, string | undefined>,
	): Promise<T> {
		const accessToken = await this.getAccessToken();
		const url = new URL(`${this.baseUrl}${path}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, value);
		}
		const req = new Request(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"X-Request-ID": randomUUID(),
			},
			body: JSON.stringify(body),
		});
		const res = await retryingFetch(req, DEFAULT_TIMEOUT_MS, this.abortSignal);
		if (!res.ok) {
			const responseBody = await res.text();
			throw new ApiError({ status: res.status, body: responseBody, hint: hintFor(res.status) });
		}
		return await readJson<T>(res, path);
	}

	async getBytes(path: string, extraHeaders?: Record<string, string>): Promise<Buffer> {
		const accessToken = await this.getAccessToken();
		const req = new Request(`${this.baseUrl}${path}`, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...(extraHeaders ?? {}),
			},
		});
		const res = await retryingFetch(req, DEFAULT_TIMEOUT_MS, this.abortSignal);
		if (!res.ok) {
			const body = await res.text();
			throw new ApiError({ status: res.status, body, hint: hintFor(res.status) });
		}
		return Buffer.from(await res.arrayBuffer());
	}
}

export async function readJson<T>(res: Response, context = "API response"): Promise<T> {
	try {
		return (await res.json()) as T;
	} catch {
		throw new ApiError({
			status: res.status,
			body: `${context} returned an invalid JSON response`,
			hint: hintFor(res.status),
		});
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
