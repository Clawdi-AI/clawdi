import { randomUUID } from "node:crypto";
import {
	type components,
	type DeployPaths,
	extractApiDetail,
	type HostedDeployCheckoutRequest,
	type HostedDeployCheckoutResult,
	type HostedDeployDeployment,
	type HostedDeployManagedModel,
	type HostedDeployOperation,
	type HostedDeployPlan,
	type HostedDeployRequest,
	type HostedDeployRequestStatus,
	type HostedDeploySubscriptionQuote,
	type HostedDeploySubscriptionQuoteRequest,
	type HostedDeployWallet,
	type HostedSavedAiProvider,
	type paths,
	unwrapDeploymentList,
} from "@clawdi/shared/api";
import createClient, { type Client, type Middleware } from "openapi-fetch";
import { getConfig } from "./config";
import {
	assertHostedDeployAccessToken,
	createHostedDeployAuthProvider,
	type HostedDeployAuthProvider,
} from "./hosted-deploy-auth";
import { getCliVersion } from "./version";

const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = `clawdi-cli/${getCliVersion()}`;

type HostedResult<T> = { data?: T; error?: unknown; response: Response };

export class HostedDeployApiError extends Error {
	readonly status: number;
	readonly detail: string;

	constructor(status: number, detail: string) {
		super(detail || `Hosted deploy API request failed (${status}).`);
		this.name = "HostedDeployApiError";
		this.status = status;
		this.detail = detail;
	}
}

export function normalizeHostedDeployApiBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Hosted deploy API URL must be a valid http:// or https:// URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Hosted deploy API URL must use http:// or https://.");
	}
	const loopback =
		url.hostname === "localhost" ||
		url.hostname === "127.0.0.1" ||
		url.hostname === "[::1]" ||
		url.hostname === "::1";
	if (url.protocol === "http:" && !loopback) {
		throw new Error("Hosted deploy API URL must use HTTPS except on loopback localhost.");
	}
	if (url.username || url.password) {
		throw new Error("Hosted deploy API URL must not contain credentials.");
	}
	url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v2$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

async function fetchWithTimeout(request: Request): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(request, { signal: controller.signal });
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "AbortError";
		throw new HostedDeployApiError(
			0,
			timedOut
				? "Hosted deploy API request timed out. The request may still have been accepted; retry with the same --request-id."
				: "Could not reach the Hosted deploy API. Check your connection and deployApiUrl.",
		);
	} finally {
		clearTimeout(timeout);
	}
}

function unwrapHosted<T>(result: HostedResult<T>): T {
	if (result.error !== undefined || !result.response.ok) {
		throw new HostedDeployApiError(
			result.response.status,
			result.error === undefined ? result.response.statusText : extractApiDetail(result.error),
		);
	}
	if (result.data === undefined) {
		throw new HostedDeployApiError(502, "Hosted deploy API returned an empty response.");
	}
	return result.data;
}

export type HostedDeployClientOptions = {
	auth?: HostedDeployAuthProvider;
	apiBaseUrl?: string;
	baseUrl?: string;
	fetch?: (request: Request) => Promise<Response>;
	now?: () => number;
	paidCheckoutSupported?: boolean;
};

/** Typed, auth-isolated adapter over the generated Hosted deploy API client. */
export class HostedDeployClient {
	readonly baseUrl: string;
	private readonly cloudClient: Client<paths>;
	private readonly client: Client<DeployPaths>;
	private readonly paidCheckoutSupported: boolean;

	constructor(options: HostedDeployClientOptions = {}) {
		const auth = options.auth ?? createHostedDeployAuthProvider();
		const now = options.now ?? Date.now;
		this.paidCheckoutSupported = options.paidCheckoutSupported ?? true;
		this.baseUrl = normalizeHostedDeployApiBaseUrl(options.baseUrl ?? getConfig().deployApiUrl);
		const requestFetch = options.fetch ?? fetchWithTimeout;
		this.client = createClient<DeployPaths>({
			baseUrl: this.baseUrl,
			fetch: requestFetch,
		});
		this.cloudClient = createClient<paths>({
			baseUrl: options.apiBaseUrl ?? getConfig().apiUrl,
			fetch: requestFetch,
		});
		const authMiddleware: Middleware = {
			async onRequest({ request }) {
				const credential = await auth.getAccessToken();
				const token = assertHostedDeployAccessToken(credential, now());
				request.headers.set("Authorization", `Bearer ${token}`);
				request.headers.set("User-Agent", USER_AGENT);
				request.headers.set("X-Request-ID", randomUUID());
				return request;
			},
		};
		this.client.use(authMiddleware);
		this.cloudClient.use(authMiddleware);
	}

	/**
	 * The human CLI token contract grants wallet read, quote, and checkout as a
	 * single paid-deploy capability. Tests can disable it to verify fail-closed
	 * behavior if a future audience narrows those routes.
	 */
	supportsPaidCheckout(): boolean {
		return this.paidCheckoutSupported;
	}

	async getPlans(): Promise<HostedDeployPlan[]> {
		return unwrapHosted(await this.client.GET("/v2/subscription/plans"));
	}

	async listDeployments(): Promise<HostedDeployDeployment[]> {
		return unwrapDeploymentList(unwrapHosted(await this.client.GET("/v2/deployments")));
	}

	async getManagedModels(): Promise<HostedDeployManagedModel[]> {
		return unwrapHosted(await this.client.GET("/v2/ai-providers/managed/models")).models;
	}

	async getSavedAiProviders(): Promise<HostedSavedAiProvider[]> {
		const response: components["schemas"]["AiProviderListResponse"] = unwrapHosted(
			await this.cloudClient.GET("/v1/ai-providers"),
		);
		return response.providers;
	}

	async getWallet(): Promise<HostedDeployWallet> {
		return unwrapHosted(await this.client.GET("/v2/wallet"));
	}

	async quoteSubscription(
		body: HostedDeploySubscriptionQuoteRequest,
	): Promise<HostedDeploySubscriptionQuote> {
		return unwrapHosted(await this.client.POST("/v2/subscription/quote", { body }));
	}

	async createDeployment(
		body: HostedDeployRequest,
		idempotencyKey: string,
	): Promise<HostedDeployOperation> {
		return unwrapHosted(
			await this.client.POST("/v2/deployments", {
				params: { header: { "Idempotency-Key": idempotencyKey } },
				body,
			}),
		);
	}

	async checkout(
		body: HostedDeployCheckoutRequest,
		idempotencyKey: string,
	): Promise<HostedDeployCheckoutResult> {
		return unwrapHosted(
			await this.client.POST("/v2/subscription/checkout", {
				body,
				headers: { "Idempotency-Key": idempotencyKey },
			}),
		);
	}

	async getOperation(operationName: string): Promise<HostedDeployOperation> {
		const prefix = "operations/";
		const operationId = operationName.startsWith(prefix) ? operationName.slice(prefix.length) : "";
		if (!operationId) throw new Error("Hosted deploy API returned an invalid operation name.");
		return unwrapHosted(
			await this.client.GET("/v2/operations/{operation_id}", {
				params: { path: { operation_id: operationId } },
			}),
		);
	}

	async getDeploymentRequest(requestId: string): Promise<HostedDeployRequestStatus> {
		return unwrapHosted(
			await this.client.GET("/v2/deployments/by-request/{deploy_request_id}", {
				params: { path: { deploy_request_id: requestId } },
			}),
		);
	}
}
