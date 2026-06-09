import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export type SidecarConfig = {
	host: string;
	port: number;
	apiToken: string;
	sessionDir: string;
	waWebSocketUrl?: string;
	authCert?: {
		SERIAL: number;
		ISSUER: string;
		PUBLIC_KEY: Buffer;
	};
	logLevel: string;
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
		waWebSocketUrl: nonEmpty(env.CLAWDI_WA_WEBSOCKET_URL),
		authCert: parseAuthCert(env),
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
