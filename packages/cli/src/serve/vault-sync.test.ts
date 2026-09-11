import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../lib/api-client";
import { getAuth, setAuth, setConfig } from "../lib/config";
import { writeEnvironmentRegistration } from "../lib/environment-registration";
import { getOrCreateMachineId } from "../lib/machine-identity";
import { prepareConnectedVaultSync } from "./vault-sync";

const environment = { ...process.env };
const roots: string[] = [];
afterEach(() => {
	process.env = { ...environment };
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "connected-vault-"));
	roots.push(root);
	process.env.HOME = root;
	process.env.CLAWDI_HOME = join(root, "state");
	delete process.env.CLAWDI_AUTH_TOKEN;
	delete process.env.CLAWDI_RUNTIME_MODE;
	process.env.CLAWDI_RUNTIME_USER = "not-the-connected-user";
	delete process.env.CLAWDI_API_URL;
	process.env.CLAWDI_STATE_DIR = join(root, "serve");
	mkdirSync(join(root, "serve", "pi"), { recursive: true, mode: 0o700 });
	const workspace = join(root, "project");
	mkdirSync(workspace);
	const userId = randomUUID(),
		agentId = randomUUID();
	setAuth({ apiKey: "fixture", userId });
	const machineId = getOrCreateMachineId();
	return { root, workspace, userId, agentId, machineId };
}

test("connected delivery fences identity, retains offline files, coalesces changes and clears old bindings", async () => {
	const f = fixture();
	const abort = new AbortController();
	let version = 1,
		status = 200,
		materialCalls = 0;
	const fieldId = randomUUID(),
		vaultId = randomUUID(),
		projectId = randomUUID();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			expect(req.headers.get("X-Clawdi-Machine-Id")).toBe(f.machineId);
			expect(new URL(req.url).searchParams.get("agent_id")).toBe(f.agentId);
			if (status !== 200) return new Response(null, { status });
			const etag = `"${version}"`;
			if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
			const material = req.method === "POST";
			if (material) materialCalls++;
			return Response.json(
				{
					schema_version: 1,
					complete: true,
					user_id: f.userId,
					agent_id: f.agentId,
					vaults: [
						{
							id: vaultId,
							name: "Test",
							slug: "test",
							project_ids: [projectId],
							revision: String(version),
							fields: material
								? [
										{
											id: fieldId,
											name: "TOKEN",
											section: "",
											references: ["clawdi://test/TOKEN"],
											value: `value-${version}`,
										},
									]
								: null,
						},
					],
				},
				{ headers: { etag } },
			);
		},
	});
	setConfig({ apiUrl: server.url.origin });
	setAuth({
		apiKey: "fixture",
		userId: f.userId,
		endpointBinding: { version: 1, cloudApiOrigin: server.url.origin },
	});
	writeEnvironmentRegistration({
		id: f.agentId,
		agentType: "pi",
		machineId: f.machineId,
		machineName: "test",
		userId: f.userId,
		vaultWorkspace: { path: f.workspace, apiOrigin: server.url.origin },
	});
	const messages: (string | null)[] = [];
	const sync = prepareConnectedVaultSync({
		agentType: "pi",
		agentId: f.agentId,
		api: new ApiClient(),
		abort: abort.signal,
		report: (message) => messages.push(message),
	});
	let now = Date.now();
	const clock = spyOn(Date, "now").mockImplementation(() => now);
	const dir = join(f.workspace, ".clawdi", "vaults");
	try {
		await sync.reconcile();
		expect(sync.enabled).toBe(true);
		const file = join(
			dir,
			readdirSync(dir).find((name) => name !== "index.json" && name.endsWith(".json")) ?? "missing",
		);
		expect(JSON.parse(readFileSync(file, "utf8")).TOKEN).toBe("value-1");
		const mtime = statSync(file, { bigint: true }).mtimeNs;
		now += 1000;
		await sync.reconcile();
		expect(statSync(file, { bigint: true }).mtimeNs).toBe(mtime);
		expect(materialCalls).toBe(1);
		version++;
		now += 1000;
		await Promise.all([sync.reconcile(), sync.reconcile()]);
		expect(JSON.parse(readFileSync(file, "utf8")).TOKEN).toBe("value-2");
		status = 503;
		now += 1000;
		await sync.reconcile();
		expect(JSON.parse(readFileSync(file, "utf8")).TOKEN).toBe("value-2");
		status = 403;
		now += 300001;
		await sync.reconcile();
		expect(readdirSync(dir)).toEqual([]);
		status = 200;
		now += 1000;
		await sync.reconcile();
		expect(readdirSync(dir).length).toBeGreaterThan(0);
		const nextUser = randomUUID();
		setAuth({
			apiKey: "other-account",
			userId: nextUser,
			endpointBinding: { version: 1, cloudApiOrigin: server.url.origin },
		});
		now += 1000;
		await sync.reconcile();
		expect(sync.enabled).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
		expect(
			messages.some((message) => message?.includes("disabled") || message?.includes("identity")),
		).toBe(true);
		f.userId = nextUser;
		f.agentId = randomUUID();
		version++;
		now += 1000;
		writeEnvironmentRegistration({
			id: f.agentId,
			agentType: "pi",
			machineId: f.machineId,
			machineName: "new",
			userId: f.userId,
			vaultWorkspace: { path: f.workspace, apiOrigin: server.url.origin },
		});
		const replacement = prepareConnectedVaultSync({
			agentType: "pi",
			agentId: f.agentId,
			api: new ApiClient(),
			abort: abort.signal,
			report() {},
		});
		await replacement.reconcile();
		await sync.finish(); // An obsolete worker must not clear the new owner's files.
		expect(JSON.parse(readFileSync(file, "utf8")).TOKEN).toBe("value-3");
		await replacement.finish();
	} finally {
		clock.mockRestore();
		abort.abort();
		await sync.finish();
		server.stop(true);
	}
});

test("missing targets and Hosted mode never start a second file writer", async () => {
	const f = fixture();
	setConfig({ apiUrl: "http://127.0.0.1:1" });
	const abort = new AbortController();
	const api = new ApiClient();
	const sync = prepareConnectedVaultSync({
		agentType: "pi",
		agentId: f.agentId,
		api,
		abort: abort.signal,
		report() {},
	});
	expect(sync.enabled).toBe(false);
	await sync.reconcile();
	process.env.CLAWDI_RUNTIME_MODE = "hosted";
	const hosted = prepareConnectedVaultSync({
		agentType: "pi",
		agentId: f.agentId,
		api,
		abort: abort.signal,
		report() {},
	});
	expect(hosted.enabled).toBe(false);
	await hosted.reconcile();
	expect(getAuth()?.userId).toBe(f.userId);
	abort.abort();
	await sync.finish();
	await hosted.finish();
});
