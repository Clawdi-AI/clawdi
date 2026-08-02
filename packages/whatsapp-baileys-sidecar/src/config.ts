import { basename, dirname, resolve } from "node:path";
import type { WAVersion } from "baileys";

import {
	AUDITED_WHATSAPP_WEB_VERSION_TEXT,
	parseAuditedWhatsAppWebVersion,
} from "./audited-version.js";
import { assertOwnedDirectory } from "./filesystem-security.js";

const DEFAULT_PROVIDER_INBOX_MAX_EVENTS = 10_000;
const DEFAULT_PROVIDER_INBOX_MAX_BYTES = 256 * 1024 * 1024;
export type SidecarConfig = {
	host: string;
	port: number;
	socketPath?: string;
	apiToken: string;
	stateRoot: string;
	logLevel: string;
	webVersion: WAVersion;
	providerInbox: {
		maxEvents: number;
		maxBytes: number;
	};
};

export type SidecarSessionConfig = Omit<SidecarConfig, "stateRoot"> & {
	sessionId: string;
	sessionDir: string;
};

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
	const apiToken = parseApiToken(
		readRequired(
			env.CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN,
			"CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN",
		),
	);
	const stateRoot = readRequired(env.CLAWDI_WA_SIDECAR_STATE_ROOT, "CLAWDI_WA_SIDECAR_STATE_ROOT");
	assertOwnedDirectory(stateRoot, 0o700, "provider state root");
	const socketPath = parseSocketPath(env.CLAWDI_WA_SIDECAR_SOCKET_PATH);
	if (socketPath) {
		if (nonEmpty(env.CLAWDI_WA_SIDECAR_HOST) || nonEmpty(env.CLAWDI_WA_SIDECAR_PORT)) {
			throw new Error("CLAWDI_WA_SIDECAR_SOCKET_PATH cannot be combined with host or port");
		}
		assertOwnedDirectory(dirname(socketPath), 0o770, "provider socket directory");
	}
	const config: SidecarConfig = {
		host: parseLoopbackHost(nonEmpty(env.CLAWDI_WA_SIDECAR_HOST) ?? "127.0.0.1"),
		port: parsePort(env.CLAWDI_WA_SIDECAR_PORT ?? "8787"),
		...(socketPath ? { socketPath } : {}),
		apiToken,
		stateRoot,
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
	return config;
}

function parseSocketPath(raw: string | undefined): string | undefined {
	const value = nonEmpty(raw);
	if (!value) return undefined;
	if (
		value.includes("\0") ||
		resolve(value) !== value ||
		Buffer.byteLength(value) > 103 ||
		basename(value) !== "sidecar.sock"
	) {
		throw new Error("CLAWDI_WA_SIDECAR_SOCKET_PATH must be a bounded sidecar.sock path");
	}
	return value;
}

function parseApiToken(value: string): string {
	if (Buffer.byteLength(value) > 4096 || !/^[\x21-\x7e]+$/.test(value)) {
		throw new Error(
			"CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN must be a bounded printable ASCII bearer value",
		);
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
	if (!/^[0-9]+$/.test(raw)) {
		throw new Error(`invalid CLAWDI_WA_SIDECAR_PORT: ${raw}`);
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 65_535) {
		throw new Error(`invalid CLAWDI_WA_SIDECAR_PORT: ${raw}`);
	}
	return value;
}

function parseLoopbackHost(raw: string): string {
	if (raw !== "127.0.0.1" && raw !== "localhost" && raw !== "::1") {
		throw new Error("CLAWDI_WA_SIDECAR_HOST must be 127.0.0.1, localhost, or ::1");
	}
	return raw;
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
