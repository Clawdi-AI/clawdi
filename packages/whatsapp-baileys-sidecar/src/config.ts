import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export type SidecarConfig = {
	accountId: string;
	host: string;
	port: number;
	apiToken: string;
	sessionDir: string;
	logLevel: string;
};

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
	const accountId = readRequired(
		env.CLAWDI_WA_PROVIDER_ACCOUNT_ID,
		"CLAWDI_WA_PROVIDER_ACCOUNT_ID",
	);
	const apiToken = readRequired(env.CLAWDI_WA_SIDECAR_TOKEN, "CLAWDI_WA_SIDECAR_TOKEN");
	const sessionDir = resolve(
		readRequired(env.CLAWDI_WA_SIDECAR_SESSION_DIR, "CLAWDI_WA_SIDECAR_SESSION_DIR"),
	);
	const config: SidecarConfig = {
		accountId,
		host: nonEmpty(env.CLAWDI_WA_SIDECAR_HOST) ?? "127.0.0.1",
		port: parsePort(env.CLAWDI_WA_SIDECAR_PORT ?? "8787"),
		apiToken,
		sessionDir,
		logLevel: nonEmpty(env.CLAWDI_WA_SIDECAR_LOG_LEVEL) ?? "info",
	};
	mkdirSync(config.sessionDir, { recursive: true, mode: 0o700 });
	return config;
}

function readRequired(value: string | undefined, name: string): string {
	const text = nonEmpty(value);
	if (!text) {
		throw new Error(`${name} is required`);
	}
	return text;
}

function nonEmpty(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text ? text : undefined;
}

function parsePort(raw: string): number {
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new Error(`invalid CLAWDI_WA_SIDECAR_PORT: ${raw}`);
	}
	return value;
}
