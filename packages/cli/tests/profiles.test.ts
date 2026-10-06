import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
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
import { resolveCurrentCliInvocation } from "../src/lib/current-cli-invocation";
import { createProfileSync, moveProfileSessionReceipts } from "../src/lib/profile-sessions";
import { planSessionUpload, prepareSessionUpload, sessionFence } from "../src/lib/session-upload";
import {
	cacheKey,
	persistFencedSessionEntry,
	readFencedSessionEntry,
	readSessionsLock,
	sessionFenceKey,
} from "../src/lib/sessions-lock";
import { log } from "../src/serve/log";
import { enqueueChangedSessionsAfterStability } from "../src/serve/sync-engine";
import { cleanupTmp, copyFixtureToTmp } from "./adapters/helpers";

const savedFetch = globalThis.fetch;
const saved = {
	HOME: process.env.HOME,
	PATH: process.env.PATH,
	HERMES_HOME: process.env.HERMES_HOME,
	HERMES_PROFILE: process.env.HERMES_PROFILE,
	OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
	OPENCLAW_AGENT_ID: process.env.OPENCLAW_AGENT_ID,
	CLAWDI_RUNTIME_USER: process.env.CLAWDI_RUNTIME_USER,
	CLAWDI_RUNTIME_UID: process.env.CLAWDI_RUNTIME_UID,
	CLAWDI_RUNTIME_GID: process.env.CLAWDI_RUNTIME_GID,
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
root = Path(os.environ['HOME']) / '.hermes'
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

test("official Hermes discovery ignores shells and tombstones and exposes upstream rename history", async () => {
	writeFileSync(
		join(home, ".hermes", "hermes-agent", "hermes_cli", "profiles.py"),
		"\ndef list_profiles():\n    raise RuntimeError('use the newer name API')\n",
		{ flag: "a" },
	);
	const warn = spyOn(log, "warn");
	try {
		const { complete, profiles } = await discoverAgentProfiles(new HermesAdapter());
		expect(complete).toBeTrue();
		expect(profiles.map((profile) => profile.profileKey)).toEqual(["", "work"]);
		expect(profiles[1]?.previousNames).toEqual(["old"]);
		expect(profiles[1]?.reader?.watchPaths()).toContain(
			join(home, ".hermes", "profiles", "work", "state.db"),
		);
		expect(warn.mock.calls).toEqual([]);
	} finally {
		warn.mockRestore();
	}
});

test("Hermes 0.20.x discovery uses its upstream roster without identity or tombstone filtering", async () => {
	writeFileSync(
		join(home, ".hermes", "hermes-agent", "hermes_cli", "profiles.py"),
		`
import json, os
from pathlib import Path
from types import SimpleNamespace
root = Path(os.environ['HOME']) / '.hermes'
def get_profile_dir(name):
    return root if name == 'default' else root / 'profiles' / name
def list_profiles():
    return [SimpleNamespace(name=name, path=get_profile_dir(name))
            for name in json.loads((root / 'official-roster.json').read_text())]
def read_profile_meta(path):
    return {'description': '', 'description_auto': False}
`,
	);
	// These directories are profiles in 0.20.x even without newer identity metadata.
	roster(["default", "deleted", "no-identity", "work"]);
	const warn = spyOn(log, "warn");
	try {
		const discovery = await discoverAgentProfiles(new HermesAdapter());
		expect(discovery.complete).toBeTrue();
		expect(discovery.profiles.map((profile) => profile.profileKey)).toEqual([
			"",
			"deleted",
			"no-identity",
			"work",
		]);
		expect(discovery.profiles[0]).toMatchObject({ upstreamKey: "default", isDefault: true });
		expect(discovery.profiles[3]).toMatchObject({
			upstreamKey: "work",
			isDefault: false,
			previousNames: [],
			home: join(home, ".hermes", "profiles", "work"),
		});
		expect(discovery.watchPaths).toEqual([join(home, ".hermes", "profiles")]);
		expect(warn.mock.calls).toEqual([]);
	} finally {
		warn.mockRestore();
	}
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

test("Hermes MCP uses the official selector and absolute CLI invocation for every profile", async () => {
	const { command, args } = resolveCurrentCliInvocation(["mcp"]);
	const defaultConfig = join(home, ".hermes", "config.yaml");
	const workConfig = join(home, ".hermes", "profiles", "work", "config.yaml");
	writeFileSync(defaultConfig, "mcp_servers:\n  other:\n    command: other\n");
	writeFileSync(workConfig, "mcp_servers:\n  work-only:\n    command: helper\n");
	expect(await reconcileAllLocalHermesMcp(true)).toBeTrue();
	expect(parse(readFileSync(defaultConfig, "utf8"))).toEqual({
		mcp_servers: { other: { command: "other" }, clawdi: { command, args } },
	});
	expect(parse(readFileSync(workConfig, "utf8"))).toEqual({
		mcp_servers: {
			"work-only": { command: "helper" },
			clawdi: { command, args },
		},
	});
	expect(await reconcileAllLocalHermesMcp(true)).toBeFalse();
	expect(await reconcileAllLocalHermesMcp(false)).toBeTrue();
	expect(parse(readFileSync(workConfig, "utf8"))).toEqual({
		mcp_servers: { "work-only": { command: "helper" } },
	});
});

test("Hermes MCP setup skips a failed named profile and registers the remaining profiles", async () => {
	writeFileSync(join(home, ".hermes", "profiles", "work", "config.yaml"), "[invalid-config]");
	mkdirSync(join(home, ".hermes", "profiles", "research"));
	roster(["default", "work", "research"]);
	const { command, args } = resolveCurrentCliInvocation(["mcp"]);
	const warn = spyOn(log, "warn");
	try {
		expect(await reconcileAllLocalHermesMcp(true)).toBeTrue();
		for (const root of [join(home, ".hermes"), join(home, ".hermes", "profiles", "research")])
			expect(parse(readFileSync(join(root, "config.yaml"), "utf8")).mcp_servers.clawdi).toEqual({
				command,
				args,
			});
		expect(warn.mock.calls).toEqual([["profiles.mcp_failed", { profile_key: "work" }]]);
	} finally {
		warn.mockRestore();
	}
});

test("per-profile readers preserve duplicate imported IDs and projection bytes", async () => {
	const client = api(async (input) => {
		const request = input instanceof Request ? input : new Request(input);
		return response(request.method === "PUT" ? [row(""), row("work")] : []);
	});
	const module = createProfileSync(new HermesAdapter(), client, "env").sessions;
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
	const warn = spyOn(log, "warn");
	let discovery: Awaited<ReturnType<typeof discoverAgentProfiles>>;
	try {
		discovery = await discoverAgentProfiles(new HermesAdapter());
		expect(warn.mock.calls).toEqual([
			[
				"profiles.discovery_incomplete",
				{ agent_type: "hermes", reason: "upstream_discovery_failed" },
			],
		]);
	} finally {
		warn.mockRestore();
	}
	expect(discovery.complete).toBeFalse();
	expect(discovery.profiles.map((profile) => profile.profileKey)).toEqual([""]);
	const module = createProfileSync(new HermesAdapter(), client, "env").sessions;
	if (!module) throw new Error("Expected session module");
	const result = await module.collect({ kind: "complete" });
	expect(result.coverage).toBe("complete");
	expect(result.sessions.length).toBeGreaterThan(0);
	for (const session of result.sessions) expect(session).not.toHaveProperty("profileKey");
	expect(await module.resolve("s-modern")).not.toHaveProperty("profileKey");
	expect(inventories).toEqual([
		{ complete: false, profiles: [{ upstream_key: "default", is_default: true }] },
	]);
});

test("old backend capability fallback uploads only default and omits profile metadata", async () => {
	const client = api(async () => response({ detail: "Not Found" }, 404));
	const module = createProfileSync(new HermesAdapter(), client, "env").sessions;
	if (!module) throw new Error("Expected session module");
	const result = await module.collect({ kind: "complete" });
	expect(result.sessions.length).toBeGreaterThan(0);
	expect(result.sessions.every((session) => session.profileKey === undefined)).toBeTrue();
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
	const module = createProfileSync(new HermesAdapter(), client, "env").sessions;
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
		await createProfileSync(new HermesAdapter(), client, "env").refresh();
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
	const { command, args } = resolveCurrentCliInvocation(["mcp"]);
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
	).toEqual({ command, args });
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

test.each([".local", ".openclaw"])(
	"OpenClaw discovers the absolute %s installation and falls back to legacy sessions when absent",
	async (installation) => {
		const stateRoot = join(home, ".openclaw");
		const legacySessions = join(stateRoot, "agents", "main", "sessions");
		mkdirSync(legacySessions, { recursive: true });
		writeFileSync(
			join(legacySessions, "sessions.json"),
			JSON.stringify({ fixture: { sessionId: "legacy", updatedAt: 1776247200000 } }),
		);
		writeFileSync(
			join(legacySessions, "legacy.jsonl"),
			JSON.stringify({
				type: "message",
				timestamp: 1776247200000,
				message: { role: "user", content: "legacy fixture" },
			}),
		);
		const command = join(home, installation, "bin", "openclaw");
		executable(
			command,
			`test "$*" = "agents list --json" || exit 1
printf '[{"id":"main","workspace":"%s/workspace"},{"id":"sales","workspace":"%s/workspace-sales"}]' "$HOME" "$HOME"`,
		);
		// A PATH command must never substitute for a missing runtime-user installation.
		executable(
			join(home, "bin", "openclaw"),
			`printf '[{"id":"main","workspace":"%s/wrong-workspace"}]' "$HOME"`,
		);
		process.env.PATH = `${join(home, "bin")}:/usr/local/bin:/usr/bin:/bin`;
		process.env.OPENCLAW_STATE_DIR = stateRoot;
		delete process.env.OPENCLAW_AGENT_ID;
		process.env.CLAWDI_RUNTIME_USER = "fixture-agent";
		process.env.CLAWDI_RUNTIME_UID = String(process.getuid?.());
		process.env.CLAWDI_RUNTIME_GID = String(process.getgid?.());
		const adapter = new OpenClawAdapter();
		const discovery = await discoverAgentProfiles(adapter);
		expect(discovery.complete).toBeTrue();
		expect(discovery.profiles.map((profile) => profile.profileKey)).toEqual(["", "sales"]);
		rmSync(command);
		const incomplete = await discoverAgentProfiles(adapter);
		expect(incomplete.complete).toBeFalse();
		expect(incomplete.profiles.map((profile) => profile.profileKey)).toEqual([""]);
		const sessions = await incomplete.profiles[0]?.reader?.collect({ kind: "complete" });
		expect(sessions?.sessions.map((session) => session.localSessionId)).toEqual(["legacy"]);
	},
);

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
	const sync = createProfileSync(new OpenClawAdapter(), client, "env");
	const result = await sync.sessions?.collect({ kind: "complete" });
	await sync.sessions?.collect({ kind: "complete" });
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

test("HERMES_HOME keeps the default identity and content receipts when it selects a named profile", async () => {
	const selectedHome = join(home, ".hermes", "profiles", "work");
	process.env.HERMES_HOME = selectedHome;
	const adapter = new HermesAdapter();
	const before = await adapter.sessions.collect({ kind: "complete" });
	const old = before.sessions.find((session) => session.localSessionId === "s-modern");
	if (!old) throw new Error("Expected fixture session");
	const client = api(async () => response([row(""), row("default")]));
	const plan = planSessionUpload(old, "events-v1");
	const fence = sessionFence(client, {
		environmentId: "env",
		adapter: "hermes",
		sourceSessionKey: old.localSessionId,
	});
	persistFencedSessionEntry(fence, { protocol: plan.protocol, local_hash: plan.localHash });
	const sync = createProfileSync(adapter, client, "env");
	const result = await sync.sessions?.collect({ kind: "complete" });
	const current = result?.sessions.find(
		(session) => session.profileKey === "" && session.localSessionId === old.localSessionId,
	);
	if (!current) throw new Error("Expected unchanged default session");
	expect((await prepareSessionUpload(current, "events-v1")).localHash).toBe(plan.localHash);
	expect(
		sessionFenceKey(
			sessionFence(client, {
				environmentId: "env",
				adapter: "hermes",
				sourceSessionKey: profileSessionKey(current.profileKey, current.localSessionId),
				profileKey: current.profileKey,
			}),
		),
	).toBe(sessionFenceKey(fence));
	expect(result?.sessions.some((session) => session.profileKey === "default")).toBeTrue();
	expect(sync.sessions?.watchPaths()).toContain(join(selectedHome, "state.db"));
	const queued: unknown[] = [];
	const uploaded = await enqueueChangedSessionsAfterStability({
		abort: new AbortController().signal,
		sessions: [current],
		queue: {
			enqueueWhenAvailable: async (item) => {
				queued.push(item);
				return 1;
			},
		},
		lastPushedHash: new Map([[current.localSessionId, plan.localHash]]),
		inFlightHash: new Map(),
		protocol: "events-v1",
		fenceFor: () => fence,
		onBlocked: () => {},
	});
	expect(uploaded.enqueued).toBe(0);
	expect(queued).toEqual([]);
});

test("inventory refreshes only at start, reconcile and directory changes; MCP runs once per discovered key", async () => {
	const commandLog = join(home, "mcp-commands");
	executable(
		join(home, "bin", "hermes"),
		`printf '%s\n' "$*" >> '${commandLog}'
exec '${process.execPath}' '${configMock}' "$@"`,
	);
	let gets = 0;
	const client = api(async (input) => {
		const request = input instanceof Request ? input : new Request(input);
		if (request.method === "GET") gets++;
		return response([]);
	});
	const sync = createProfileSync(new HermesAdapter(), client, "env");
	await sync.refresh();
	await sync.sessions?.contentProtocol();
	await sync.sessions?.collect({ kind: "complete" });
	utimesSync(join(home, ".hermes", "state.db"), new Date(), new Date());
	utimesSync(join(home, ".hermes", "profiles", "work", "state.db"), new Date(), new Date());
	await sync.sessions?.collect({ kind: "complete" });
	expect(gets).toBe(1);
	await sync.refresh();
	expect(gets).toBe(2);
	expect(readFileSync(commandLog, "utf8").trim().split("\n")).toHaveLength(2);
	const newHome = join(home, ".hermes", "profiles", "research");
	mkdirSync(newHome);
	cpSync(join(fixture, ".hermes", "state.db"), join(newHome, "state.db"));
	roster(["default", "work", "research"]);
	const result = await sync.sessions?.collect({ kind: "complete" });
	expect(gets).toBe(3);
	expect(result?.sessions.some((session) => session.profileKey === "research")).toBeTrue();
	expect(readFileSync(commandLog, "utf8").trim().split("\n")).toHaveLength(3);
});

test("Hermes metadata edits and tombstones refresh the inventory without repeating MCP reconcile", async () => {
	const reconcile = spyOn(await import("../src/commands/hermes-mcp"), "reconcileLocalHermesMcp");
	let gets = 0;
	const inventories: unknown[] = [];
	const client = api(async (input) => {
		const request = input instanceof Request ? input : new Request(input);
		if (request.method === "GET") gets++;
		if (request.method === "PUT") inventories.push(await request.json());
		return response([]);
	});
	try {
		const sync = createProfileSync(new HermesAdapter(), client, "env");
		await sync.refresh();
		const metadata = join(home, ".hermes", "profiles", "work", "profile.yaml");
		writeFileSync(metadata, '{"previous_names":["older","old"]}');
		await sync.sessions?.collect({ kind: "complete" });
		expect(gets).toBe(2);
		expect(reconcile).toHaveBeenCalledTimes(2);
		roster(["default"]);
		writeFileSync(join(home, ".hermes", "profiles", ".deleted", "work"), "deleted\n");
		const result = await sync.sessions?.collect({ kind: "complete" });
		expect(gets).toBe(3);
		expect(reconcile).toHaveBeenCalledTimes(2);
		expect(result?.sessions.length).toBeGreaterThan(0);
		expect(result?.sessions.every((session) => session.profileKey === "")).toBeTrue();
		expect(inventories.at(-1)).toEqual({
			complete: true,
			profiles: [{ upstream_key: "default", is_default: true }],
		});
	} finally {
		reconcile.mockRestore();
	}
});

test("async Hermes discovery leaves the event loop available", async () => {
	executable(
		join(home, ".hermes", "hermes-agent", "venv", "bin", "python"),
		`sleep 0.05
exec python3 "$@"`,
	);
	let yielded = false;
	const timer = setTimeout(() => {
		yielded = true;
	}, 0);
	try {
		await discoverHermesProfiles();
		expect(yielded).toBeTrue();
	} finally {
		clearTimeout(timer);
	}
});

test("a failed named profile reports incomplete inventory and leaves the default scanning", async () => {
	writeFileSync(join(home, ".hermes", "profiles", "work", "config.yaml"), "[invalid-config]");
	const inventories: unknown[] = [];
	const client = api(async (input) => {
		const request = input instanceof Request ? input : new Request(input);
		if (request.method === "PUT") inventories.push(await request.json());
		return response([row(""), row("work")]);
	});
	const warn = spyOn(log, "warn");
	try {
		const result = await createProfileSync(new HermesAdapter(), client, "env").sessions?.collect({
			kind: "complete",
		});
		expect(result?.sessions.length).toBeGreaterThan(0);
		expect(result?.sessions.every((session) => session.profileKey === "")).toBeTrue();
		expect(inventories.at(-1)).toEqual({
			complete: false,
			profiles: [{ upstream_key: "default", is_default: true }],
		});
		expect(warn.mock.calls).toEqual([["profiles.sync_failed", { profile_key: "work" }]]);
	} finally {
		warn.mockRestore();
	}
});

test("named reader failures never report removal across repeated scans and refreshes", async () => {
	writeFileSync(join(home, ".hermes", "profiles", "work", "state.db"), "invalid SQLite database");
	const inventories: unknown[] = [];
	const client = api(async (input) => {
		const request = input instanceof Request ? input : new Request(input);
		if (request.method === "PUT") inventories.push(await request.json());
		return response([row(""), row("work")]);
	});
	const warn = spyOn(log, "warn");
	try {
		const sync = createProfileSync(new HermesAdapter(), client, "env");
		const result = await sync.sessions?.collect({ kind: "complete" });
		expect(result?.coverage).toBe("partial");
		expect(result?.sessions.length).toBeGreaterThan(0);
		expect(result?.sessions.every((session) => session.profileKey === "")).toBeTrue();
		await sync.sessions?.collect({ kind: "complete" });
		expect(inventories).toHaveLength(2);
		expect(warn.mock.calls).toEqual([["profiles.sync_failed", { profile_key: "work" }]]);
		await sync.refresh();
		await sync.sessions?.collect({ kind: "complete" });
		const present = {
			complete: true,
			profiles: [
				{ upstream_key: "default", is_default: true },
				{ upstream_key: "work", is_default: false },
			],
		};
		const unreadable = {
			complete: false,
			profiles: [{ upstream_key: "default", is_default: true }],
		};
		expect(inventories).toEqual([present, unreadable, present, unreadable]);
	} finally {
		warn.mockRestore();
	}
});

for (const status of [404, 503]) {
	test(`profile endpoint ${status} retains the default's complete legacy coverage`, async () => {
		const client = api(async () => response({ detail: "unavailable" }, status));
		const result = await createProfileSync(new HermesAdapter(), client, "env").sessions?.collect({
			kind: "complete",
		});
		expect(result?.coverage).toBe("complete");
		expect(result?.sessions.length).toBeGreaterThan(0);
		expect(result?.sessions.every((session) => session.profileKey === undefined)).toBeTrue();
	});
}

test("OpenClaw profiles share one official all-agents inventory without injecting a state directory", async () => {
	delete process.env.OPENCLAW_STATE_DIR;
	const calls = join(home, "session-inventory-calls");
	executable(
		join(home, "bin", "openclaw"),
		`
if [ "$*" = "agents list --json" ]; then
    printf '[{"id":"main","workspace":"%s/main"},{"id":"work","workspace":"%s/work"}]' "$HOME" "$HOME"
elif [ "$*" = "sessions --json --all-agents --limit all" ]; then
    [ -z "\${OPENCLAW_STATE_DIR+x}" ] || exit 65
    printf '.\n' >> '${calls}'
    printf '{"sessions":[],"stores":[]}'
else exit 1; fi`,
	);
	const client = api(async () => response([row(""), row("work")]));
	await createProfileSync(new OpenClawAdapter(), client, "env").sessions?.collect({
		kind: "complete",
	});
	expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
});

test.each([
	{ discovery: "failed", agentId: undefined },
	{ discovery: "incomplete", agentId: undefined },
	{ discovery: "failed", agentId: "work" },
])(
	"OpenClaw discovery fallback %j preserves the legacy Agent scope and identity",
	async ({ discovery, agentId }) => {
		if (agentId === undefined) delete process.env.OPENCLAW_AGENT_ID;
		else process.env.OPENCLAW_AGENT_ID = agentId;
		delete process.env.OPENCLAW_STATE_DIR;
		const state = join(home, ".openclaw");
		for (const name of ["main", "work"]) {
			const dir = join(state, "agents", name, "sessions");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "sessions.json"),
				JSON.stringify({ [name]: { sessionId: name, updatedAt: 1776247200000 } }),
			);
			writeFileSync(
				join(dir, `${name}.jsonl`),
				JSON.stringify({
					type: "message",
					timestamp: 1776247200000,
					message: { role: "user", content: "fixture input" },
				}),
			);
		}
		executable(
			join(home, "bin", "openclaw"),
			discovery === "failed"
				? "exit 1"
				: `if [ "$*" = "agents list --json" ]; then
    printf '[{"id":"work","workspace":"%s/work"}]' "$HOME"
else exit 1; fi`,
		);
		const inventories: unknown[] = [];
		const client = api(async (input) => {
			const request = input instanceof Request ? input : new Request(input);
			if (request.method === "PUT") inventories.push(await request.json());
			return response([row(""), row("work")]);
		});
		const result = await createProfileSync(new OpenClawAdapter(), client, "env").sessions?.collect({
			kind: "complete",
		});
		expect(result?.coverage).toBe("complete");
		expect(
			result?.sessions.map((session) => [session.profileKey, session.localSessionId]).sort(),
		).toEqual(
			agentId
				? [[undefined, agentId]]
				: [
						[undefined, "main"],
						[undefined, "work"],
					],
		);
		for (const session of result?.sessions ?? []) expect(session).not.toHaveProperty("profileKey");
		expect(inventories).toEqual([
			{ complete: false, profiles: [{ upstream_key: agentId ?? "main", is_default: true }] },
		]);
	},
);

test("a conflicting upstream root skips only the named default profile", async () => {
	const customHome = join(home, "custom-home");
	mkdirSync(customHome);
	cpSync(join(fixture, ".hermes", "state.db"), join(customHome, "state.db"));
	process.env.HERMES_HOME = customHome;
	const warn = spyOn(log, "warn");
	try {
		const profiles = await discoverHermesProfiles();
		expect(profiles.find((profile) => profile.isDefault)?.home).toBe(customHome);
		expect(profiles.some((profile) => profile.profileKey === "default")).toBeFalse();
		expect(profiles.some((profile) => profile.profileKey === "work")).toBeTrue();
		expect(warn.mock.calls).toEqual([["profiles.default_conflict", { profile_key: "default" }]]);
	} finally {
		warn.mockRestore();
	}
});

test("a conflicting upstream default never redirects MCP away from HERMES_HOME", async () => {
	const selectedHome = join(home, ".hermes", "profiles", "detached");
	mkdirSync(selectedHome);
	cpSync(join(fixture, ".hermes", "state.db"), join(selectedHome, "state.db"));
	process.env.HERMES_HOME = selectedHome;
	const { command, args } = resolveCurrentCliInvocation(["mcp"]);
	const client = api(async () => response([row(""), row("work")]));
	const warn = spyOn(log, "warn");
	try {
		const sync = createProfileSync(new HermesAdapter(), client, "env");
		await sync.refresh();
		expect(sync.watchPaths()).toEqual([join(home, ".hermes", "profiles")]);
		expect(
			parse(readFileSync(join(selectedHome, "config.yaml"), "utf8")).mcp_servers.clawdi,
		).toEqual({
			command,
			args,
		});
		expect(existsSync(join(home, ".hermes", "config.yaml"))).toBeFalse();
		expect(await reconcileAllLocalHermesMcp(true)).toBeFalse();
		expect(existsSync(join(home, ".hermes", "config.yaml"))).toBeFalse();
		expect(warn.mock.calls).toEqual([
			["profiles.default_conflict", { profile_key: "default" }],
			["profiles.default_conflict", { profile_key: "default" }],
		]);
	} finally {
		warn.mockRestore();
	}
});

test("malformed named rename metadata does not discard other profiles", async () => {
	writeFileSync(join(home, ".hermes", "profiles", "work", "profile.yaml"), '{"previous_names":42}');
	const client = api(async () => response([row(""), row("work", "removed")]));
	const warn = spyOn(log, "warn");
	try {
		const result = await createProfileSync(new HermesAdapter(), client, "env").sessions?.collect({
			kind: "complete",
		});
		expect(result?.coverage).toBe("complete");
		expect(result?.sessions.length).toBeGreaterThan(0);
		expect(result?.sessions.every((session) => session.profileKey === "")).toBeTrue();
		expect(warn.mock.calls).toEqual([["profiles.read_failed", { profile_key: "work" }]]);
	} finally {
		warn.mockRestore();
	}
});
