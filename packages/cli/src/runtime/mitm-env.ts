export const MANAGED_MITM_PLACEHOLDER_ENV = "CLAWDI_PROVIDER_PLACEHOLDER_TOKEN";
export const MANAGED_MITM_PLACEHOLDER_VALUE = "clawdi-mitm-placeholder";
export const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

export const mitmSidecarEnvKeys = [
	"CLAWDI_MITM_ENABLED",
	"CLAWDI_MITM_PROFILE_BUNDLE",
	"CLAWDI_MITM_PROXY_URL",
	"CLAWDI_MITM_PROXY_HOST",
	"CLAWDI_MITM_PROXY_PORT",
	"CLAWDI_MITM_MODE",
	"CLAWDI_MITM_TRANSPARENT_PORT",
	"CLAWDI_MITM_TRANSPORT_VERSION",
	"CLAWDI_MITM_INSTALL_SYSTEM_CA",
	"CLAWDI_MITM_SYSTEM_CA_CERT",
	"CLAWDI_MITM_SYSTEM_CA_BUNDLE",
	"CLAWDI_MITM_CA_FILE",
	"CLAWDI_MITM_CA_DIR",
	"CLAWDI_MITM_CA_PATH",
	"CLAWDI_MITM_SECRET_FILE",
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

export function stripMitmSidecarEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...source };
	deleteMitmSidecarEnv(env);
	return env;
}

export function stripMitmSidecarControlEnv(env: NodeJS.ProcessEnv): void {
	for (const key of Object.keys(env)) {
		if (key.startsWith("CLAWDI_MITM_")) delete env[key];
	}
}

export function applyMitmTransparentRuntimeEnv(
	env: NodeJS.ProcessEnv,
	output: { caFile?: string } = {},
): void {
	deleteMitmSidecarEnv(env);
	const caFile = output.caFile ?? SYSTEM_CA_BUNDLE;
	env.SSL_CERT_FILE = caFile;
	env.NODE_EXTRA_CA_CERTS = caFile;
	env.REQUESTS_CA_BUNDLE = caFile;
	env.CURL_CA_BUNDLE = caFile;
	env.GIT_SSL_CAINFO = caFile;
	env.DENO_CERT = caFile;
	env.CODEX_CA_CERTIFICATE = caFile;
	env[MANAGED_MITM_PLACEHOLDER_ENV] ??= MANAGED_MITM_PLACEHOLDER_VALUE;
}

function deleteMitmSidecarEnv(env: NodeJS.ProcessEnv): void {
	for (const key of Object.keys(env)) {
		if (key.startsWith("CLAWDI_MITM_")) delete env[key];
	}
	for (const key of mitmSidecarEnvKeys) {
		delete env[key];
	}
}
