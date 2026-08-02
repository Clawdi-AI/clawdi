import { type RequestOptions, request } from "node:http";
import { basename, resolve } from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export async function checkSidecarHealth(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const token = required(env.CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN, "sidecar token");
	const endpoint = healthEndpoint(env);

	await new Promise<void>((resolveHealth, rejectHealth) => {
		const healthRequest = request(
			{
				...endpoint,
				path: "/v1/health",
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
						if (
							response.statusCode !== 200 ||
							typeof body !== "object" ||
							body === null ||
							!("schemaVersion" in body) ||
							body.schemaVersion !== "clawdi.whatsapp.sidecar-health.v1" ||
							!("ready" in body) ||
							body.ready !== true
						) {
							throw new Error("sidecar health identity mismatch");
						}
						resolveHealth();
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

if (import.meta.main) await checkSidecarHealth();
