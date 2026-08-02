import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { WAVersion } from "baileys";

import {
	AUDITED_WHATSAPP_WEB_VERSION_TEXT,
	parseAuditedWhatsAppWebVersion,
} from "./audited-version.js";

const DEFAULT_PROVIDER_INBOX_MAX_EVENTS = 10_000;
const DEFAULT_PROVIDER_INBOX_MAX_BYTES = 256 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SidecarConfig = {
	accountId: string;
	host: string;
	port: number;
	apiToken: string;
	sessionDir: string;
	logLevel: string;
	webVersion: WAVersion;
	providerInbox: {
		maxEvents: number;
		maxBytes: number;
	};
};

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
	const accountId = parseAccountId(
		readRequired(env.CLAWDI_WA_PROVIDER_ACCOUNT_ID, "CLAWDI_WA_PROVIDER_ACCOUNT_ID"),
	);
	const apiToken = parseApiToken(
		readRequired(env.CLAWDI_WA_SIDECAR_TOKEN, "CLAWDI_WA_SIDECAR_TOKEN"),
	);
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
		webVersion: parseAuditedWhatsAppWebVersion(
			nonEmpty(env.CLAWDI_WA_WEB_VERSION) ?? AUDITED_WHATSAPP_WEB_VERSION_TEXT,
		),
		providerInbox: {
			maxEvents: parsePositiveInteger(
				env.CLAWDI_WA_PROVIDER_INBOX_MAX_EVENTS,
				"CLAWDI_WA_PROVIDER_INBOX_MAX_EVENTS",
				DEFAULT_PROVIDER_INBOX_MAX_EVENTS,
				1_000_000,
			),
			maxBytes: parsePositiveInteger(
				env.CLAWDI_WA_PROVIDER_INBOX_MAX_BYTES,
				"CLAWDI_WA_PROVIDER_INBOX_MAX_BYTES",
				DEFAULT_PROVIDER_INBOX_MAX_BYTES,
				1024 * 1024 * 1024,
			),
		},
	};
	mkdirSync(config.sessionDir, { recursive: true, mode: 0o700 });
	return config;
}

function parseAccountId(value: string): string {
	if (!UUID_PATTERN.test(value)) {
		throw new Error("CLAWDI_WA_PROVIDER_ACCOUNT_ID must be a canonical UUID");
	}
	return value.toLowerCase();
}

function parseApiToken(value: string): string {
	if (Buffer.byteLength(value) > 4096 || !/^[\x21-\x7e]+$/.test(value)) {
		throw new Error("CLAWDI_WA_SIDECAR_TOKEN must be a bounded printable ASCII bearer value");
	}
	return value;
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

function parsePositiveInteger(
	raw: string | undefined,
	name: string,
	fallback: number,
	maximum: number,
): number {
	const value = raw === undefined ? fallback : Number(raw);
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new Error(`${name} must be an integer between 1 and ${maximum}`);
	}
	return value;
}
