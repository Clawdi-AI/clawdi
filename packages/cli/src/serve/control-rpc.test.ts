import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
	callControlRpc,
	issueScopedControlToken,
	rootOnlyRpcHandler,
	rotateControlToken,
	startControlRpcServer,
	withRpcCapabilities,
} from "./control-rpc";
import { getDaemonControlTokenPath } from "./paths";

if (process.platform !== "win32") {
	describe("control RPC", () => {
		const originalClawdiHome = process.env.CLAWDI_HOME;
		const originalStateDir = process.env.CLAWDI_STATE_DIR;
		let tmpHome: string;
		let abort: AbortController;
		let closeServer: (() => Promise<void>) | undefined;

		beforeEach(() => {
			tmpHome = mkdtempSync(join(tmpdir(), "clawdi-control-rpc-"));
			process.env.CLAWDI_HOME = join(tmpHome, ".clawdi");
			delete process.env.CLAWDI_STATE_DIR;
			abort = new AbortController();
			closeServer = undefined;
		});

		afterEach(async () => {
			abort.abort();
			await closeServer?.();
			if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
			else process.env.CLAWDI_HOME = originalClawdiHome;
			if (originalStateDir === undefined) delete process.env.CLAWDI_STATE_DIR;
			else process.env.CLAWDI_STATE_DIR = originalStateDir;
			rmSync(tmpHome, { recursive: true, force: true });
		});

		it("serves JSON-RPC methods over the daemon control socket", async () => {
			const server = await startControlRpcServer(
				{
					"daemon.echo": (params) => ({ params }),
				},
				abort.signal,
			);
			closeServer = server.close;

			const result = await callControlRpc("daemon.echo", { ok: true });

			expect(result).toEqual({ params: { ok: true } });
		});

		it("returns JSON-RPC errors for unknown methods", async () => {
			const server = await startControlRpcServer({}, abort.signal);
			closeServer = server.close;

			await expect(callControlRpc("daemon.missing")).rejects.toThrow(
				"Unknown RPC method: daemon.missing",
			);
		});

		it("serves HTTP RPC when a host and port are configured", async () => {
			const server = await startControlRpcServer(
				{
					"daemon.echo": (params) => ({ params }),
				},
				abort.signal,
				{ host: "127.0.0.1", port: 0 },
			);
			closeServer = server.close;

			const result = await callControlRpc("daemon.echo", { via: "http" }, server.http ?? undefined);

			expect(result).toEqual({ params: { via: "http" } });
		});

		it("rejects non-loopback HTTP listeners unless explicitly allowed", async () => {
			await expect(
				startControlRpcServer({}, abort.signal, { host: "0.0.0.0", port: 0 }),
			).rejects.toThrow("Refusing to listen on non-loopback HTTP RPC host 0.0.0.0");
		});

		it("requires a bearer token for HTTP RPC access", async () => {
			const server = await startControlRpcServer(
				{
					"daemon.echo": (params) => ({ params }),
				},
				abort.signal,
				{ host: "127.0.0.1", port: 0 },
			);
			closeServer = server.close;
			if (!server.http) throw new Error("expected HTTP listener");

			const response = await postWithoutToken(server.http.host, server.http.port);

			expect(response.statusCode).toBe(401);
			expect(response.body).toContain("unauthorized");
		});

		it("allows explicit RPC tokens for HTTP clients", async () => {
			const server = await startControlRpcServer(
				{
					"daemon.echo": (params) => ({ params }),
				},
				abort.signal,
				{ host: "127.0.0.1", port: 0 },
			);
			closeServer = server.close;
			if (!server.http) throw new Error("expected HTTP listener");
			const token = readFileSync(getDaemonControlTokenPath(), "utf-8").trim();

			const result = await callControlRpc(
				"daemon.echo",
				{ token: "explicit" },
				{
					...server.http,
					token,
				},
			);

			expect(result).toEqual({ params: { token: "explicit" } });
		});

		it("repairs existing token file permissions on startup", async () => {
			const tokenPath = getDaemonControlTokenPath();
			mkdirSync(dirname(tokenPath), { recursive: true });
			writeFileSync(tokenPath, "fixed-token\n", { mode: 0o644 });
			chmodSync(tokenPath, 0o644);

			const server = await startControlRpcServer({}, abort.signal);
			closeServer = server.close;

			expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
		});

		it("rotates the bearer token without restarting the server", async () => {
			const server = await startControlRpcServer(
				{
					"daemon.echo": (params) => ({ params }),
					"daemon.rotate_token": () => ({ token: rotateControlToken() }),
				},
				abort.signal,
				{ host: "127.0.0.1", port: 0 },
			);
			closeServer = server.close;
			if (!server.http) throw new Error("expected HTTP listener");
			const oldToken = readFileSync(getDaemonControlTokenPath(), "utf-8").trim();

			const rotated = (await callControlRpc("daemon.rotate_token", {}, server.http)) as {
				token: string;
			};

			expect(rotated.token).not.toBe(oldToken);
			await expect(
				callControlRpc(
					"daemon.echo",
					{ rejected: true },
					{
						...server.http,
						token: oldToken,
					},
				),
			).rejects.toThrow("unauthorized");

			const result = await callControlRpc(
				"daemon.echo",
				{ accepted: true },
				{
					...server.http,
					token: rotated.token,
				},
			);

			expect(result).toEqual({ params: { accepted: true } });
		});

		it("requires scoped tokens on non-loopback HTTP listeners", async () => {
			const server = await startControlRpcServer(
				{
					"daemon.echo": withRpcCapabilities((params) => ({ params }), ["daemon:read"]),
				},
				abort.signal,
				{ host: "0.0.0.0", port: 0, allowRemote: true },
			);
			closeServer = server.close;
			if (!server.http) throw new Error("expected HTTP listener");
			const rootToken = readFileSync(getDaemonControlTokenPath(), "utf-8").trim();

			await expect(
				callControlRpc(
					"daemon.echo",
					{ rejected: true },
					{ host: "127.0.0.1", port: server.http.port, token: rootToken },
				),
			).rejects.toThrow("root_token_not_allowed_on_remote_http");

			const scoped = issueScopedControlToken({
				capabilities: ["daemon:read"],
				expiresInSeconds: 60,
			});
			const result = await callControlRpc(
				"daemon.echo",
				{ accepted: true },
				{ host: "127.0.0.1", port: server.http.port, token: scoped.token },
			);

			expect(result).toEqual({ params: { accepted: true } });
		});

		it("enforces scoped token capabilities per method", async () => {
			const server = await startControlRpcServer(
				{
					"vault.secret": withRpcCapabilities(() => ({ ok: true }), ["vault:secrets"]),
				},
				abort.signal,
				{ host: "127.0.0.1", port: 0 },
			);
			closeServer = server.close;
			if (!server.http) throw new Error("expected HTTP listener");
			const scoped = issueScopedControlToken({
				capabilities: ["daemon:read"],
				expiresInSeconds: 60,
			});

			await expect(
				callControlRpc("vault.secret", {}, { ...server.http, token: scoped.token }),
			).rejects.toThrow("requires RPC capability vault:secrets");
		});

		it("keeps root-only methods unavailable to scoped tokens", async () => {
			const server = await startControlRpcServer(
				{
					"daemon.rotate_token": rootOnlyRpcHandler(() => ({ rotated: true })),
				},
				abort.signal,
				{ host: "127.0.0.1", port: 0 },
			);
			closeServer = server.close;
			if (!server.http) throw new Error("expected HTTP listener");
			const scoped = issueScopedControlToken({
				capabilities: ["daemon:control"],
				expiresInSeconds: 60,
			});

			await expect(
				callControlRpc("daemon.rotate_token", {}, { ...server.http, token: scoped.token }),
			).rejects.toThrow("requires the daemon root control token");
		});
	});
}

function postWithoutToken(
	host: string,
	port: number,
): Promise<{ statusCode: number; body: string }> {
	const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "daemon.echo", params: {} });
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
