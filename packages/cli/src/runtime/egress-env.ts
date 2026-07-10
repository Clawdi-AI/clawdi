export const MANAGED_EGRESS_PLACEHOLDER_ENV = "CLAWDI_PROVIDER_PLACEHOLDER_TOKEN";
export const MANAGED_EGRESS_PLACEHOLDER_VALUE = "clawdi-egress-placeholder";
export const SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

export const egressSidecarEnvKeys = [
	"CLAWDI_EGRESS_ENV_FILE",
	"CLAWDI_EGRESS_ENABLED",
	"CLAWDI_EGRESS_PROFILE_BUNDLE",
	"CLAWDI_EGRESS_PROXY_URL",
	"CLAWDI_EGRESS_PROXY_HOST",
	"CLAWDI_EGRESS_PROXY_PORT",
	"CLAWDI_EGRESS_MODE",
	"CLAWDI_EGRESS_TRANSPARENT_PORT",
	"CLAWDI_EGRESS_TRANSPORT_VERSION",
	"CLAWDI_EGRESS_INSTALL_SYSTEM_CA",
	"CLAWDI_EGRESS_SYSTEM_CA_CERT",
	"CLAWDI_EGRESS_SYSTEM_CA_BUNDLE",
	"CLAWDI_EGRESS_CA_FILE",
	"CLAWDI_EGRESS_CA_DIR",
	"CLAWDI_EGRESS_CA_PATH",
	"CLAWDI_EGRESS_SECRET_FILE",
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

const EGRESS_ENGINE_INHERITED_ENV_KEYS = [
	"PATH",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TMPDIR",
	"TEMP",
	"TMP",
] as const;

const EGRESS_ENGINE_DIRECT_CONFIG_ENV_KEYS = [
	"CLAWDI_EGRESS_PROFILE_BUNDLE",
	"CLAWDI_EGRESS_SECRET_FILE",
] as const;

export function buildEgressEngineEnv(
	source: NodeJS.ProcessEnv,
	options: { envFile?: string; home: string },
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of EGRESS_ENGINE_INHERITED_ENV_KEYS) {
		if (source[key] !== undefined) env[key] = source[key];
	}
	const envFile = options.envFile ?? source.CLAWDI_EGRESS_ENV_FILE ?? "";
	env.CLAWDI_EGRESS_ENV_FILE = envFile;
	if (!envFile) {
		for (const key of EGRESS_ENGINE_DIRECT_CONFIG_ENV_KEYS) {
			if (source[key] !== undefined) env[key] = source[key];
		}
	}
	env.HOME = options.home;
	return env;
}

export function applyEgressTransparentRuntimeEnv(
	env: NodeJS.ProcessEnv,
	output: { caFile?: string } = {},
): void {
	deleteEgressSidecarEnv(env);
	const caFile = output.caFile ?? SYSTEM_CA_BUNDLE;
	env.SSL_CERT_FILE = caFile;
	env.NODE_EXTRA_CA_CERTS = caFile;
	env.REQUESTS_CA_BUNDLE = caFile;
	env.CURL_CA_BUNDLE = caFile;
	env.GIT_SSL_CAINFO = caFile;
	env.DENO_CERT = caFile;
	env.CODEX_CA_CERTIFICATE = caFile;
	env[MANAGED_EGRESS_PLACEHOLDER_ENV] ??= MANAGED_EGRESS_PLACEHOLDER_VALUE;
}

function deleteEgressSidecarEnv(env: NodeJS.ProcessEnv): void {
	for (const key of Object.keys(env)) {
		if (key.startsWith("CLAWDI_EGRESS_")) delete env[key];
	}
	for (const key of egressSidecarEnvKeys) {
		delete env[key];
	}
}
