import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createConnection } from "node:net";

import { loadConfigFromEnv } from "./config.js";
import { BaileysSocketRuntime } from "./runtime.js";
import { createSidecarServer } from "./server.js";

const config = loadConfigFromEnv();
const runtime = new BaileysSocketRuntime(config);
const server = createSidecarServer(runtime, { apiToken: config.apiToken });

let stopping = false;

try {
	await runtime.start();
	if (config.socketPath) await removeStaleSocket(config.socketPath);
	await listen();
} catch (error: unknown) {
	await runtime.stop().catch(() => undefined);
	throw error;
}

function listen(): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			try {
				if (config.socketPath) chmodSync(config.socketPath, 0o660);
				const address = server.address();
				const endpoint =
					typeof address === "string"
						? { transport: "unix", socketPath: address }
						: {
								transport: "tcp",
								host: (address as AddressInfo).address,
								port: (address as AddressInfo).port,
							};
				console.log(
					JSON.stringify({
						event: "clawdi_whatsapp_provider_transport_started",
						accountId: config.accountId,
						...endpoint,
					}),
				);
				resolve();
			} catch (error: unknown) {
				server.close(() => reject(error));
			}
		};
		server.once("error", onError);
		server.once("listening", onListening);
		if (config.socketPath) server.listen(config.socketPath);
		else server.listen(config.port, config.host);
	});
}

async function removeStaleSocket(socketPath: string): Promise<void> {
	if (!existsSync(socketPath)) return;
	const stat = lstatSync(socketPath);
	if (!stat.isSocket() || stat.isSymbolicLink()) {
		throw new Error("provider socket path must be a Unix socket");
	}
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	if (uid === undefined || gid === undefined || stat.uid !== uid || stat.gid !== gid) {
		throw new Error("provider socket path must be owned by the sidecar uid and gid");
	}
	if (await socketAcceptsConnections(socketPath)) {
		throw new Error("provider socket path is already owned by a running process");
	}
	unlinkSync(socketPath);
}

function socketAcceptsConnections(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ path: socketPath });
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(true);
		}, 1_000);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log(
		JSON.stringify({
			event: "clawdi_whatsapp_provider_transport_stopping",
			accountId: config.accountId,
			signal,
		}),
	);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await runtime.stop();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		try {
			await shutdown(signal);
			process.exit(0);
		} catch (error: unknown) {
			console.error(error instanceof Error ? error.message : "sidecar shutdown failed");
			process.exit(1);
		}
	});
}
