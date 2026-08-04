import { type RequestOptions, request } from "node:http";
import { basename, resolve } from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SESSION_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function checkSidecarHealth(
	env: NodeJS.ProcessEnv = process.env,
	sessionIds: readonly string[] = [],
): Promise<void> {
	const token = required(env.CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN, "sidecar token");
	const endpoint = healthEndpoint(env);
	const service = await requestHealth(endpoint, token, "/v1/health");
	if (
		!isRecord(service) ||
		service.schemaVersion !== "clawdi.whatsapp.sidecar-health.v1" ||
		service.ready !== true
	) {
		throw new Error("sidecar health identity mismatch");
	}
	for (const sessionId of sessionIds) {
		if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error("invalid sidecar session id");
		const session = await requestHealth(endpoint, token, `/v1/sessions/${sessionId}/health`);
		if (
			!isRecord(session) ||
			session.sessionId !== sessionId ||
			session.status !== "connected" ||
			session.connected !== true ||
			session.registered !== true
		) {
			throw new Error("sidecar session did not recover");
		}
	}
}

function requestHealth(endpoint: RequestOptions, token: string, path: string): Promise<unknown> {
	return new Promise<unknown>((resolveHealth, rejectHealth) => {
		const healthRequest = request(
			{
				...endpoint,
				path,
				method: "GET",
				headers: { authorization: `Bearer ${token}` },
				timeout: 4_000,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.once("error", rejectHealth);
				response.on("end", () => {
					try {
						const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						if (response.statusCode !== 200) throw new Error("sidecar health request failed");
						resolveHealth(body);
					} catch (error: unknown) {
						rejectHealth(error);
					}
				});
			},
		);
		healthRequest.once("timeout", () => healthRequest.destroy(new Error("sidecar health timeout")));
		healthRequest.once("error", rejectHealth);
		healthRequest.end();
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function healthEndpoint(env: NodeJS.ProcessEnv): RequestOptions {
	const socketPath = nonEmpty(env.CLAWDI_WA_SIDECAR_SOCKET_PATH);
	const explicitHost = nonEmpty(env.CLAWDI_WA_SIDECAR_HOST);
	const explicitPort = nonEmpty(env.CLAWDI_WA_SIDECAR_PORT);
	if (socketPath) {
		if (explicitHost || explicitPort) {
			throw new Error("sidecar socket path cannot be combined with host or port");
		}
		if (
			socketPath.includes("\0") ||
			resolve(socketPath) !== socketPath ||
			Buffer.byteLength(socketPath) > 103 ||
			basename(socketPath) !== "sidecar.sock"
		) {
			throw new Error("sidecar socket path must be an absolute sidecar.sock path");
		}
		return { socketPath };
	}

	const host = explicitHost ?? "127.0.0.1";
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error("sidecar TCP healthcheck requires an exact loopback host");
	}
	const rawPort = explicitPort ?? "8787";
	if (!/^[0-9]+$/.test(rawPort)) {
		throw new Error("sidecar TCP healthcheck requires a valid port");
	}
	const port = Number(rawPort);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error("sidecar TCP healthcheck requires a valid port");
	}
	return { host, port };
}

function required(value: string | undefined, label: string): string {
	const text = nonEmpty(value);
	if (!text) throw new Error(`missing ${label}`);
	return text;
}

function nonEmpty(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text ? text : undefined;
}

if (import.meta.main) await checkSidecarHealth(process.env, process.argv.slice(2));
