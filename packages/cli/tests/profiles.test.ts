import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { scanSessionModule } from "../src/adapters/base";
import { HermesAdapter } from "../src/adapters/hermes";
import { OpenClawAdapter } from "../src/adapters/openclaw";
import {
	discoverAgentProfiles,
	discoverHermesProfiles,
	profileSessionKey,
} from "../src/adapters/profiles";
import { reconcileAllLocalHermesMcp } from "../src/commands/hermes-mcp";
import { ApiClient } from "../src/lib/api-client";
import {
	createProfileSync,
	moveProfileSessionReceipts,
	profileSessionModule,
} from "../src/lib/profile-sessions";
import { sessionFence } from "../src/lib/session-upload";
import {
	cacheKey,
	persistFencedSessionEntry,
	readFencedSessionEntry,
	readSessionsLock,
	sessionFenceKey,
} from "../src/lib/sessions-lock";
import { log } from "../src/serve/log";
import { cleanupTmp, copyFixtureToTmp } from "./adapters/helpers";

const savedFetch = globalThis.fetch;
const saved = {
	HOME: process.env.HOME,
	PATH: process.env.PATH,
	HERMES_HOME: process.env.HERMES_HOME,
	HERMES_PROFILE: process.env.HERMES_PROFILE,
	OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
	OPENCLAW_AGENT_ID: process.env.OPENCLAW_AGENT_ID,
};
let home = "";
let fixture = "";
const configMock = resolve(import.meta.dir, "../src/test-support/hermes-config-cli-mock.ts");

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "clawdi-profiles-"));
	process.env.HOME = home;
	process.env.HERMES_HOME = join(home, ".hermes");
	process.env.HERMES_PROFILE = "work";
	process.env.PATH = `${join(home, "bin")}:${saved.PATH ?? ""}`;
	const root = join(home, ".hermes");
	const source = join(root, "hermes-agent", "hermes_cli");
	mkdirSync(source, { recursive: true });
	writeFileSync(join(source, "__init__.py"), "");
	// Fixture for the upstream API: Clawdi must ask it, never scan directory names itself.
	writeFileSync(
		join(source, "profiles.py"),
		`
import json, os
from pathlib import Path
root = Path(os.environ['HERMES_HOME'])
def get_profile_dir(name):
    return root if name == 'default' else root / 'profiles' / name
def list_profile_names():
    if (root / 'discovery-failure').exists(): raise RuntimeError('fixture failure')
    return json.loads((root / 'official-roster.json').read_text())
def read_profile_meta(path):
    marker = path / 'profile.yaml'
    return json.loads(marker.read_text()) if marker.exists() else {}
`,
	);
	executable(join(root, "hermes-agent", "venv", "bin", "python"), 'exec python3 "$@"');
	executable(join(home, "bin", "hermes"), `exec '${process.execPath}' '${configMock}' "$@"`);
	roster(["default", "work"]);
	for (const name of ["work", "no-identity", "deleted"])
		mkdirSync(join(root, "profiles", name), { recursive: true });
	writeFileSync(join(root, "profiles", "work", "profile.yaml"), '{"previous_names":["old"]}');
	writeFileSync(join(root, "profiles", "deleted", "config.yaml"), "{}");
	mkdirSync(join(root, "profiles", ".deleted"), { recursive: true });
	writeFileSync(join(root, "profiles", ".deleted", "deleted"), "");
	fixture = copyFixtureToTmp("hermes");
	for (const path of [root, join(root, "profiles", "work")])
		cpSync(join(fixture, ".hermes", "state.db"), join(path, "state.db"));
});

afterEach(() => {
	globalThis.fetch = savedFetch;
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(home, { recursive: true, force: true });
	cleanupTmp(fixture);
});
function executable(path: string, script: string) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}
function roster(names: string[]) {
	writeFileSync(join(home, ".hermes", "official-roster.json"), JSON.stringify(names));
}
function api(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
	globalThis.fetch = Object.assign(fetcher, { preconnect: savedFetch.preconnect });
	return new ApiClient({ baseUrl: "https://profiles.test", requireAuth: false });
}
function response(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function row(key: string, state = "active", count = 0) {
	return {
		id: `id-${key}`,
		profile_key: key,
		upstream_key: key || "default",
		is_default: key === "",
		state,
		online: false,
		display_name: null,
		session_count: count,
		first_seen_at: "2026-10-06T00:00:00Z",
		last_seen_at: "2026-10-06T00:00:00Z",
		removed_at: null,
	};
}

test("official Hermes discovery ignores shells and tombstones and exposes upstream rename history", () => {
	const profiles = discoverHermesProfiles();
	expect(profiles.map((profile) => profile.profileKey)).toEqual(["", "work"]);
	expect(profiles[1]?.previousNames).toEqual(["old"]);
	expect(profiles[1]?.reader?.watchPaths()).toContain(
		join(home, ".hermes", "profiles", "work", "state.db"),
	);
});

test("default receipt keys remain byte-identical and named profiles cannot collide", () => {
	const client = api(async () => response(null));
	const fence = sessionFence(client, {
		environmentId: "env",
		adapter: "hermes",
		sourceSessionKey: "same",
	});
	const explicitDefault = sessionFence(client, {
		environmentId: "env",
		adapter: "hermes",
		sourceSessionKey: profileSessionKey("", "same"),
		profileKey: "",
	});
	expect(cacheKey("hermes", "same")).toBe("hermes:same");
	expect(sessionFenceKey(explicitDefault)).toBe(sessionFenceKey(fence));
	expect(profileSessionKey("", "same")).toBe("same");
	const work = { ...fence, sourceSessionKey: profileSessionKey("work", "same") };
	expect(sessionFenceKey(work)).not.toBe(sessionFenceKey(fence));
	persistFencedSessionEntry(fence, {
		protocol: "events-v1",
		local_hash: "hash",
		source_revision: "revision",
		event_revision: 8,
	});
	moveProfileSessionReceipts(client, "env", "hermes", "", "work", ["same"]);
	const entry = readFencedSessionEntry(readSessionsLock(), work);
	expect(entry?.local_hash).toBe("hash");
	expect(entry?.event_revision).toBe(8);
	expect(entry?.source_revision).toBe("revision");
	expect(readFencedSessionEntry(readSessionsLock(), fence)).toBeUndefined();
});

test("Hermes MCP uses the official selector for every profile and preserves other servers", () => {
	const defaultConfig = join(home, ".hermes", "config.yaml");
	const workConfig = join(home, ".hermes", "profiles", "work", "config.yaml");
	writeFileSync(defaultConfig, "mcp_servers:\n  other:\n    command: other\n");
	writeFileSync(workConfig, "mcp_servers:\n  work-only:\n    command: helper\n");
	expect(reconcileAllLocalHermesMcp(true)).toBeTrue();
	expect(parse(readFileSync(defaultConfig, "utf8"))).toEqual({
		mcp_servers: { other: { command: "other" }, clawdi: { command: "clawdi", args: ["mcp"] } },
	});
	expect(parse(readFileSync(workConfig, "utf8"))).toEqual({
		mcp_servers: {
			"work-only": { command: "helper" },
			clawdi: { command: "clawdi", args: ["mcp"] },
		},
	});
	expect(reconcileAllLocalHermesMcp(true)).toBeFalse();
	expect(reconcileAllLocalHermesMcp(false)).toBeTrue();
	expect(parse(readFileSync(workConfig, "utf8"))).toEqual({
		mcp_servers: { "work-only": { command: "helper" } },
	});
});

test("per-profile readers preserve duplicate imported IDs and projection bytes", async () => {
	const client = api(async (input) => {
		const request = input instanceof Request ? input : new Request(input);
		return response(request.method === "PUT" ? [row(""), row("work")] : []);
	});
	const module = profileSessionModule(new HermesAdapter(), client, "env");
	if (!module) throw new Error("Expected session module");
	const scan = await scanSessionModule(module, { kind: "complete" });
	const sessions = [];
	for await (const batch of scan.batches) sessions.push(...batch.sessions);
	const duplicate = sessions.filter((session) => session.localSessionId === "s-modern");
	expect(duplicate.map((session) => session.profileKey)).toEqual(["", "work"]);
	const defaultSession = await module.resolve("s-modern");
	const workSession = await module.resolve("work:s-modern");
	expect(defaultSession?.events).toEqual(workSession?.events);
	expect(defaultSession?.localSessionId).toBe("s-modern");
	expect(workSession?.localSessionId).toBe("s-modern");
});

test("discovery failure reports incomplete inventory and only scans default", async () => {
	writeFileSync(join(home, ".hermes", "discovery-failure"), "");
	const inventories: unknown[] = [];
	const client = api(async (input) => {
		const request = input instanceof Request ? input : new Request(input);
		if (request.method === "PUT") inventories.push(await request.json());
		return response([]);
	});
	const discovery = await discoverAgentProfiles(new HermesAdapter());
	expect(discovery.complete).toBeFalse();
	expect(discovery.profiles.map((profile) => profile.profileKey)).toEqual([""]);
	const module = profileSessionModule(new HermesAdapter(), client, "env");
	if (!module) throw new Error("Expected session module");
	const result = await module.collect({ kind: "complete" });
	expect(result.sessions.every((session) => session.profileKey === "")).toBeTrue();
	expect(inventories).toEqual([
		{ complete: false, profiles: [{ upstream_key: "default", is_default: true }] },
	]);
});

test("old backend capability fallback uploads only default and omits profile metadata", async () => {
	const client = api(async () => response({ detail: "Not Found" }, 404));
	const module = profileSessionModule(new HermesAdapter(), client, "env");
	if (!module) throw new Error("Expected session module");
	const result = await module.collect({ kind: "complete" });
	expect(result.sessions.length).toBeGreaterThan(0);
	expect(result.sessions.every((session) => session.profileKey === undefined)).toBeTrue();
	expect(
		parse(readFileSync(join(home, ".hermes", "profiles", "work", "config.yaml"), "utf8"))
			.mcp_servers.clawdi,
	).toEqual({ command: "clawdi", args: ["mcp"] });
});

test("Hermes upstream rename moves Cloud before reading sessions and retains local receipts", async () => {
	const calls: string[] = [];
	const client = api(async (input) => {
		const request = input instanceof Request ? input : new Request(input);
		calls.push(`${request.method} ${new URL(request.url).pathname}`);
		if (request.method === "GET") return response([row(""), row("old", "active", 2)]);
		if (request.method === "PUT") return response([row(""), row("old", "removed", 2), row("work")]);
		return response({ sessions_moved: 2, suppressions_moved: 1 });
	});
	const oldFence = sessionFence(client, {
		environmentId: "env",
		adapter: "hermes",
		sourceSessionKey: "old:s-modern",
		profileKey: "old",
	});
	persistFencedSessionEntry(oldFence, {
		protocol: "events-v1",
		local_hash: "unchanged",
		event_revision: 2,
	});
	const module = profileSessionModule(new HermesAdapter(), client, "env");
	if (!module) throw new Error("Expected session module");
	await module.collect({ kind: "complete" });
	expect(calls).toEqual([
		"GET /v1/agents/env/profiles",
		"PUT /v1/agents/env/profiles",
		"POST /v1/agents/env/profiles/old/rename",
	]);
	const newFence = { ...oldFence, sourceSessionKey: "work:s-modern", profileKey: "work" };
	expect(readFencedSessionEntry(readSessionsLock(), newFence)?.local_hash).toBe("unchanged");
	expect(existsSync(join(home, ".hermes", "profiles", "work", "state.db"))).toBeTrue();
});

for (const lostResponse of ["inventory", "rename"] as const) {
	test(`Hermes rename survives a lost ${lostResponse} response and restart`, async () => {
		let registered = false;
		let renamed = false;
		let lost = false;
		let restarted = false;
		let renames = 0;
		const current = () =>
			renamed
				? [row(""), { ...row("work"), id: "id-old" }]
				: [
						row(""),
						row("old", registered ? "removed" : "active", 2),
						...(registered ? [row("work")] : []),
					];
		const client = api(async (input) => {
			const request = input instanceof Request ? input : new Request(input);
			if (request.method === "GET") return response(current());
			if (request.method === "PUT") {
				registered = true;
				if (lostResponse === "inventory" && !restarted) {
					lost = true;
					return response({ detail: "transport failure" }, 503);
				}
				return response(current());
			}
			renames++;
			renamed = true;
			if (lostResponse === "rename" && !lost) {
				lost = true;
				return response({ detail: "transport failure" }, 503);
			}
			return response({ sessions_moved: 2, suppressions_moved: 0 });
		});
		const oldFence = sessionFence(client, {
			environmentId: "env",
			adapter: "hermes",
			sourceSessionKey: "old:s-modern",
			profileKey: "old",
		});
		persistFencedSessionEntry(oldFence, {
			protocol: "events-v1",
			local_hash: "unchanged",
			event_revision: 2,
		});
		await expect(createProfileSync(new HermesAdapter(), client, "env").refresh()).rejects.toThrow();
		restarted = true;
		await createProfileSync(new HermesAdapter(), client, "env").refresh();
		expect(renames).toBe(1);
		const entry = readFencedSessionEntry(readSessionsLock(), {
			...oldFence,
			sourceSessionKey: "work:s-modern",
			profileKey: "work",
		});
		expect(entry?.local_hash).toBe("unchanged");
		expect(entry?.event_revision).toBe(2);
	});
}

test("an already known empty profile is not inferred to be a rename", async () => {
	let renames = 0;
	const client = api(async (input) => {
		const request = input instanceof Request ? input : new Request(input);
		if (request.method === "POST") renames++;
		return response([row(""), row("old", "removed", 2), row("work")]);
	});
	await createProfileSync(new HermesAdapter(), client, "env").refresh();
	expect(renames).toBe(0);
});

test("profile inventory and MCP refresh while session sync is disabled", async () => {
	const inventories: unknown[] = [];
	const client = api(async (input) => {
		const request = input instanceof Request ? input : new Request(input);
		if (request.method === "PUT") inventories.push(await request.json());
		return response([]);
	});
	const adapter = new HermesAdapter();
	const sync = createProfileSync(
		{
			agentType: adapter.agentType,
			skills: adapter.skills,
			detect: () => adapter.detect(),
			getVersion: () => adapter.getVersion(),
		},
		client,
		"env",
	);
	expect(sync.sessions).toBeUndefined();
	await sync.refresh();
	expect(inventories).toEqual([
		{
			complete: true,
			profiles: [
				{ upstream_key: "default", is_default: true },
				{ upstream_key: "work", is_default: false },
			],
		},
	]);
	expect(
		parse(readFileSync(join(home, ".hermes", "profiles", "work", "config.yaml"), "utf8"))
			.mcp_servers.clawdi,
	).toEqual({ command: "clawdi", args: ["mcp"] });
});

test("multiple removed names rename only the most recent match without blocking profile scans", async () => {
	writeFileSync(
		join(home, ".hermes", "profiles", "work", "profile.yaml"),
		'{"previous_names":["old","recent","unknown"]}',
	);
	roster(["default", "work", "other"]);
	const otherHome = join(home, ".hermes", "profiles", "other");
	mkdirSync(otherHome, { recursive: true });
	cpSync(join(fixture, ".hermes", "state.db"), join(otherHome, "state.db"));
	let inventory = [row(""), row("old", "removed", 7), row("recent", "removed", 3), row("other")];
	const renames: { path: string; body: unknown }[] = [];
	const client = api(async (input) => {
		const request = input instanceof Request ? input : new Request(input);
		if (request.method === "PUT") {
			inventory.push(row("work"));
			return response(inventory);
		}
		if (request.method === "POST") {
			renames.push({ path: new URL(request.url).pathname, body: await request.json() });
			inventory = inventory.filter((profile) => !["recent", "work"].includes(profile.profile_key));
			inventory.push({ ...row("work", "active", 3), id: "id-recent" });
			return response({ sessions_moved: 3, suppressions_moved: 0 });
		}
		return response(inventory);
	});
	const fence = (profileKey: string) =>
		sessionFence(client, {
			environmentId: "env",
			adapter: "hermes",
			sourceSessionKey: profileSessionKey(profileKey, "s-modern"),
			profileKey,
		});
	for (const key of ["old", "recent"])
		persistFencedSessionEntry(fence(key), {
			protocol: "events-v1",
			local_hash: `unchanged-${key}`,
			event_revision: 2,
		});
	const warn = spyOn(log, "warn");
	try {
		const result = await createProfileSync(new HermesAdapter(), client, "env").sessions?.collect({
			kind: "complete",
		});
		expect(renames).toEqual([
			{
				path: "/v1/agents/env/profiles/recent/rename",
				body: { new_upstream_key: "work" },
			},
		]);
		expect(inventory.find((profile) => profile.profile_key === "old")).toEqual(
			row("old", "removed", 7),
		);
		expect(inventory.find((profile) => profile.profile_key === "work")?.id).toBe("id-recent");
		expect(
			result?.sessions
				.filter((session) => session.localSessionId === "s-modern")
				.map((session) => session.profileKey),
		).toEqual(["", "work", "other"]);
		const lock = readSessionsLock();
		expect(readFencedSessionEntry(lock, fence("recent"))).toBeUndefined();
		expect(readFencedSessionEntry(lock, fence("work"))?.local_hash).toBe("unchanged-recent");
		expect(readFencedSessionEntry(lock, fence("old"))?.local_hash).toBe("unchanged-old");
		expect(warn.mock.calls).toEqual([
			[
				"profiles.rename_multiple_previous_names",
				{
					profile_key: "work",
					selected_profile_key: "recent",
					removed_profile_keys: ["old"],
				},
			],
		]);
	} finally {
		warn.mockRestore();
	}
});

test("OpenClaw official roster honors the configured default and attributes receipts before sync", async () => {
	const stateRoot = join(home, ".openclaw");
	const openclawFixture = copyFixtureToTmp("openclaw");
	try {
		cpSync(join(openclawFixture, ".openclaw"), stateRoot, { recursive: true });
	} finally {
		cleanupTmp(openclawFixture);
	}
	const financial = join(stateRoot, "agents", "financial", "sessions");
	mkdirSync(financial, { recursive: true });
	writeFileSync(
		join(financial, "sessions.json"),
		JSON.stringify({ finance: { sessionId: "financial-session", updatedAt: 1776247200000 } }),
	);
	writeFileSync(
		join(financial, "financial-session.jsonl"),
		JSON.stringify({
			type: "message",
			timestamp: 1776247200000,
			message: { role: "user", content: "fixture input" },
		}),
	);
	executable(
		join(home, "bin", "openclaw"),
		`if [ "$*" = "agents list --json" ]; then printf '[{"id":"main","isDefault":true,"workspace":"%s/agents/main"},{"id":"financial","workspace":"%s/agents/financial"}]' "$OPENCLAW_STATE_DIR" "$OPENCLAW_STATE_DIR"; else exit 1; fi`,
	);
	process.env.OPENCLAW_STATE_DIR = stateRoot;
	process.env.OPENCLAW_AGENT_ID = "financial";
	const inventories: unknown[] = [];
	const attributions: unknown[] = [];
	const client = api(async (input) => {
		const request = input instanceof Request ? input : new Request(input);
		if (request.method === "PUT") {
			inventories.push(await request.json());
			return response([row(""), row("main")]);
		}
		if (request.method === "POST") {
			attributions.push(await request.json());
			return response({ sessions_moved: 1, suppressions_moved: 0 });
		}
		return response([]);
	});
	const oldFence = sessionFence(client, {
		environmentId: "env",
		adapter: "openclaw",
		sourceSessionKey: "oc-session-001",
	});
	persistFencedSessionEntry(oldFence, {
		protocol: "events-v1",
		local_hash: "unchanged",
		event_revision: 2,
	});
	const result = await createProfileSync(new OpenClawAdapter(), client, "env").sessions?.collect({
		kind: "complete",
	});
	expect(inventories).toEqual([
		{
			complete: true,
			profiles: [
				{ upstream_key: "main", is_default: false },
				{ upstream_key: "financial", is_default: true },
			],
		},
	]);
	expect(result?.sessions.map((session) => [session.profileKey, session.localSessionId])).toEqual([
		["main", "oc-session-001"],
		["", "financial-session"],
	]);
	expect(attributions).toEqual([{ local_session_ids: ["oc-session-001"] }]);
	expect(
		readFencedSessionEntry(readSessionsLock(), {
			...oldFence,
			sourceSessionKey: "main:oc-session-001",
			profileKey: "main",
		})?.local_hash,
	).toBe("unchanged");
});
