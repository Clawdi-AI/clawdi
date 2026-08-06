import { createHash } from "node:crypto";
import { auth } from "@clerk/tanstack-react-start/server";
import { env } from "@/lib/env";
import { sanitizeFilesReturnPath } from "./files-authorize-route";

const FILES_ASSERTION_HEADER = "X-JWT-Assertion";
const FILES_ROUTE_PROOF_HEADER = "X-Clawdi-Files-Route-Proof";
const FILES_HOST_HEADER = "X-Clawdi-Files-Host";
const FILES_URI_HEADER = "X-Clawdi-Files-Uri";
const FORWARDED_HOST_HEADER = "X-Forwarded-Host";
const FORWARDED_PROTO_HEADER = "X-Forwarded-Proto";
const FORWARDED_URI_HEADER = "X-Forwarded-Uri";
const DEPLOYMENT_ID_PATTERN = /^[1-9][0-9]*$/;
const ROUTE_PROOF_PATTERN = /^[0-9a-f]{64}$/;
const DNS_NAME_PATTERN =
	/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ASSERTION_CACHE_MAX_ENTRIES = 1024;
const ASSERTION_CACHE_SAFETY_MILLISECONDS = 5_000;

type CachedAssertion = { assertion: string; expiresAtMilliseconds: number };

export class FilesAssertionCache {
	private readonly entries = new Map<string, CachedAssertion>();
	private readonly pending = new Map<string, Promise<CachedAssertion>>();

	constructor(
		private readonly maxEntries = ASSERTION_CACHE_MAX_ENTRIES,
		private readonly safetyMilliseconds = ASSERTION_CACHE_SAFETY_MILLISECONDS,
	) {
		if (maxEntries < 1 || safetyMilliseconds < 0) {
			throw new Error("Files assertion cache configuration is invalid");
		}
	}

	async getOrLoad(
		key: string,
		nowMilliseconds: number,
		load: () => Promise<CachedAssertion>,
	): Promise<CachedAssertion> {
		const existing = this.entries.get(key);
		if (existing && existing.expiresAtMilliseconds - this.safetyMilliseconds > nowMilliseconds) {
			this.entries.delete(key);
			this.entries.set(key, existing);
			return existing;
		}
		if (existing) this.entries.delete(key);

		const inFlight = this.pending.get(key);
		if (inFlight) return await inFlight;
		if (this.pending.size >= this.maxEntries) {
			throw new Error("Files assertion cache is at capacity");
		}

		const pending = load()
			.then((loaded) => {
				if (loaded.expiresAtMilliseconds - this.safetyMilliseconds > nowMilliseconds) {
					this.entries.set(key, loaded);
					while (this.entries.size > this.maxEntries) {
						const oldest = this.entries.keys().next().value;
						if (typeof oldest !== "string") break;
						this.entries.delete(oldest);
					}
				}
				return loaded;
			})
			.finally(() => {
				if (this.pending.get(key) === pending) this.pending.delete(key);
			});
		this.pending.set(key, pending);
		return await pending;
	}
}

export type FilesForwardAuthDependencies = {
	getToken: () => Promise<string | null>;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	deployApiUrl: string;
	assertionCache: FilesAssertionCache;
	now: () => number;
};

const productionDependencies: FilesForwardAuthDependencies = {
	getToken: async () => {
		if (env.VITE_DEV_AUTH_BYPASS) return env.VITE_DEV_AUTH_TOKEN;
		const clerk = await auth();
		return await clerk.getToken();
	},
	fetch,
	deployApiUrl: env.VITE_CLAWDI_DEPLOY_API_URL,
	assertionCache: new FilesAssertionCache(),
	now: Date.now,
};

function canonicalFilesHost(value: string | null): string | null {
	if (!value || value !== value.trim().toLowerCase() || value.length > 253) {
		return null;
	}
	return DNS_NAME_PATTERN.test(value) ? value : null;
}

function canonicalDeploymentId(value: string | null): string | null {
	return value && DEPLOYMENT_ID_PATTERN.test(value) ? value : null;
}

function noStoreHeaders(extra?: HeadersInit): Headers {
	const headers = new Headers(extra);
	headers.set("Cache-Control", "no-store, private");
	headers.set("Pragma", "no-cache");
	return headers;
}

function safeError(status: number): Response {
	const message =
		status === 403
			? "Files access denied. Sign in with the Clawdi account that owns this agent."
			: status === 503
				? "Files is unavailable right now. Return to Clawdi and try again."
				: "Files request could not be completed.";
	return new Response(message, {
		status,
		headers: noStoreHeaders({
			"Content-Type": "text/plain; charset=utf-8",
			"X-Content-Type-Options": "nosniff",
		}),
	});
}

function signedOutRedirect(requestUrl: URL, deploymentId: string, returnPath: string): Response {
	const authorizePath = new URL("/api/files/authorize", requestUrl);
	authorizePath.searchParams.set("deployment_id", deploymentId);
	authorizePath.searchParams.set("return_to", returnPath);
	const signIn = new URL("/sign-in", requestUrl);
	signIn.searchParams.set("redirect_url", `${authorizePath.pathname}${authorizePath.search}`);
	return new Response(null, {
		status: 302,
		headers: noStoreHeaders({ Location: signIn.toString() }),
	});
}

function assertionResponse(value: unknown, nowMilliseconds: number): CachedAssertion | null {
	if (
		typeof value !== "object" ||
		value === null ||
		!("assertion" in value) ||
		typeof value.assertion !== "string" ||
		value.assertion.length < 64 ||
		value.assertion.length > 8192 ||
		!("expires_at" in value) ||
		typeof value.expires_at !== "string"
	) {
		return null;
	}
	const expiresAtMilliseconds = Date.parse(value.expires_at);
	if (!Number.isFinite(expiresAtMilliseconds) || expiresAtMilliseconds <= nowMilliseconds) {
		return null;
	}
	return { assertion: value.assertion, expiresAtMilliseconds };
}

async function responseJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

function assertionCacheKey(
	sessionToken: string,
	deploymentId: string,
	filesHost: string,
	routeProof: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify([sessionToken, deploymentId, filesHost, routeProof]))
		.digest("base64url");
}

export async function GET(
	request: Request,
	dependencies: FilesForwardAuthDependencies = productionDependencies,
): Promise<Response> {
	const requestUrl = new URL(request.url);
	const deploymentId = canonicalDeploymentId(requestUrl.searchParams.get("deployment_id"));
	const filesHost = canonicalFilesHost(request.headers.get(FORWARDED_HOST_HEADER));
	const returnPath = sanitizeFilesReturnPath(request.headers.get(FORWARDED_URI_HEADER));
	const routeProof = request.headers.get(FILES_ROUTE_PROOF_HEADER);
	if (
		!deploymentId ||
		!filesHost ||
		!returnPath ||
		request.headers.get(FORWARDED_PROTO_HEADER) !== "https" ||
		!routeProof ||
		!ROUTE_PROOF_PATTERN.test(routeProof)
	) {
		return safeError(403);
	}

	let sessionToken: string | null;
	try {
		sessionToken = await dependencies.getToken();
	} catch {
		return safeError(503);
	}
	if (!sessionToken) {
		if (request.headers.get("Sec-Fetch-Dest") === "iframe") {
			return safeError(403);
		}
		return signedOutRedirect(requestUrl, deploymentId, returnPath);
	}

	const nowMilliseconds = dependencies.now();
	let cached: CachedAssertion;
	try {
		cached = await dependencies.assertionCache.getOrLoad(
			assertionCacheKey(sessionToken, deploymentId, filesHost, routeProof),
			nowMilliseconds,
			async () => {
				const brokerResponse = await dependencies.fetch(
					`${dependencies.deployApiUrl.replace(/\/$/, "")}/v2/deployments/${deploymentId}/files/assertion`,
					{
						method: "POST",
						headers: {
							accept: "application/json",
							authorization: `Bearer ${sessionToken}`,
							[FILES_ROUTE_PROOF_HEADER]: routeProof,
							[FILES_HOST_HEADER]: filesHost,
							[FILES_URI_HEADER]: returnPath,
							"x-clawdi-platform": "web",
						},
						cache: "no-store",
						signal: AbortSignal.timeout(8_000),
					},
				);
				if (!brokerResponse.ok) {
					throw new Error(brokerResponse.status === 409 ? "files-not-ready" : "files-denied");
				}
				const parsed = assertionResponse(await responseJson(brokerResponse), nowMilliseconds);
				if (!parsed) throw new Error("files-invalid-assertion");
				return parsed;
			},
		);
	} catch (error) {
		return safeError(error instanceof Error && error.message === "files-denied" ? 403 : 503);
	}
	return new Response(null, {
		status: 200,
		headers: noStoreHeaders({ [FILES_ASSERTION_HEADER]: cached.assertion }),
	});
}
