import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkSidecarHealth } from "./healthcheck.js";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
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
	it("authenticates and verifies identity over an account-scoped Unix socket", async () => {
		const socketPath = await startUnixHealthServer();

		await expect(
			checkSidecarHealth({
				CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
				CLAWDI_WA_SIDECAR_SOCKET_PATH: socketPath,
				CLAWDI_WA_SIDECAR_TOKEN: TOKEN,
			}),
		).resolves.toBeUndefined();
	});

	it("preserves authenticated exact-loopback TCP health", async () => {
		const port = await startTcpHealthServer();

		await expect(
			checkSidecarHealth({
				CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
				CLAWDI_WA_SIDECAR_HOST: "127.0.0.1",
				CLAWDI_WA_SIDECAR_PORT: String(port),
				CLAWDI_WA_SIDECAR_TOKEN: TOKEN,
			}),
		).resolves.toBeUndefined();
	});

	it("rejects mixed UDS/TCP endpoints and non-loopback TCP", async () => {
		const socketPath = await startUnixHealthServer();
		const base = {
			CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
			CLAWDI_WA_SIDECAR_SOCKET_PATH: socketPath,
			CLAWDI_WA_SIDECAR_TOKEN: TOKEN,
		};

		await expect(
			checkSidecarHealth({ ...base, CLAWDI_WA_SIDECAR_HOST: "127.0.0.1" }),
		).rejects.toThrow("cannot be combined");
		await expect(checkSidecarHealth({ ...base, CLAWDI_WA_SIDECAR_PORT: "8787" })).rejects.toThrow(
			"cannot be combined",
		);
		await expect(
			checkSidecarHealth({
				CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
				CLAWDI_WA_SIDECAR_HOST: "0.0.0.0",
				CLAWDI_WA_SIDECAR_TOKEN: TOKEN,
			}),
		).rejects.toThrow("exact loopback host");
	});

	it("rejects malformed TCP ports and missing credentials", async () => {
		for (const port of ["0", "65536", "8787x", "1.5", "-1"]) {
			await expect(
				checkSidecarHealth({
					CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
					CLAWDI_WA_SIDECAR_PORT: port,
					CLAWDI_WA_SIDECAR_TOKEN: TOKEN,
				}),
			).rejects.toThrow("valid port");
		}
		await expect(checkSidecarHealth({})).rejects.toThrow("missing sidecar token");
		await expect(checkSidecarHealth({ CLAWDI_WA_SIDECAR_TOKEN: TOKEN })).rejects.toThrow(
			"missing account id",
		);
	});

	it("fails on a wrong bearer or returned account identity", async () => {
		const wrongBearerPort = await startTcpHealthServer();
		await expect(
			checkSidecarHealth({
				CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
				CLAWDI_WA_SIDECAR_PORT: String(wrongBearerPort),
				CLAWDI_WA_SIDECAR_TOKEN: "wrong-token",
			}),
		).rejects.toThrow("identity mismatch");

		const wrongIdentityPort = await startTcpHealthServer("22222222-2222-4222-8222-222222222222");
		await expect(
			checkSidecarHealth({
				CLAWDI_WA_PROVIDER_ACCOUNT_ID: ACCOUNT_ID,
				CLAWDI_WA_SIDECAR_PORT: String(wrongIdentityPort),
				CLAWDI_WA_SIDECAR_TOKEN: TOKEN,
			}),
		).rejects.toThrow("identity mismatch");
	});
});

async function startUnixHealthServer(accountId = ACCOUNT_ID): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "clawdi-healthcheck-"));
	temporaryDirectories.push(root);
	const socketDirectory = join(root, ACCOUNT_ID);
	mkdirSync(socketDirectory);
	const socketPath = join(socketDirectory, "sidecar.sock");
	const server = createHealthServer(accountId);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	return socketPath;
}

async function startTcpHealthServer(accountId = ACCOUNT_ID): Promise<number> {
	const server = createHealthServer(accountId);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return (server.address() as AddressInfo).port;
}

function createHealthServer(accountId: string): Server {
	const server = createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		if (request.url !== "/v1/health" || request.headers.authorization !== `Bearer ${TOKEN}`) {
			response.statusCode = 401;
			response.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}
		response.end(JSON.stringify({ accountId }));
	});
	servers.push(server);
	return server;
}
