import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "../commands/serve";
import { ApiClient } from "../lib/api-client";
import { getAuth, setAuth, setConfig } from "../lib/config";
import {
	readEnvironmentRegistration,
	writeEnvironmentRegistration,
} from "../lib/environment-registration";
import { getOrCreateMachineId } from "../lib/machine-identity";
import { clearAccountMismatchedVaultFiles, prepareConnectedVaultSync } from "./vault-sync";

const environment = { ...process.env };
const roots: string[] = [];
afterEach(() => {
	process.env = { ...environment };
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "connected-vault-")));
	roots.push(root);
	process.env.HOME = root;
	process.env.CLAWDI_HOME = join(root, "state");
	delete process.env.CLAWDI_AUTH_TOKEN;
	delete process.env.CLAWDI_RUNTIME_MODE;
	process.env.CLAWDI_RUNTIME_USER = "not-the-connected-user";
	delete process.env.CLAWDI_API_URL;
	process.env.CLAWDI_STATE_DIR = join(root, "serve");
	mkdirSync(join(root, "serve", "pi"), { recursive: true, mode: 0o755 });
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
	let requestGate: Promise<void> | undefined;
	const requestStarted = Promise.withResolvers<void>();
	let version = 1,
		status = 200,
		materialCalls = 0;
	const fieldId = randomUUID(),
		vaultId = randomUUID(),
		projectId = randomUUID();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			if (requestGate) {
				requestStarted.resolve();
				await requestGate;
			}
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
							content_version: version,
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
		expect(statSync(join(f.root, "serve", "pi")).mode & 0o777).toBe(0o755);
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
		now += 1000;
		const gate = Promise.withResolvers<void>();
		requestGate = gate.promise;
		const pending = sync.reconcile();
		await requestStarted.promise;
		const nextUser = randomUUID();
		setAuth({
			apiKey: "other-account",
			userId: nextUser,
			endpointBinding: { version: 1, cloudApiOrigin: server.url.origin },
		});
		sync.revoke(); // Cleanup must defer without blocking the pending native writer.
		gate.resolve();
		requestGate = undefined;
		await pending;
		expect(sync.enabled).toBe(false);
		expect(readdirSync(dir)).toEqual([]);
		expect(JSON.stringify(messages)).not.toContain("value-");
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
		writeFileSync(
			join(f.root, "state", "machine.json"),
			JSON.stringify({ schemaVersion: "clawdi.machineIdentity.v1", id: randomUUID() }),
			{ mode: 0o600 },
		);
		await replacement.reconcile(true);
		expect(readdirSync(dir)).toEqual([]);
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

test("cold account switch clears only matching old provenance, never a replacement binding", async () => {
	const f = fixture();
	delete process.env.CLAWDI_AGENT_TYPE;
	delete process.env.CLAWDI_ENVIRONMENT_ID;
	delete process.env.CLAWDI_SERVE_MODE;
	const oldAgent = f.agentId;
	const oldAbort = new AbortController();
	const freshAbort = new AbortController();
	const nextAbort = new AbortController();
	let requests = 0;
	const data = {
		schema_version: 1,
		complete: true,
		user_id: f.userId,
		agent_id: f.agentId,
		vaults: [
			{
				id: randomUUID(),
				name: "Fixture",
				slug: "fixture",
				project_ids: [randomUUID()],
				revision: "one",
				content_version: 1,
				fields: [
					{
						id: randomUUID(),
						section: "",
						name: "TOKEN",
						references: ["clawdi://fixture/TOKEN"],
						value: "old",
					},
				],
			},
		],
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			requests++;
			return Response.json(data, { headers: { etag: '"fixture"' } });
		},
	});
	const auth = (userId: string) =>
		setAuth({
			apiKey: "fixture",
			userId,
			endpointBinding: { version: 1, cloudApiOrigin: server.url.origin },
		});
	setConfig({ apiUrl: server.url.origin });
	auth(f.userId);
	const register = (id: string, userId: string) =>
		writeEnvironmentRegistration({
			id,
			userId,
			agentType: "pi",
			machineId: f.machineId,
			machineName: "fixture",
			vaultWorkspace: { path: f.workspace, apiOrigin: server.url.origin },
		});
	register(oldAgent, f.userId);
	const registrationPath = join(f.root, "state", "environments", "pi.json");
	const oldRegistration = readFileSync(registrationPath);
	const receiptPath = join(f.root, "serve", "pi", "vault-files.json");
	const directory = join(f.workspace, ".clawdi", "vaults");
	const worker = (agentId: string, abort: AbortController) =>
		prepareConnectedVaultSync({
			agentType: "pi",
			agentId,
			api: new ApiClient(),
			abort: abort.signal,
			report() {},
		});
	const old = worker(oldAgent, oldAbort);
	try {
		await old.reconcile();
		oldAbort.abort();
		await old.finish(); // Stop while the original login is still valid.
		expect(readdirSync(directory)).toHaveLength(3);
		const nextUser = randomUUID();
		auth(nextUser);
		expect(readEnvironmentRegistration("pi")).toBeNull();
		const restarted = worker(oldAgent, freshAbort);
		expect(restarted.enabled).toBe(false);
		expect(readdirSync(directory)).toEqual([]);
		await restarted.finish();
		// Recreate an offline cache to exercise daemon selection independently of worker setup.
		auth(f.userId);
		const seedAbort = new AbortController();
		const seed = worker(oldAgent, seedAbort);
		await seed.reconcile();
		seedAbort.abort();
		await seed.finish();
		expect(readdirSync(directory)).toHaveLength(3);
		auth(nextUser);

		// Cold daemon selection filters out old-user registrations, so cleanup must precede it.
		const exit = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("no current Agent");
		});
		try {
			await expect(serve({})).rejects.toThrow("no current Agent");
		} finally {
			exit.mockRestore();
		}
		expect(readdirSync(directory)).toEqual([]);
		const fresh = worker(oldAgent, freshAbort);
		expect(fresh.enabled).toBe(false);
		await fresh.reconcile();
		await fresh.finish();
		expect(requests).toBe(4);

		const nextAgent = randomUUID();
		register(nextAgent, nextUser);
		data.agent_id = nextAgent;
		data.user_id = nextUser;
		data.vaults[0].fields[0].value = "new";
		const next = worker(nextAgent, nextAbort);
		await next.reconcile();
		const nextRegistration = readFileSync(registrationPath);
		const nextReceipt = readFileSync(receiptPath);
		const file = join(
			directory,
			readdirSync(directory).find((name) => name !== "index.json" && name.endsWith(".json")) ??
				"missing",
		);
		try {
			// A stale registration/worker must not confer authority over the new receipt.
			writeFileSync(registrationPath, oldRegistration);
			clearAccountMismatchedVaultFiles("pi");
			const stale = worker(oldAgent, freshAbort);
			expect(stale.enabled).toBe(false);
			await stale.finish();
			old.revoke();
			expect(readFileSync(receiptPath)).toEqual(nextReceipt);
			expect(JSON.parse(readFileSync(file, "utf8")).TOKEN).toBe("new");
			expect(requests).toBe(6);
		} finally {
			writeFileSync(registrationPath, nextRegistration);
			nextAbort.abort();
			await next.finish();
		}
	} finally {
		oldAbort.abort();
		freshAbort.abort();
		nextAbort.abort();
		await old.finish();
		server.stop(true);
	}
});
