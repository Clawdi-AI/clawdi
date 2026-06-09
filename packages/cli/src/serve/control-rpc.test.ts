import { describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
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

		it("repairs existing token file permissions on startup", async () => {
			await withRpcFixture(async ({ controlDir, start }) => {
				const tokenPath = join(controlDir, "control-token");
				mkdirSync(dirname(tokenPath), { recursive: true });
				writeFileSync(tokenPath, "fixed-token\n", { mode: 0o644 });
				chmodSync(tokenPath, 0o644);

				await start({});

				expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
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
