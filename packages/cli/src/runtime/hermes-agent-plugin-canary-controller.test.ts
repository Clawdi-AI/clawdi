import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function waitForReady(path: string): Promise<{ port: number }> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as { port: number };
		await Bun.sleep(20);
	}
	throw new Error("canary controller did not become ready");
}

test("records MCP list and call evidence without inference assertions", async () => {
	const root = mkdtempSync(join(tmpdir(), "clawdi-hermes-canary-controller-"));
	const readyFile = join(root, "ready.json");
	const resultFile = join(root, "result.json");
	const nonce = "a".repeat(32);
	const runtimeIdentity =
		process.geteuid?.() === 0
			? {
					user: "nobody",
					uid: Number(execFileSync("id", ["-u", "nobody"], { encoding: "utf8" })),
					gid: Number(execFileSync("id", ["-g", "nobody"], { encoding: "utf8" })),
				}
			: null;
	if (runtimeIdentity) chownSync(root, runtimeIdentity.uid, runtimeIdentity.gid);
	const child = Bun.spawn(
		[
			"bun",
			join(import.meta.dir, "..", "index.ts"),
			"runtime",
			"agent-plugin-canary",
			"--ready-file",
			readyFile,
			"--result-file",
			resultFile,
			"--nonce",
			nonce,
		],
		{
			cwd: root,
			env: {
				...process.env,
				CLAWDI_NO_UPDATE_CHECK: "1",
				CLAWDI_NO_AUTO_UPDATE: "1",
				...(runtimeIdentity
					? {
							CLAWDI_RUNTIME_USER: runtimeIdentity.user,
							CLAWDI_RUNTIME_UID: String(runtimeIdentity.uid),
							CLAWDI_RUNTIME_GID: String(runtimeIdentity.gid),
						}
					: {}),
			},
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	let client: Client | null = null;
	try {
		const { port } = await waitForReady(readyFile);
		const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
			requestInit: { headers: { "X-Clawdi-Agent-Plugin-Canary": `clawdi-${nonce}` } },
		});
		client = new Client({ name: "clawdi-canary-test", version: "1.0.0" });
		await client.connect(transport);
		const tools = await client.listTools();
		expect(tools.tools.map((tool) => tool.name)).toEqual(["clawdi_agent_plugin_canary"]);
		const call = await client.callTool({ name: "clawdi_agent_plugin_canary", arguments: {} });
		expect(JSON.stringify(call)).toContain(nonce);
		expect(JSON.parse(readFileSync(resultFile, "utf8"))).toEqual({
			mcpToolsList: true,
			mcpToolCall: true,
		});
		if (runtimeIdentity) {
			expect([statSync(readyFile).uid, statSync(resultFile).uid]).toEqual([
				runtimeIdentity.uid,
				runtimeIdentity.uid,
			]);
		}
	} finally {
		await client?.close();
		child.kill("SIGTERM");
		await child.exited;
		rmSync(root, { recursive: true, force: true });
	}
});
