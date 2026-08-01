import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

export type SidecarConfig = {
	host: string;
	port: number;
	apiToken: string;
	accountId: string;
	sessionDir: string;
	logLevel: string;
	messageStore: {
		maxMessages: number;
		maxBytes: number;
		ttlSeconds: number;
	};
	mediaMaxBytes: number;
	callback?: {
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
	const accountId = parseAccountId(
		readRequired(env.CLAWDI_WA_SIDECAR_ACCOUNT_ID, "CLAWDI_WA_SIDECAR_ACCOUNT_ID"),
	);
	const sessionDir = secureDirectory(
		resolve(readRequired(env.CLAWDI_WA_SIDECAR_SESSION_DIR, "CLAWDI_WA_SIDECAR_SESSION_DIR")),
		"CLAWDI_WA_SIDECAR_SESSION_DIR",
	);
	return {
		host: nonEmpty(env.CLAWDI_WA_SIDECAR_HOST) ?? "127.0.0.1",
		port: parsePositiveInt(env.CLAWDI_WA_SIDECAR_PORT ?? "8787", "CLAWDI_WA_SIDECAR_PORT", 65_535),
		apiToken,
		accountId,
		sessionDir,
		logLevel: nonEmpty(env.CLAWDI_WA_SIDECAR_LOG_LEVEL) ?? "info",
		messageStore: {
			maxMessages: parsePositiveInt(
				env.CLAWDI_WA_SIDECAR_MESSAGE_STORE_MAX_MESSAGES ?? "2000",
				"CLAWDI_WA_SIDECAR_MESSAGE_STORE_MAX_MESSAGES",
			),
			maxBytes: parsePositiveInt(
				env.CLAWDI_WA_SIDECAR_MESSAGE_STORE_MAX_BYTES ?? String(64 * 1024 * 1024),
				"CLAWDI_WA_SIDECAR_MESSAGE_STORE_MAX_BYTES",
			),
			ttlSeconds: parsePositiveInt(
				env.CLAWDI_WA_SIDECAR_MESSAGE_STORE_TTL_SECONDS ?? String(14 * 24 * 60 * 60),
				"CLAWDI_WA_SIDECAR_MESSAGE_STORE_TTL_SECONDS",
			),
		},
		mediaMaxBytes: parsePositiveInt(
			env.CLAWDI_WA_SIDECAR_MEDIA_MAX_BYTES ?? String(16 * 1024 * 1024),
			"CLAWDI_WA_SIDECAR_MEDIA_MAX_BYTES",
		),
		callback: parseCallback(env, sessionDir),
	};
}

function parseCallback(env: NodeJS.ProcessEnv, sessionDir: string): SidecarConfig["callback"] {
	const url = nonEmpty(env.CLAWDI_WA_SIDECAR_CALLBACK_URL);
	const token = nonEmpty(env.CLAWDI_WA_SIDECAR_CALLBACK_TOKEN);
	if (!url && !token) return undefined;
	if (!url || !token) {
		throw new Error(
			"CLAWDI_WA_SIDECAR_CALLBACK_URL and CLAWDI_WA_SIDECAR_CALLBACK_TOKEN must be set together",
		);
	}
	const parsed = new URL(url);
	const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
	if (
		parsed.protocol !== "https:" &&
		!(parsed.protocol === "http:" && loopback.has(parsed.hostname))
	) {
		throw new Error("CLAWDI_WA_SIDECAR_CALLBACK_URL must use HTTPS or exact loopback HTTP");
	}
	if (parsed.username || parsed.password || parsed.hash) {
		throw new Error("CLAWDI_WA_SIDECAR_CALLBACK_URL must not contain userinfo or a fragment");
	}
	const spoolDir = secureDirectory(
		resolve(
			nonEmpty(env.CLAWDI_WA_SIDECAR_CALLBACK_SPOOL_DIR) ?? join(sessionDir, "callback-spool"),
		),
		"CLAWDI_WA_SIDECAR_CALLBACK_SPOOL_DIR",
	);
	if (spoolDir === realpathSync(sessionDir)) {
		throw new Error("callback spool directory must not be the session directory itself");
	}
	return {
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
			env.CLAWDI_WA_SIDECAR_CALLBACK_INITIAL_BACKOFF_MS ?? "250",
			"CLAWDI_WA_SIDECAR_CALLBACK_INITIAL_BACKOFF_MS",
		),
		maxBackoffMs: parsePositiveInt(
			env.CLAWDI_WA_SIDECAR_CALLBACK_MAX_BACKOFF_MS ?? "30000",
			"CLAWDI_WA_SIDECAR_CALLBACK_MAX_BACKOFF_MS",
		),
		requestTimeoutMs: parsePositiveInt(
			env.CLAWDI_WA_SIDECAR_CALLBACK_TIMEOUT_MS ?? "10000",
			"CLAWDI_WA_SIDECAR_CALLBACK_TIMEOUT_MS",
		),
	};
}

function secureDirectory(path: string, name: string): string {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error(`${name} must be a real directory`);
	chmodSync(path, 0o700);
	return realpathSync(path);
}

function parseAccountId(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
		throw new Error("CLAWDI_WA_SIDECAR_ACCOUNT_ID has an invalid format");
	}
	return value;
}

function readRequired(value: string | undefined, name: string): string {
	const text = nonEmpty(value);
	if (!text) throw new Error(`${name} is required`);
	return text;
}

function nonEmpty(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text ? text : undefined;
}

function parsePositiveInt(raw: string, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
	if (!/^[0-9]+$/.test(raw)) throw new Error(`invalid ${name}: ${raw}`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new Error(`invalid ${name}: ${raw}`);
	}
	return value;
}
