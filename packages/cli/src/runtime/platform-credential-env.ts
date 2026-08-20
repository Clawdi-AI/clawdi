const PLATFORM_CREDENTIAL_ENV_KEYS = [
	"CLAWDI_AUTH_TOKEN",
	"CLAWDI_DAEMON_RPC_TOKEN",
	"CLAWDI_EGRESS_SECRET_FILE",
] as const;

export function clearPlatformCredentialEnv(env: NodeJS.ProcessEnv): void {
	for (const key of PLATFORM_CREDENTIAL_ENV_KEYS) delete env[key];
}
