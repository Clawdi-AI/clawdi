import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type SidecarConfig = {
	host: string;
	port: number;
	apiToken: string;
	sessionDir: string;
	pairingPhoneNumber?: string;
	waWebSocketUrl?: string;
	authCert?: {
		SERIAL: number;
		ISSUER: string;
		PUBLIC_KEY: Buffer;
	};
	logLevel: string;
	messageStore: {
		maxMessages: number;
		maxBytes: number;
		ttlSeconds: number;
	};
	callback?: {
		accountId: string;
		url: string;
		token: string;
		spoolDir: string;
		maxPendingEvents: number;
		maxPendingBytes: number;
		initialBackoffMs: number;
		maxBackoffMs: number;
		requestTimeoutMs: number;
	};
};

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
	const apiToken = readRequired(env.CLAWDI_WA_SIDECAR_TOKEN, "CLAWDI_WA_SIDECAR_TOKEN");
	const sessionDir = resolve(
		readRequired(env.CLAWDI_WA_SIDECAR_SESSION_DIR, "CLAWDI_WA_SIDECAR_SESSION_DIR"),
	);
	const config: SidecarConfig = {
		host: nonEmpty(env.CLAWDI_WA_SIDECAR_HOST) ?? "127.0.0.1",
		port: parsePort(env.CLAWDI_WA_SIDECAR_PORT ?? "8787"),
		apiToken,
		sessionDir,
		pairingPhoneNumber: parsePairingPhoneNumber(env.CLAWDI_WA_PAIRING_PHONE_NUMBER),
		waWebSocketUrl: nonEmpty(env.CLAWDI_WA_WEBSOCKET_URL),
		authCert: parseAuthCert(env),
		logLevel: nonEmpty(env.CLAWDI_WA_SIDECAR_LOG_LEVEL) ?? "info",
		messageStore: {
			maxMessages: parsePositiveInt(
				env.CLAWDI_WA_SIDECAR_MESSAGE_STORE_MAX_MESSAGES ?? "1000",
				"CLAWDI_WA_SIDECAR_MESSAGE_STORE_MAX_MESSAGES",
			),
			maxBytes: parsePositiveInt(
				env.CLAWDI_WA_SIDECAR_MESSAGE_STORE_MAX_BYTES ?? String(32 * 1024 * 1024),
				"CLAWDI_WA_SIDECAR_MESSAGE_STORE_MAX_BYTES",
			),
			ttlSeconds: parsePositiveInt(
				env.CLAWDI_WA_SIDECAR_MESSAGE_STORE_TTL_SECONDS ?? String(7 * 24 * 60 * 60),
				"CLAWDI_WA_SIDECAR_MESSAGE_STORE_TTL_SECONDS",
			),
		},
	};
	mkdirSync(config.sessionDir, { recursive: true, mode: 0o700 });
	if (lstatSync(config.sessionDir).isSymbolicLink()) {
		throw new Error("CLAWDI_WA_SIDECAR_SESSION_DIR must not be a symbolic link");
	}
	chmodSync(config.sessionDir, 0o700);
	config.callback = parseCallback(env, config.sessionDir);
	return config;
}

function parseCallback(env: NodeJS.ProcessEnv, sessionDir: string): SidecarConfig["callback"] {
	const accountId = nonEmpty(env.CLAWDI_WA_SIDECAR_ACCOUNT_ID);
	const url = nonEmpty(env.CLAWDI_WA_SIDECAR_CALLBACK_URL);
	const token = nonEmpty(env.CLAWDI_WA_SIDECAR_CALLBACK_TOKEN);
	const spoolDirRaw = nonEmpty(env.CLAWDI_WA_SIDECAR_CALLBACK_SPOOL_DIR);
	if (!accountId && !url && !token && !spoolDirRaw) return undefined;
	if (!accountId || !url || !token || !spoolDirRaw) {
		throw new Error(
			"CLAWDI_WA_SIDECAR_ACCOUNT_ID, CLAWDI_WA_SIDECAR_CALLBACK_URL, CLAWDI_WA_SIDECAR_CALLBACK_TOKEN, and CLAWDI_WA_SIDECAR_CALLBACK_SPOOL_DIR must be set together",
		);
	}
	const parsed = new URL(url);
	const exactLoopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
	if (
		parsed.protocol !== "https:" &&
		!(parsed.protocol === "http:" && exactLoopback.has(parsed.hostname))
	) {
		throw new Error(
			"CLAWDI_WA_SIDECAR_CALLBACK_URL must use HTTPS (HTTP is allowed only for exact loopback hosts)",
		);
	}
	const expectedPath = `/v1/channels/whatsapp/${accountId}/sidecar/events`;
	if (
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		parsed.pathname !== expectedPath
	) {
		throw new Error(
			`CLAWDI_WA_SIDECAR_CALLBACK_URL must use the exact account callback path ${expectedPath} without userinfo, query, or fragment`,
		);
	}
	const spoolDir = resolve(spoolDirRaw);
	mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
	if (lstatSync(spoolDir).isSymbolicLink()) {
		throw new Error("CLAWDI_WA_SIDECAR_CALLBACK_SPOOL_DIR must not be a symbolic link");
	}
	chmodSync(spoolDir, 0o700);
	const canonicalSessionDir = realpathSync(sessionDir);
	const canonicalSpoolDir = realpathSync(spoolDir);
	if (
		pathsOverlap(canonicalSessionDir, canonicalSpoolDir) ||
		pathsOverlap(canonicalSpoolDir, canonicalSessionDir)
	) {
		throw new Error(
			"CLAWDI_WA_SIDECAR_CALLBACK_SPOOL_DIR must be separate from CLAWDI_WA_SIDECAR_SESSION_DIR",
		);
	}
	return {
		accountId,
		url,
		token,
		spoolDir,
		maxPendingEvents: parsePositiveInt(
			env.CLAWDI_WA_SIDECAR_CALLBACK_MAX_PENDING ?? "1000",
			"CLAWDI_WA_SIDECAR_CALLBACK_MAX_PENDING",
		),
		maxPendingBytes: parsePositiveInt(
			env.CLAWDI_WA_SIDECAR_CALLBACK_MAX_BYTES ?? String(64 * 1024 * 1024),
			"CLAWDI_WA_SIDECAR_CALLBACK_MAX_BYTES",
		),
		initialBackoffMs: parsePositiveInt(
			env.CLAWDI_WA_SIDECAR_CALLBACK_INITIAL_BACKOFF_MS ?? "200",
			"CLAWDI_WA_SIDECAR_CALLBACK_INITIAL_BACKOFF_MS",
		),
		maxBackoffMs: parsePositiveInt(
			env.CLAWDI_WA_SIDECAR_CALLBACK_MAX_BACKOFF_MS ?? "5000",
			"CLAWDI_WA_SIDECAR_CALLBACK_MAX_BACKOFF_MS",
		),
		requestTimeoutMs: parsePositiveInt(
			env.CLAWDI_WA_SIDECAR_CALLBACK_TIMEOUT_MS ?? "10000",
			"CLAWDI_WA_SIDECAR_CALLBACK_TIMEOUT_MS",
		),
	};
}

function pathsOverlap(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path));
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

function parsePositiveInt(raw: string, name: string): number {
	const value = Number.parseInt(raw, 10);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`invalid ${name}: ${raw}`);
	}
	return value;
}

function parsePairingPhoneNumber(raw: string | undefined): string | undefined {
	const value = nonEmpty(raw);
	if (!value) return undefined;
	if (!/^[1-9][0-9]{6,14}$/.test(value)) {
		throw new Error(
			"CLAWDI_WA_PAIRING_PHONE_NUMBER must be an E.164 phone number without + or separators",
		);
	}
	return value;
}

function parseAuthCert(env: NodeJS.ProcessEnv): SidecarConfig["authCert"] {
	const publicKeyHex = nonEmpty(env.CLAWDI_WA_AUTH_CERT_PUBKEY_HEX);
	const publicKeyBase64 = nonEmpty(env.CLAWDI_WA_AUTH_CERT_PUBKEY_BASE64);
	if (!publicKeyHex && !publicKeyBase64) {
		return undefined;
	}
	const publicKey = publicKeyHex
		? decodePublicKeyHex(publicKeyHex)
		: Buffer.from(readRequired(publicKeyBase64, "CLAWDI_WA_AUTH_CERT_PUBKEY_BASE64"), "base64");
	if (publicKey.length === 0) {
		throw new Error("auth cert public key is empty");
	}
	const serialRaw = nonEmpty(env.CLAWDI_WA_AUTH_CERT_SERIAL) ?? "0";
	const serial = Number.parseInt(serialRaw, 10);
	if (!Number.isInteger(serial) || serial < 0) {
		throw new Error(`invalid CLAWDI_WA_AUTH_CERT_SERIAL: ${serialRaw}`);
	}
	return {
		SERIAL: serial,
		ISSUER: nonEmpty(env.CLAWDI_WA_AUTH_CERT_ISSUER) ?? "clawdi",
		PUBLIC_KEY: publicKey,
	};
}

function decodePublicKeyHex(value: string): Buffer {
	if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
		throw new Error("CLAWDI_WA_AUTH_CERT_PUBKEY_HEX must be an even-length hex string");
	}
	return Buffer.from(value, "hex");
}
