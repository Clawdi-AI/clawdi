import type { AiProvider } from "@clawdi/shared";
import { ApiClient } from "./api-client";
import { resolveClawdiReference } from "./secret-references";

export interface AiProviderAuthStatus {
	status: "available" | "missing" | "unknown";
	detail?: string;
	value?: string;
}

export interface AiProviderProbeResult {
	status: "ok" | "failed" | "skipped";
	detail: string;
	url?: string;
	http_status?: number;
}

export async function inspectAiProviderAuth(provider: AiProvider): Promise<AiProviderAuthStatus> {
	const auth = provider.auth;
	if (auth.type === "none") return { status: "available", detail: "no auth" };
	if (auth.type === "secret_ref" && auth.ref.startsWith("env:")) {
		const name = auth.ref.slice("env:".length);
		return process.env[name]
			? { status: "available", detail: auth.ref, value: process.env[name] }
			: { status: "missing", detail: auth.ref };
	}
	if (auth.type === "secret_ref" && auth.ref.startsWith("clawdi://")) {
		try {
			const hit = await resolveClawdiReference(auth.ref);
			return { status: "available", detail: redactSecretRef(auth.ref), value: hit.value };
		} catch (error) {
			return {
				status: "missing",
				detail: `${redactSecretRef(auth.ref)} (${error instanceof Error ? error.message : String(error)})`,
			};
		}
	}
	if (auth.type === "api_key" && auth.source === "env" && auth.ref?.startsWith("env:")) {
		const name = auth.ref.slice("env:".length);
		return process.env[name]
			? { status: "available", detail: auth.ref, value: process.env[name] }
			: { status: "missing", detail: auth.ref };
	}
	if (auth.type === "api_key" && auth.source === "managed") {
		if (provider.runtime_env_name && process.env[provider.runtime_env_name]) {
			return {
				status: "available",
				detail: `managed api_key:env:${provider.runtime_env_name}`,
				value: process.env[provider.runtime_env_name],
			};
		}
		try {
			const resolved = await new ApiClient().postJsonBody<{
				value?: string | null;
				profile?: string | null;
			}>(`/v1/ai-providers/${encodeURIComponent(provider.id)}/auth/resolve`, {
				profile: "default",
			});
			if (resolved.value) {
				return {
					status: "available",
					detail: "managed api_key",
					value: resolved.value,
				};
			}
			return { status: "missing", detail: "managed api_key returned no API key" };
		} catch (error) {
			const envDetail = provider.runtime_env_name ? `env:${provider.runtime_env_name} unset; ` : "";
			return {
				status: "missing",
				detail: `managed api_key (${envDetail}${error instanceof Error ? error.message : String(error)})`,
			};
		}
	}
	return { status: "unknown", detail: describeAuth(provider.auth) };
}

export function publicAiProviderAuthStatus(authStatus: AiProviderAuthStatus): {
	status: "available" | "missing" | "unknown";
	detail?: string;
} {
	return { status: authStatus.status, detail: authStatus.detail };
}

export async function probeAiProvider(
	provider: AiProvider,
	authStatus: AiProviderAuthStatus,
	timeoutSeconds: number,
): Promise<AiProviderProbeResult> {
	if (authStatus.status === "missing") {
		return { status: "skipped", detail: "auth missing" };
	}
	if (authStatus.status === "unknown") {
		return { status: "skipped", detail: "auth cannot be resolved locally" };
	}
	const endpoint = providerProbeEndpoint(provider, authStatus.value);
	const headers = providerProbeHeaders(provider, authStatus.value);
	const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(endpoint, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		if (res.ok) {
			return {
				status: "ok",
				detail: "metadata endpoint reachable",
				url: redactUrl(endpoint),
				http_status: res.status,
			};
		}
		return {
			status: "failed",
			detail: `metadata endpoint returned HTTP ${res.status}`,
			url: redactUrl(endpoint),
			http_status: res.status,
		};
	} catch (error) {
		const err = error as { name?: string; message?: string };
		return {
			status: "failed",
			detail:
				err.name === "AbortError" ? "metadata probe timed out" : (err.message ?? String(error)),
			url: redactUrl(endpoint),
		};
	} finally {
		clearTimeout(timer);
	}
}

export function parseAiProviderTestTimeout(input: string | undefined): number {
	const value = Number(input ?? 10);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("--timeout must be a positive number of seconds.");
	}
	return value;
}

function providerProbeEndpoint(provider: AiProvider, key: string | undefined): string {
	const base = provider.base_url.replace(/\/+$/, "");
	if (provider.type === "anthropic") {
		return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
	}
	if (provider.type === "gemini") {
		const url = new URL(base.endsWith("/models") ? base : `${base}/models`);
		if (key) url.searchParams.set("key", key);
		return url.toString();
	}
	return `${base}/models`;
}

function providerProbeHeaders(
	provider: AiProvider,
	key: string | undefined,
): Record<string, string> {
	if (!key) return {};
	if (provider.type === "anthropic") {
		return {
			"x-api-key": key,
			"anthropic-version": "2023-06-01",
		};
	}
	if (provider.type === "gemini") return {};
	return { Authorization: `Bearer ${key}` };
}

function describeAuth(auth: AiProvider["auth"]): string {
	if (auth.type === "secret_ref") return redactSecretRef(auth.ref);
	if (auth.type === "api_key") return `api_key:${auth.source}`;
	if (auth.type === "oauth_profile") return `oauth:${auth.provider}/${auth.profile}`;
	if (auth.type === "agent_profile") return `agent:${auth.tool}/${auth.profile}`;
	return "none";
}

function redactSecretRef(ref: string): string {
	if (ref.startsWith("env:")) return ref;
	if (ref.startsWith("clawdi://")) return "clawdi://...";
	return "redacted";
}

function redactUrl(input: string): string {
	const url = new URL(input);
	if (url.searchParams.has("key")) url.searchParams.set("key", "redacted");
	return url.toString();
}
