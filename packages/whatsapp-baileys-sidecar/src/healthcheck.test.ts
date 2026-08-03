import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkSidecarHealth } from "./healthcheck.js";

const TOKEN = "test-sidecar-token";
const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("sidecar healthcheck", () => {
	it("authenticates and verifies the service over one Unix socket", async () => {
		const socketPath = await startUnixHealthServer();

		await expect(
			checkSidecarHealth({
				CLAWDI_WA_SIDECAR_SOCKET_PATH: socketPath,
				CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: TOKEN,
			}),
		).resolves.toBeUndefined();
	});

	it("preserves authenticated exact-loopback TCP health", async () => {
		const port = await startTcpHealthServer();

		await expect(
			checkSidecarHealth({
				CLAWDI_WA_SIDECAR_HOST: "127.0.0.1",
				CLAWDI_WA_SIDECAR_PORT: String(port),
				CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: TOKEN,
			}),
		).resolves.toBeUndefined();
	});

	it("rejects mixed UDS/TCP endpoints and non-loopback TCP", async () => {
		const socketPath = await startUnixHealthServer();
		const base = {
			CLAWDI_WA_SIDECAR_SOCKET_PATH: socketPath,
			CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: TOKEN,
		};

		await expect(
			checkSidecarHealth({ ...base, CLAWDI_WA_SIDECAR_HOST: "127.0.0.1" }),
		).rejects.toThrow("cannot be combined");
		await expect(checkSidecarHealth({ ...base, CLAWDI_WA_SIDECAR_PORT: "8787" })).rejects.toThrow(
			"cannot be combined",
		);
		await expect(
			checkSidecarHealth({
				CLAWDI_WA_SIDECAR_HOST: "0.0.0.0",
				CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: TOKEN,
			}),
		).rejects.toThrow("exact loopback host");
	});

	it("rejects malformed TCP ports and missing credentials", async () => {
		for (const port of ["0", "65536", "8787x", "1.5", "-1"]) {
			await expect(
				checkSidecarHealth({
					CLAWDI_WA_SIDECAR_PORT: port,
					CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: TOKEN,
				}),
			).rejects.toThrow("valid port");
		}
		await expect(checkSidecarHealth({})).rejects.toThrow("missing sidecar token");
	});

	it("fails on a wrong bearer or returned service identity", async () => {
		const wrongBearerPort = await startTcpHealthServer();
		await expect(
			checkSidecarHealth({
				CLAWDI_WA_SIDECAR_PORT: String(wrongBearerPort),
				CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: "wrong-token",
			}),
		).rejects.toThrow("identity mismatch");

		const wrongIdentityPort = await startTcpHealthServer(false);
		await expect(
			checkSidecarHealth({
				CLAWDI_WA_SIDECAR_PORT: String(wrongIdentityPort),
				CHANNEL_WHATSAPP_BAILEYS_SIDECAR_TOKEN: TOKEN,
			}),
		).rejects.toThrow("identity mismatch");
	});
});

async function startUnixHealthServer(): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "clawdi-healthcheck-"));
	temporaryDirectories.push(root);
	const socketDirectory = join(root, "run");
	mkdirSync(socketDirectory);
	const socketPath = join(socketDirectory, "sidecar.sock");
	const server = createHealthServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return socketPath;
}

async function startTcpHealthServer(validIdentity = true): Promise<number> {
	const server = createHealthServer(validIdentity);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return (server.address() as AddressInfo).port;
}

function createHealthServer(validIdentity = true): Server {
	const server = createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		if (request.url !== "/v1/health" || request.headers.authorization !== `Bearer ${TOKEN}`) {
			response.statusCode = 401;
			response.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		response.end(
			JSON.stringify(
				validIdentity
					? { schemaVersion: "clawdi.whatsapp.sidecar-health.v1", ready: true }
					: { schemaVersion: "unexpected", ready: true },
			),
		);
	});
	servers.push(server);
	return server;
}
