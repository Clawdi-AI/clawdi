import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../src/commands/run";
import { setProjectFolderLink } from "../../src/lib/project-folders";
import { jsonResponse, mockFetch } from "./helpers";

interface SpawnCall {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}

let tmpRoot: string;
let fakeClawdiHome: string;
let projectRoot: string;
let projectChild: string;
let origHome: string | undefined;
let origClawdiHome: string | undefined;
let origAuthToken: string | undefined;
let origApiUrl: string | undefined;
let origCwd: string;

beforeEach(() => {
	origHome = process.env.HOME;
	origClawdiHome = process.env.CLAWDI_HOME;
	origAuthToken = process.env.CLAWDI_AUTH_TOKEN;
	origApiUrl = process.env.CLAWDI_API_URL;
	origCwd = process.cwd();

	tmpRoot = join(tmpdir(), `clawdi-run-${Date.now()}-${Math.random().toString(36)}`);
	fakeClawdiHome = join(tmpRoot, "state");
	projectRoot = join(tmpRoot, "project");
	projectChild = join(projectRoot, "src");
	mkdirSync(fakeClawdiHome, { recursive: true });
	mkdirSync(projectChild, { recursive: true });
	writeFileSync(join(fakeClawdiHome, "auth.json"), JSON.stringify({ apiKey: "test-key" }));

	process.env.HOME = join(tmpRoot, "home");
	process.env.CLAWDI_HOME = fakeClawdiHome;
	delete process.env.CLAWDI_AUTH_TOKEN;
	process.env.CLAWDI_API_URL = "http://api.test";
	process.chdir(projectChild);
});

afterEach(() => {
	process.chdir(origCwd);
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origClawdiHome) process.env.CLAWDI_HOME = origClawdiHome;
	else delete process.env.CLAWDI_HOME;
	if (origAuthToken) process.env.CLAWDI_AUTH_TOKEN = origAuthToken;
	else delete process.env.CLAWDI_AUTH_TOKEN;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	rmSync(tmpRoot, { recursive: true, force: true });
	process.exitCode = undefined;
});

function recordSpawn(): {
	calls: SpawnCall[];
	spawnImpl: NonNullable<Parameters<typeof run>[2]>;
} {
	const calls: SpawnCall[] = [];
	const spawnImpl = ((command: string, args: string[], options: SpawnOptions) => {
		calls.push({
			command,
			args,
			env: (options.env ?? {}) as NodeJS.ProcessEnv,
		});
		return new EventEmitter() as ChildProcess;
	}) as NonNullable<Parameters<typeof run>[2]>;
	return { calls, spawnImpl };
}

function linkCurrentProjectFolder(): void {
	setProjectFolderLink(projectRoot, {
		project_id: "project-linked",
		project_label: "engineering",
		project_name: "Engineering",
		project_slug: "engineering",
		owner_handle: null,
		owner_display: null,
	});
}

describe("run command project folder selection", () => {
	it("uses the linked Project folder when resolving vault env", async () => {
		linkCurrentProjectFolder();
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () => jsonResponse({ DEPLOY_TOKEN: "vault-secret" }),
			},
		]);
		const origLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			await run(["npm", "run", "deploy"], { allVaultEnv: true }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].method).toBe("POST");
		expect(captured[0].path).toContain("/api/vault/resolve");
		expect(captured[0].path).toContain("project_id=project-linked");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ command: "npm", args: ["run", "deploy"] });
		expect(calls[0].env.DEPLOY_TOKEN).toBe("vault-secret");

		const out = lines.join("\n");
		expect(out).toContain("Using Project engineering");
		expect(out).toContain("Injected 1 vault secrets");
		expect(out).not.toContain("vault-secret");
	});

	it("skips linked-folder lookup when --no-project-folder is passed", async () => {
		linkCurrentProjectFolder();
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () => jsonResponse({ API_TOKEN: "from-default-project" }),
			},
		]);
		const origLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			await run(["node", "server.js"], { projectFolder: false, allVaultEnv: true }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].path).toContain("/api/vault/resolve");
		expect(captured[0].path).not.toContain("project_id=");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ command: "node", args: ["server.js"] });
		expect(calls[0].env.API_TOKEN).toBe("from-default-project");
		expect(lines.join("\n")).not.toContain("Using Project");
	});

	it("runs without vault injection when resolve returns an invalid body", async () => {
		const { calls, spawnImpl } = recordSpawn();
		const { restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () =>
					new Response("null", {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			},
		]);
		const origLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			await run(["node", "server.js"], { projectFolder: false, allVaultEnv: true }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ command: "node", args: ["server.js"] });
		expect(lines.join("\n")).toContain("Could not fetch vault secrets");
		expect(lines.join("\n")).not.toContain("Injected");
	});

	it("resolves clawdi references from env files without all-vault injection", async () => {
		const envFile = join(tmpRoot, ".env");
		writeFileSync(
			envFile,
			["OPENAI_API_KEY=clawdi://prod/openai/api_key", "LITERAL_VALUE=kept"].join("\n"),
		);
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () =>
					jsonResponse({
						reference: "clawdi://prod/openai/api_key",
						value: "sk-test",
						source_project_id: "project-default",
						source_alias: "project-default",
						vault_slug: "prod",
						section: "openai",
						item_name: "api_key",
					}),
			},
		]);
		const origLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};

		try {
			await run(["node", "server.js"], { envFile: [envFile], projectFolder: false }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].path).toContain("vault_slug=prod");
		expect(captured[0].path).toContain("section=openai");
		expect(captured[0].path).toContain("field=api_key");
		expect(calls).toHaveLength(1);
		expect(calls[0].env.OPENAI_API_KEY).toBe("sk-test");
		expect(calls[0].env.LITERAL_VALUE).toBe("kept");
		expect(lines.join("\n")).toContain("Resolved 1 clawdi reference");
		expect(lines.join("\n")).not.toContain("sk-test");
	});

	it("lets explicit env-file references override legacy all-vault values", async () => {
		const envFile = join(tmpRoot, ".env");
		writeFileSync(envFile, "OPENAI_API_KEY=clawdi://prod/openai/api_key\n");
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve?vault_slug",
				response: () =>
					jsonResponse({
						reference: "clawdi://prod/openai/api_key",
						value: "sk-explicit",
						source_project_id: "project-default",
						source_alias: "project-default",
						vault_slug: "prod",
						section: "openai",
						item_name: "api_key",
					}),
			},
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () => jsonResponse({ OPENAI_API_KEY: "sk-broad" }),
			},
		]);
		const origLog = console.log;
		console.log = () => {};

		try {
			await run(
				["node", "server.js"],
				{ envFile: [envFile], projectFolder: false, allVaultEnv: true },
				spawnImpl,
			);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(2);
		expect(calls).toHaveLength(1);
		expect(calls[0].env.OPENAI_API_KEY).toBe("sk-explicit");
	});

	it("uses linked Project folder when resolving env-file references", async () => {
		linkCurrentProjectFolder();
		const envFile = join(tmpRoot, ".env");
		writeFileSync(envFile, "OPENAI_API_KEY=clawdi://prod/openai/api_key\n");
		const { calls, spawnImpl } = recordSpawn();
		const { captured, restore } = mockFetch([
			{
				method: "POST",
				path: "/api/vault/resolve",
				response: () =>
					jsonResponse({
						reference: "clawdi://prod/openai/api_key",
						value: "sk-linked",
						source_project_id: "project-linked",
						source_alias: "engineering",
					}),
			},
		]);
		const origLog = console.log;
		console.log = () => {};

		try {
			await run(["node", "server.js"], { envFile: [envFile] }, spawnImpl);
		} finally {
			console.log = origLog;
			restore();
		}

		expect(captured).toHaveLength(1);
		expect(captured[0].path).toContain("project_id=project-linked");
		expect(calls[0].env.OPENAI_API_KEY).toBe("sk-linked");
	});
});
