import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	chownSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer, type TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { buildMitmdumpArgs } from "../src/runtime/egress-sidecar";
import { ensureRuntimeMitmproxy } from "../src/runtime/mitmproxy-fetch";
import { getRuntimePaths } from "../src/runtime/paths";
import {
	buildTransparentEgressNftRules,
	cleanupTransparentEgressNftRules,
	TRANSPARENT_EGRESS_PORT,
} from "../src/runtime/transparent-egress";

const runtimeUid = 10001;
const egressUid = 10002;
const pin = {
	type: "mitmproxy" as const,
	version: "12.2.3",
	url: "https://downloads.mitmproxy.org/12.2.3/mitmproxy-12.2.3-linux-x86_64.tar.gz",
	sha256: "2e95286b618fa6fd33e5e62a78c2e5112571d85f42ec2bac29b97ee242bdb5c5",
};

function requestWithoutSni(uid: number, ca: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"openssl",
			[
				"s_client",
				"-noservername",
				"-connect",
				"127.0.0.1:443",
				"-CAfile",
				ca,
				"-verify_return_error",
				"-verify_ip",
				"127.0.0.1",
				"-quiet",
			],
			{ uid, gid: uid, stdio: ["pipe", "pipe", "pipe"] },
		);
		let response = "";
		let diagnostic = "";
		let executionError: Error | undefined;
		const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.stdout.on("data", (chunk: Buffer) => {
			response += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			diagnostic += chunk.toString("utf8");
		});
		child.stdin.once("error", (error) => {
			executionError = error;
			child.kill("SIGTERM");
		});
		child.once("error", (error) => {
			executionError = error;
		});
		child.once("close", (code, signal) => {
			clearTimeout(deadline);
			if (executionError) {
				reject(executionError);
			} else if (signal || !response) {
				reject(new Error(`no-SNI client failed (${code ?? signal}): ${diagnostic}`));
			} else {
				resolve(response);
			}
		});
		child.stdin.end(
			"GET /anonymous-no-sni HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
		);
	});
}

function listenerReady(): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port: TRANSPARENT_EGRESS_PORT });
		socket.setTimeout(200);
		const finish = (ready: boolean) => {
			socket.destroy();
			resolve(ready);
		};
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.once("timeout", () => finish(false));
	});
}

test.skipIf(process.env.CLAWDI_TEST_SYSTEMD_COMMAND !== "1")(
	"anonymous pinned mitmproxy denies runtime no-SNI HTTPS without sending HTTP bytes upstream",
	async () => {
		expect(process.getuid?.()).toBe(0);
		const root = mkdtempSync(join(tmpdir(), "clawdi-anonymous-egress-native-"));
		chmodSync(root, 0o755);
		const table = `clawdi_anonymous_native_${process.pid}`;
		const caDir = join(root, "private-ca");
		const snapshot = join(root, "snapshot.json");
		const ack = join(caDir, "snapshot.ack");
		const caCert = join(root, "client-ca.pem");
		const fixtureCert = join(root, "fixture.pem");
		const fixtureKey = join(root, "fixture.key");
		const sockets = new Set<TLSSocket>();
		const applicationBytes: Buffer[] = [];
		let server: ReturnType<typeof createServer> | undefined;
		let engine: ReturnType<typeof spawn> | undefined;
		let engineClosed: Promise<void> | undefined;
		let rulesApplied = false;
		let diagnostic = "";
		try {
			const artifact = ensureRuntimeMitmproxy(pin, {
				...getRuntimePaths({ mode: "hosted" }),
				egressEngineMaintainedRoot: join(root, "engine"),
			});
			if (artifact.status !== "ready") throw new Error(artifact.error);
			execFileSync(
				"openssl",
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-days",
					"1",
					"-subj",
					"/CN=127.0.0.1",
					"-addext",
					"subjectAltName=IP:127.0.0.1",
					"-keyout",
					fixtureKey,
					"-out",
					fixtureCert,
				],
				{ stdio: "ignore", timeout: 10_000 },
			);
			server = createServer(
				{ key: readFileSync(fixtureKey), cert: readFileSync(fixtureCert) },
				(socket) => {
					sockets.add(socket);
					socket.once("close", () => sockets.delete(socket));
					socket.on("error", () => socket.destroy());
					socket.on("data", (chunk: Buffer) => {
						applicationBytes.push(Buffer.from(chunk));
						socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
					});
				},
			);
			await new Promise<void>((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(443, "127.0.0.1", resolve);
			});
			// Prove the fixture accepts and records a real no-SNI HTTP request.
			expect(await requestWithoutSni(0, fixtureCert)).toContain("HTTP/1.1 200 OK");
			expect(Buffer.concat(applicationBytes).toString()).toContain("GET /anonymous-no-sni");
			applicationBytes.length = 0;
			mkdirSync(caDir, { mode: 0o700 });
			chownSync(caDir, egressUid, egressUid);
			writeFileSync(
				snapshot,
				JSON.stringify({
					schemaVersion: "clawdi.egressSnapshot.v1",
					claimed: false,
					profiles: { schemaVersion: "clawdi.egressProfiles.v1", profiles: [] },
					secrets: {},
				}),
				{ mode: 0o640 },
			);
			chownSync(snapshot, 0, egressUid);
			engine = spawn(
				artifact.binaryPath,
				[
					...buildMitmdumpArgs({
						transparentPort: TRANSPARENT_EGRESS_PORT,
						caDir,
						addonPath: fileURLToPath(
							new URL("../egress-addon/clawdi_egress_addon.py", import.meta.url),
						),
					}),
					// The local upstream fixture uses its own self-signed certificate.
					"--set",
					"ssl_insecure=true",
				],
				{
					uid: egressUid,
					gid: egressUid,
					env: {
						...process.env,
						HOME: caDir,
						CLAWDI_EGRESS_SNAPSHOT_FILE: snapshot,
						CLAWDI_EGRESS_SNAPSHOT_ACK: ack,
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			engineClosed = new Promise((resolve) => engine?.once("close", () => resolve()));
			engine.once("error", (error) => {
				diagnostic += error.message;
			});
			for (const stream of [engine.stdout, engine.stderr]) {
				stream?.on("data", (chunk: Buffer) => {
					diagnostic += chunk.toString("utf8");
				});
			}
			const deadline = Date.now() + 10_000;
			while (!(existsSync(ack) && (await listenerReady()))) {
				if (engine.exitCode !== null || Date.now() > deadline) {
					throw new Error(`pinned mitmproxy did not become ready: ${diagnostic}`);
				}
				await sleep(100);
			}
			copyFileSync(join(caDir, "mitmproxy-ca-cert.pem"), caCert);
			chmodSync(caCert, 0o644);
			execFileSync("nft", ["-f", "-"], {
				input: buildTransparentEgressNftRules({
					table,
					runtimeUid,
					egressUid,
					transparentPort: TRANSPARENT_EGRESS_PORT,
				}),
			});
			rulesApplied = true;
			expect(await requestWithoutSni(runtimeUid, caCert)).toContain("HTTP/1.1 503");
			// Eager upstream TCP/TLS handshakes are allowed; decrypted HTTP bytes are not.
			expect(Buffer.concat(applicationBytes).length).toBe(0);
		} finally {
			if (engine) {
				engine.kill("SIGTERM");
				const killTimer = setTimeout(() => engine?.kill("SIGKILL"), 2_000);
				try {
					await engineClosed;
				} finally {
					clearTimeout(killTimer);
				}
			}
			for (const socket of sockets) socket.destroy();
			if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
			try {
				if (rulesApplied) cleanupTransparentEgressNftRules(table);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	},
	45_000,
);
