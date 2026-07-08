import { randomUUID } from "node:crypto";
import { join } from "node:path";

const MANAGED_MITM_PLACEHOLDER_ENV = "CLAWDI_PROVIDER_PLACEHOLDER_TOKEN";
const MANAGED_MITM_PLACEHOLDER_VALUE = "clawdi-mitm-placeholder";

export const mitmSidecarEnvKeys = [
	"CLAWDI_MITM_ENABLED",
	"CLAWDI_MITM_PROFILE_BUNDLE",
	"CLAWDI_MITM_PROXY_URL",
	"CLAWDI_MITM_PROXY_HOST",
	"CLAWDI_MITM_PROXY_PORT",
	"CLAWDI_MITM_CA_FILE",
	"CLAWDI_MITM_CA_PATH",
	"CLAWDI_MITM_SECRET_FILE",
	"CLAWDI_MITM_SIDECAR_PATH",
	"CLAWDI_MITM_SIDECAR_BUNDLE",
	"CLAWDI_MITM_ALLOW_REMOTE_PROXY",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"NO_PROXY",
	"NODE_USE_ENV_PROXY",
	"OPENCLAW_PROXY_URL",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"GIT_SSL_CAINFO",
	"DENO_CERT",
	"CODEX_CA_CERTIFICATE",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;

export interface MitmSidecarEnvInput {
	env: NodeJS.ProcessEnv;
	profileBundlePath: string | null;
	proxyUrl?: string;
	caPath?: string;
	secretFile?: string;
}

export function buildMitmSidecarEnv(input: MitmSidecarEnvInput): NodeJS.ProcessEnv {
	if (!input.profileBundlePath) return { ...input.env };

	const env = stripMitmSidecarEnv(input.env);
	const proxyUrl = input.proxyUrl ?? resolveProxyUrl(input.env);
	const caPath = input.caPath ?? resolveCaPath(input.env);
	const secretFile = input.secretFile ?? resolveSecretFile(input.env);

	env.CLAWDI_MITM_ENABLED = "1";
	env.CLAWDI_MITM_PROFILE_BUNDLE = input.profileBundlePath;
	env.CLAWDI_MITM_PROXY_URL = proxyUrl;
	env.CLAWDI_MITM_CA_FILE = caPath;
	env.CLAWDI_MITM_SECRET_FILE = secretFile;
	env.HTTPS_PROXY = proxyUrl;
	env.HTTP_PROXY = proxyUrl;
	env.https_proxy = proxyUrl;
	env.http_proxy = proxyUrl;
	env.NO_PROXY = buildNoProxy(proxyUrl);
	env.no_proxy = env.NO_PROXY;
	env.NODE_USE_ENV_PROXY = "1";
	env.OPENCLAW_PROXY_URL = proxyUrl;
	env.SSL_CERT_FILE = caPath;
	env.NODE_EXTRA_CA_CERTS = caPath;
	env.REQUESTS_CA_BUNDLE = caPath;
	env.CURL_CA_BUNDLE = caPath;
	env.GIT_SSL_CAINFO = caPath;
	env.DENO_CERT = caPath;
	env.CODEX_CA_CERTIFICATE = caPath;
	env[MANAGED_MITM_PLACEHOLDER_ENV] ??= MANAGED_MITM_PLACEHOLDER_VALUE;

	return env;
}

export function stripMitmSidecarEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...source };
	for (const key of mitmSidecarEnvKeys) {
		delete env[key];
	}
	return env;
}

export function stripMitmSidecarControlEnv(env: NodeJS.ProcessEnv): void {
	for (const key of Object.keys(env)) {
		if (key.startsWith("CLAWDI_MITM_")) delete env[key];
	}
}

export function applyMitmSidecarRuntimeEnv(
	env: NodeJS.ProcessEnv,
	output: { proxyUrl: string; caFile: string },
): void {
	env.CLAWDI_MITM_PROXY_URL = output.proxyUrl;
	env.HTTPS_PROXY = output.proxyUrl;
	env.HTTP_PROXY = output.proxyUrl;
	env.https_proxy = output.proxyUrl;
	env.http_proxy = output.proxyUrl;
	env.NO_PROXY = buildNoProxy(output.proxyUrl);
	env.no_proxy = env.NO_PROXY;
	env.NODE_USE_ENV_PROXY = "1";
	env.OPENCLAW_PROXY_URL = output.proxyUrl;
	env.CLAWDI_MITM_CA_FILE = output.caFile;
	env.SSL_CERT_FILE = output.caFile;
	env.NODE_EXTRA_CA_CERTS = output.caFile;
	env.REQUESTS_CA_BUNDLE = output.caFile;
	env.CURL_CA_BUNDLE = output.caFile;
	env.GIT_SSL_CAINFO = output.caFile;
	env.DENO_CERT = output.caFile;
	env.CODEX_CA_CERTIFICATE = output.caFile;
	env[MANAGED_MITM_PLACEHOLDER_ENV] ??= MANAGED_MITM_PLACEHOLDER_VALUE;
}

function resolveProxyUrl(env: NodeJS.ProcessEnv): string {
	const explicit = env.CLAWDI_MITM_PROXY_URL?.trim();
	if (explicit) return explicit;
	const port = env.CLAWDI_MITM_PROXY_PORT?.trim() || "0";
	const host = env.CLAWDI_MITM_PROXY_HOST?.trim() || "127.0.0.1";
	return `http://${host}:${port}`;
}

function resolveCaPath(env: NodeJS.ProcessEnv): string {
	return (
		env.CLAWDI_MITM_CA_FILE?.trim() ||
		env.CLAWDI_MITM_CA_PATH?.trim() ||
		join(resolveMitmRunRoot(env), "sidecars", randomUUID(), "ca.pem")
	);
}

function resolveSecretFile(env: NodeJS.ProcessEnv): string {
	return (
		env.CLAWDI_MITM_SECRET_FILE?.trim() ||
		(env.CLAWDI_RUN_DIR?.trim()
			? join(env.CLAWDI_RUN_DIR.trim(), "secrets", "mitm-secrets.json")
			: undefined) ||
		join("/run/clawdi", "secrets", "mitm-secrets.json")
	);
}

function resolveMitmRunRoot(env: NodeJS.ProcessEnv): string {
	return env.CLAWDI_RUN_DIR?.trim()
		? join(env.CLAWDI_RUN_DIR.trim(), "mitm-scratch")
		: join("/run/clawdi", "mitm-scratch");
}

function buildNoProxy(proxyUrl: string): string {
	const base = ["localhost", "127.0.0.1", "::1"];
	try {
		const host = new URL(proxyUrl).hostname;
		if (host && !base.includes(host)) base.push(host);
	} catch {
		// Leave the default localhost bypass list.
	}
	return base.join(",");
}
