import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callControlRpc, startControlRpcServer } from "./control-rpc";
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

		it("serves TCP RPC when a host and port are configured", async () => {
			const server = await startControlRpcServer(
				{
					"daemon.echo": (params) => ({ params }),
				},
				abort.signal,
				{ host: "127.0.0.1", port: 0 },
			);
			closeServer = server.close;

			const result = await callControlRpc("daemon.echo", { via: "tcp" }, server.tcp ?? undefined);

			expect(result).toEqual({ params: { via: "tcp" } });
		});

		it("requires a bearer token for TCP RPC access", async () => {
			const server = await startControlRpcServer(
				{
					"daemon.echo": (params) => ({ params }),
				},
				abort.signal,
				{ host: "127.0.0.1", port: 0 },
			);
			closeServer = server.close;
			if (!server.tcp) throw new Error("expected tcp listener");

			const response = await postWithoutToken(server.tcp.host, server.tcp.port);

			expect(response.statusCode).toBe(401);
			expect(response.body).toContain("unauthorized");
		});

		it("allows explicit RPC tokens for TCP clients", async () => {
			const server = await startControlRpcServer(
				{
					"daemon.echo": (params) => ({ params }),
				},
				abort.signal,
				{ host: "127.0.0.1", port: 0 },
			);
			closeServer = server.close;
			if (!server.tcp) throw new Error("expected tcp listener");
			const token = await Bun.file(getDaemonControlTokenPath()).text();

			const result = await callControlRpc(
				"daemon.echo",
				{ token: "explicit" },
				{
					...server.tcp,
					token: token.trim(),
				},
			);

			expect(result).toEqual({ params: { token: "explicit" } });
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
