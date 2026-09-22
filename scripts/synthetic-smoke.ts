const DEFAULT_TIMEOUT_MS = 10_000;

export interface SyntheticSmokeOptions {
	apiBaseUrl: string;
	webBaseUrl: string;
	token?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

function normalizedHttpUrl(value: string, name: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be an absolute HTTP(S) URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${name} must use HTTP or HTTPS`);
	}
	if (url.username || url.password) {
		throw new Error(`${name} must not contain credentials`);
	}
	url.hash = "";
	return url;
}

async function probe(
	fetchImpl: typeof fetch,
	baseUrl: URL,
	path: string,
	label: string,
	timeoutMs: number,
	headers?: HeadersInit,
): Promise<void> {
	const url = new URL(path, baseUrl);
	const response = await fetchImpl(url, {
		method: "GET",
		headers,
		redirect: "follow",
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		throw new Error(`${label} returned HTTP ${response.status}`);
	}
	console.log(`ok: ${label} (${response.status})`);
}

export async function runSyntheticSmoke(options: SyntheticSmokeOptions): Promise<void> {
	const apiBaseUrl = normalizedHttpUrl(options.apiBaseUrl, "apiBaseUrl");
	const webBaseUrl = normalizedHttpUrl(options.webBaseUrl, "webBaseUrl");
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
		throw new Error("timeoutMs must be an integer between 1 and 30000");
	}
	const fetchImpl = options.fetchImpl ?? fetch;

	await probe(fetchImpl, apiBaseUrl, "/health", "API health", timeoutMs);
	await probe(fetchImpl, webBaseUrl, "/sign-in", "web sign-in page", timeoutMs);

	if (!options.token) {
		console.log("skip: authenticated read-only probes (SMOKE_TEST_ACCOUNT_TOKEN is absent)");
		return;
	}

	const headers = { Authorization: `Bearer ${options.token}`, Accept: "application/json" };
	await probe(fetchImpl, apiBaseUrl, "/v1/agents", "authenticated agents read", timeoutMs, headers);
	await probe(
		fetchImpl,
		apiBaseUrl,
		"/v1/projects",
		"authenticated projects read",
		timeoutMs,
		headers,
	);
}

if (import.meta.main) {
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone workflow script, not a Turbo task
	const webBaseUrl = Bun.env.SMOKE_BASE_URL?.trim();
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone workflow script, not a Turbo task
	const apiBaseUrl = Bun.env.SMOKE_API_BASE_URL?.trim() || webBaseUrl;
	if (!webBaseUrl || !apiBaseUrl) {
		console.log("skip: deployed synthetic probes (SMOKE_BASE_URL is absent)");
		process.exit(0);
	}
	await runSyntheticSmoke({
		apiBaseUrl,
		webBaseUrl,
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: secret is scoped to the workflow probe step
		token: Bun.env.SMOKE_TEST_ACCOUNT_TOKEN?.trim() || undefined,
	});
}
