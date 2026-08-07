import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	chownSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	assertControlPathOwnershipAndMode,
	type ControlRpcHandlers,
	type ControlRpcListenConfig,
	callControlRpc,
	isLoopbackRpcHost,
	startControlRpcServer,
} from "./control-rpc";

if (process.platform !== "win32") {
	describe("control RPC", () => {
		it("serves JSON-RPC methods over HTTP", async () => {
			await withRpcFixture(async ({ start }) => {
				const server = await start({
					echo: (params) => ({ params }),
				});

				const result = await callControlRpc("echo", { ok: true }, rpcClient(server));

				expect(result).toEqual({ params: { ok: true } });
			});
		});

		it("returns JSON-RPC errors for unknown methods", async () => {
			await withRpcFixture(async ({ start }) => {
				const server = await start({});

				await expect(callControlRpc("missing", {}, rpcClient(server))).rejects.toThrow(
					"Unknown RPC method: missing",
				);
			});
		});

		it("serves HTTP RPC when a host and port are configured", async () => {
			await withRpcFixture(async ({ start }) => {
				const server = await start(
					{
						echo: (params) => ({ params }),
					},
					{ host: "127.0.0.1", port: 0 },
				);

				const result = await callControlRpc("echo", { via: "http" }, rpcClient(server));

				expect(result).toEqual({ params: { via: "http" } });
			});
		});

		it("returns the in-flight server close promise to every shutdown caller", async () => {
			await withRpcFixture(async ({ start }) => {
				const server = await start({});

				const firstClose = server.close();
				expect(server.close()).toBe(firstClose);
				await firstClose;
			});
		});

		it("times out when a socket accepts the request but never finishes a response", async () => {
			await withHangingTcpServer(async (port) => {
				await expect(
					callControlRpc("ping", {}, { port, token: "test-token", timeoutMs: 50 }),
				).rejects.toThrow("Control RPC timed out after 50ms");
			});
		});

		it("aborts an in-flight request with the caller's AbortSignal reason", async () => {
			await withHangingTcpServer(async (port) => {
				const abort = new AbortController();
				const call = callControlRpc(
					"ping",
					{},
					{
						port,
						token: "test-token",
						timeoutMs: 5_000,
						signal: abort.signal,
					},
				);
				setTimeout(() => abort.abort(new Error("caller cancelled RPC")), 25);

				await expect(call).rejects.toThrow("caller cancelled RPC");
			});
		});

		it("rejects non-loopback HTTP listeners unless explicitly allowed", async () => {
			await withRpcFixture(async ({ start }) => {
				await expect(start({}, { host: "0.0.0.0", port: 0 })).rejects.toThrow(
					"Refusing to listen on non-loopback HTTP RPC host 0.0.0.0",
				);
			});
		});

		it("only treats numeric 127/8 hosts and localhost as loopback", () => {
			expect(isLoopbackRpcHost("localhost")).toBe(true);
			expect(isLoopbackRpcHost("127.0.0.1")).toBe(true);
			expect(isLoopbackRpcHost("127.42.0.1")).toBe(true);
			expect(isLoopbackRpcHost("[::1]")).toBe(true);
			expect(isLoopbackRpcHost("127.evil.com")).toBe(false);
			expect(isLoopbackRpcHost("0.0.0.0")).toBe(false);
		});

		it("requires a bearer token for HTTP RPC access", async () => {
			await withRpcFixture(async ({ start }) => {
				const server = await start(
					{
						echo: (params) => ({ params }),
					},
					{ host: "127.0.0.1", port: 0 },
				);

				const response = await postWithoutToken(server.http.host, server.http.port);

				expect(response.statusCode).toBe(401);
				expect(response.body).toContain("unauthorized");
			});
		});

		it("allows explicit RPC tokens for HTTP clients", async () => {
			await withRpcFixture(async ({ start }) => {
				const server = await start(
					{
						echo: (params) => ({ params }),
					},
					{ host: "127.0.0.1", port: 0 },
				);

				const result = await callControlRpc("echo", { token: "explicit" }, rpcClient(server));

				expect(result).toEqual({ params: { token: "explicit" } });
			});
		});

		for (const mode of [0o666, 0o640]) {
			it(`rejects an existing token with mode 0${mode.toString(8)}`, async () => {
				await withRpcFixture(async ({ controlDir, start }) => {
					const tokenPath = join(controlDir, "control-token");
					mkdirSync(controlDir, { recursive: true, mode: 0o700 });
					writeFileSync(tokenPath, "insecure-token\n", { mode });
					chmodSync(tokenPath, mode);

					await expect(start({})).rejects.toThrow(
						`daemon control token ${tokenPath} must have mode 0600`,
					);
					expect(statSync(tokenPath).mode & 0o777).toBe(mode);
				});
			});
		}

		it("rejects a token owned by another uid", async () => {
			const effectiveUid = process.geteuid?.() ?? 0;
			expect(() =>
				assertControlPathOwnershipAndMode(
					"daemon control token",
					"/secure/control-token",
					effectiveUid + 1,
					0o600,
					effectiveUid,
					0o600,
				),
			).toThrow(
				`daemon control token /secure/control-token must be owned by effective uid ${effectiveUid}; found uid ${effectiveUid + 1}`,
			);

			if (effectiveUid !== 0) return;
			await withRpcFixture(async ({ controlDir, start }) => {
				const tokenPath = join(controlDir, "control-token");
				mkdirSync(controlDir, { recursive: true, mode: 0o700 });
				writeFileSync(tokenPath, "foreign-token\n", { mode: 0o600 });
				chownSync(tokenPath, 10001, 10001);

				await expect(start({})).rejects.toThrow(
					`daemon control token ${tokenPath} must be owned by effective uid 0; found uid 10001`,
				);
			});
		});

		it("rejects a control directory writable by another uid", async () => {
			await withRpcFixture(async ({ controlDir, start }) => {
				const tokenPath = join(controlDir, "control-token");
				mkdirSync(controlDir, { recursive: true, mode: 0o700 });
				writeFileSync(tokenPath, "insecure-parent-token\n", { mode: 0o600 });
				chmodSync(controlDir, 0o770);

				await expect(start({})).rejects.toThrow(
					`daemon control directory ${controlDir} must have mode 0700`,
				);
			});
		});

		it("rejects a token symlink pointing outside the control directory", async () => {
			await withRpcFixture(async ({ controlDir, start }) => {
				const outsideToken = join(dirname(controlDir), "outside-token");
				const tokenPath = join(controlDir, "control-token");
				mkdirSync(controlDir, { recursive: true, mode: 0o700 });
				writeFileSync(outsideToken, "outside-token\n", { mode: 0o600 });
				symlinkSync(outsideToken, tokenPath);

				await expect(start({})).rejects.toThrow(
					`daemon control token at ${tokenPath} must not be a symbolic link`,
				);
			});
		});

		it("rotates the bearer token without restarting the server", async () => {
			await withRpcFixture(async ({ start }) => {
				let server: Awaited<ReturnType<typeof startControlRpcServer>>;
				server = await start(
					{
						echo: (params) => ({ params }),
						rotate_token: () => ({ token: server.rotateToken() }),
					},
					{ host: "127.0.0.1", port: 0 },
				);
				const oldToken = readServerToken(server);

				const rotated = (await callControlRpc("rotate_token", {}, rpcClient(server))) as {
					token: string;
				};

				expect(rotated.token).not.toBe(oldToken);
				await expect(
					callControlRpc(
						"echo",
						{ rejected: true },
						{
							...server.http,
							token: oldToken,
						},
					),
				).rejects.toThrow("unauthorized");

				const result = await callControlRpc(
					"echo",
					{ accepted: true },
					{
						...server.http,
						token: rotated.token,
					},
				);

				expect(result).toEqual({ params: { accepted: true } });
			});
		});

		it("allows explicit non-loopback HTTP listeners with the bearer token", async () => {
			await withRpcFixture(async ({ start }) => {
				const server = await start(
					{
						echo: (params) => ({ params }),
					},
					{ host: "0.0.0.0", port: 0, allowRemote: true },
				);

				const result = await callControlRpc(
					"echo",
					{ accepted: true },
					{
						host: "127.0.0.1",
						port: server.http.port,
						token: readServerToken(server),
					},
				);

				expect(result).toEqual({ params: { accepted: true } });
			});
		});
	});
}

type RpcServer = Awaited<ReturnType<typeof startControlRpcServer>>;

interface RpcFixture {
	controlDir: string;
	start: (handlers: ControlRpcHandlers, config?: ControlRpcListenConfig) => Promise<RpcServer>;
}

async function withRpcFixture<T>(run: (fixture: RpcFixture) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "clawdi-control-rpc-"));
	const controlDir = join(root, "control");
	const abort = new AbortController();
	const servers: RpcServer[] = [];
	try {
		return await run({
			controlDir,
			start: async (handlers, config = {}) => {
				const server = await startControlRpcServer(handlers, abort.signal, {
					port: 0,
					controlDir,
					...config,
				});
				servers.push(server);
				return server;
			},
		});
	} finally {
		abort.abort();
		await Promise.allSettled(servers.map((server) => server.close()));
		rmSync(root, { recursive: true, force: true });
	}
}

function rpcClient(server: RpcServer): { host: string; port: number; token: string } {
	return {
		...server.http,
		token: readServerToken(server),
	};
}

function readServerToken(server: RpcServer): string {
	return readFileSync(server.tokenPath, "utf-8").trim();
}

async function withHangingTcpServer<T>(run: (port: number) => Promise<T>): Promise<T> {
	const sockets = new Set<Socket>();
	const server = createTcpServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected TCP test port");
	try {
		return await run(address.port);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function postWithoutToken(
	host: string,
	port: number,
): Promise<{ statusCode: number; body: string }> {
	const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: {} });
	return new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: host,
				port,
				path: "/rpc",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				let chunks = "";
				res.setEncoding("utf-8");
				res.on("data", (chunk) => {
					chunks += chunk;
				});
				res.on("end", () => {
					resolve({ statusCode: res.statusCode ?? 0, body: chunks });
				});
			},
		);
		req.on("error", reject);
		req.write(body);
		req.end();
	});
}
