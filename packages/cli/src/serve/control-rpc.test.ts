import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callControlRpc, startControlRpcServer } from "./control-rpc";

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
	});
}
