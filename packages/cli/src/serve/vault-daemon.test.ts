import { expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter } from "../adapters/base";
import { setAuth, setConfig } from "../lib/config";
import { writeEnvironmentRegistration } from "../lib/environment-registration";
import { runSyncEngine } from "./sync-engine";

test.skipIf(!process.env.CLAWDI_VAULT_FIXTURE_URL)(
	"connected daemon Vault delivery with SSE, missed fallback, offline and detach",
	async () => {
		const apiUrl = process.env.CLAWDI_VAULT_FIXTURE_URL,
			agentId = process.env.CLAWDI_VAULT_FIXTURE_AGENT,
			userId = process.env.CLAWDI_VAULT_FIXTURE_USER,
			machineId = process.env.CLAWDI_VAULT_FIXTURE_MACHINE,
			token = process.env.CLAWDI_VAULT_FIXTURE_TOKEN,
			owner = process.env.CLAWDI_VAULT_FIXTURE_OWNER,
			vaultId = process.env.CLAWDI_VAULT_FIXTURE_VAULT;
		if (!apiUrl || !agentId || !userId || !machineId || !token || !owner || !vaultId)
			throw new Error("Missing isolated connected fixture");
		const environment = { ...process.env };
		const root = mkdtempSync(join(tmpdir(), "vault-daemon-"));
		process.env.HOME = join(root, "home");
		mkdirSync(process.env.HOME);
		process.env.CLAWDI_HOME = join(root, "state");
		mkdirSync(process.env.CLAWDI_HOME);
		process.env.CLAWDI_STATE_DIR = join(root, "serve");
		delete process.env.CLAWDI_RUNTIME_MODE;
		delete process.env.CLAWDI_AUTH_TOKEN;
		delete process.env.CLAWDI_API_URL;
		// An explicitly authorized directory outside HOME must remain supported.
		const workspace = join(root, "project");
		mkdirSync(workspace);
		setAuth({ apiKey: token, userId, endpointBinding: { version: 1, cloudApiOrigin: apiUrl } });
		setConfig({ apiUrl });
		writeFileSync(
			join(process.env.CLAWDI_HOME, "machine.json"),
			JSON.stringify({ schemaVersion: "clawdi.machineIdentity.v1", id: machineId }),
			{ mode: 0o600 },
		);
		writeEnvironmentRegistration({
			id: agentId,
			agentType: "pi",
			machineId,
			machineName: "fixture",
			userId,
			vaultWorkspace: { path: workspace, apiOrigin: apiUrl },
		});
		const adapter: AgentAdapter = {
			agentType: "pi",
			async detect() {
				return true;
			},
			async getVersion() {
				return null;
			},
			sessions: {
				async contentProtocol() {
					return "snapshot-v1";
				},
				async collect() {
					return { coverage: "complete", sessions: [], dedupedCount: 0 };
				},
				async resolve() {
					return null;
				},
				watchPaths() {
					return [];
				},
			},
		};
		const originalFetch = globalThis.fetch;
		let offline = false,
			sseDenied = false,
			metadata = 0,
			sse = 0,
			material = 0;
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (...args: Parameters<typeof fetch>) => {
					const path = new URL(args[0] instanceof Request ? args[0].url : String(args[0])).pathname;
					if (path === "/v1/runtime/vaults") {
						metadata++;
						if (offline) return new Response(null, { status: 503 });
					}
					if (path === "/v1/runtime/vaults/material") material++;
					if (path === "/v1/sync/events") {
						sse++;
						if (sseDenied) return new Response(null, { status: 403 });
					}
					return originalFetch(...args);
				},
				{ preconnect: originalFetch.preconnect },
			),
		);
		const dir = join(workspace, ".clawdi", "vaults"),
			indexPath = join(dir, "index.json");
		const readIndex = () => JSON.parse(readFileSync(indexPath, "utf8"));
		const fieldFile = () => join(dir, readIndex().vaults[0].sections[0].file);
		async function waitFor(check: () => boolean) {
			const deadline = Date.now() + 8000;
			while (!check()) {
				if (Date.now() > deadline) throw new Error("Connected Vault delivery timeout");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		let abort = new AbortController();
		let heartbeatIntervalMs = 15000;
		const start = () =>
			runSyncEngine({
				adapter,
				environmentId: agentId,
				abort: abort.signal,
				abortController: abort,
				forcePollWatcher: true,
				heartbeatIntervalMs,
			});
		let engine = start();
		try {
			await waitFor(() => existsSync(indexPath) && readIndex().vaults.length === 1);
			expect(sse).toBe(1);
			const file = fieldFile();
			expect(JSON.parse(readFileSync(file, "utf8")).TOKEN).toBe("initial");
			const projectId = readIndex().vaults[0].project_ids[0];
			await new Promise((resolve) => setTimeout(resolve, 750));
			const settledMetadata = metadata;
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(metadata).toBe(settledMetadata);
			for (const missed of [false, true]) {
				if (missed) {
					abort.abort();
					await engine;
					heartbeatIntervalMs = 200;
					sseDenied = true;
					abort = new AbortController();
					const beforeRestart = metadata;
					engine = start();
					await waitFor(() => metadata >= beforeRestart + 3);
				}
				const value = missed ? "fallback" : "sse";
				const begin = performance.now();
				const saved = await originalFetch(`${apiUrl}/v1/vault/live/items?vault_id=${vaultId}`, {
					method: "PUT",
					headers: {
						Authorization: `Bearer ${owner}`,
						"Content-Type": "application/json",
						...(missed ? { "X-Fixture-Missed": "true" } : {}),
					},
					body: JSON.stringify({ fields: { TOKEN: value }, section: "" }),
				});
				expect(saved.status).toBe(200);
				await waitFor(() => JSON.parse(readFileSync(file, "utf8")).TOKEN === value);
				console.log(
					JSON.stringify({
						fixture: "connected PostgreSQL daemon",
						missedEvent: missed,
						fallbackMs: heartbeatIntervalMs,
						saveToFileMs: Math.round(performance.now() - begin),
					}),
				);
			}
			const mtime = statSync(file, { bigint: true }).mtimeNs;
			const before = metadata;
			await waitFor(() => metadata > before);
			expect(statSync(file, { bigint: true }).mtimeNs).toBe(mtime);
			offline = true;
			const beforeOffline = metadata;
			await waitFor(() => metadata > beforeOffline);
			expect(JSON.parse(readFileSync(file, "utf8")).TOKEN).toBe("fallback");
			abort.abort();
			await engine;
			expect(statSync(file, { bigint: true }).mtimeNs).toBe(mtime);
			offline = false;
			sseDenied = false;
			abort = new AbortController();
			engine = start();
			const beforeReconnect = metadata;
			await waitFor(() => metadata > beforeReconnect);
			const removed = await originalFetch(
				`${apiUrl}/v1/vault/live?vault_id=${vaultId}&project_id=${projectId}`,
				{ method: "DELETE", headers: { Authorization: `Bearer ${owner}` } },
			);
			expect(removed.status).toBe(200);
			await waitFor(() => readIndex().vaults.length === 0);
			expect(readdirSync(dir).sort()).toEqual([".gitignore", "index.json"]);
			expect(abort.signal.aborted).toBe(false);
			expect(sse).toBe(3);
			expect(material).toBeGreaterThanOrEqual(3);
		} finally {
			abort.abort();
			await engine;
			fetchSpy.mockRestore();
			process.env = environment;
			rmSync(root, { recursive: true, force: true });
		}
	},
	30000,
);
