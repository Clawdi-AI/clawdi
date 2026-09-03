import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let origHome: string | undefined;
let origApiUrl: string | undefined;
let origDeployApiUrl: string | undefined;
let fakeHome: string;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	origDeployApiUrl = process.env.CLAWDI_DEPLOY_API_URL;
	fakeHome = join(tmpdir(), `clawdi-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(fakeHome, { recursive: true });
	process.env.HOME = fakeHome;
	delete process.env.CLAWDI_API_URL;
	delete process.env.CLAWDI_DEPLOY_API_URL;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	else delete process.env.CLAWDI_API_URL;
	if (origDeployApiUrl) process.env.CLAWDI_DEPLOY_API_URL = origDeployApiUrl;
	else delete process.env.CLAWDI_DEPLOY_API_URL;
	rmSync(fakeHome, { recursive: true, force: true });
});

describe("getConfig env override", () => {
	it("defaults to http://localhost:8000 when nothing set", async () => {
		const { getConfig } = await import("../src/lib/config");
		expect(getConfig().apiUrl).toBe("http://localhost:8000");
		expect(getConfig().deployApiUrl).toBe("http://localhost:50021");
	});

	it("CLAWDI_DEPLOY_API_URL env overrides stored Hosted config", async () => {
		const { getConfig, setConfigKey } = await import("../src/lib/config");
		setConfigKey("deployApiUrl", "https://deploy-from-disk.test");
		process.env.CLAWDI_DEPLOY_API_URL = "http://deploy-from-env";
		expect(getConfig().deployApiUrl).toBe("http://deploy-from-env");
	});

	it("preserves the stored auto-update preference", async () => {
		const { getConfig, setConfigKey } = await import("../src/lib/config");
		setConfigKey("autoUpdate", "false");
		expect(getConfig().autoUpdate).toBe(false);
	});

	it("normalizes released string booleans at the config read boundary", async () => {
		const { getConfig, getStoredConfig, setConfigKey } = await import("../src/lib/config");
		const path = join(fakeHome, ".clawdi", "config.json");
		mkdirSync(join(fakeHome, ".clawdi"), { recursive: true });
		const legacy = '{"autoUpdate":"false","futureSetting":{"enabled":true}}\n';
		writeFileSync(path, legacy);

		expect(getConfig().autoUpdate).toBe(false);
		expect(getStoredConfig()).toEqual({
			autoUpdate: false,
			futureSetting: { enabled: true },
		});
		expect(readFileSync(path, "utf8")).toBe(legacy);

		setConfigKey("apiUrl", "https://cloud.example.test");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			autoUpdate: false,
			futureSetting: { enabled: true },
			apiUrl: "https://cloud.example.test",
		});

		writeFileSync(path, '{"autoUpdate":"true"}\n');
		expect(getConfig().autoUpdate).toBe(true);
	});

	it("does not coerce invalid config shapes into canonical values", async () => {
		const { getStoredConfig } = await import("../src/lib/config");
		const path = join(fakeHome, ".clawdi", "config.json");
		mkdirSync(join(fakeHome, ".clawdi"), { recursive: true });
		for (const autoUpdate of ["FALSE", 1, null, [], {}]) {
			writeFileSync(path, JSON.stringify({ autoUpdate, futureSetting: "preserved" }));
			expect(getStoredConfig()).toEqual({ futureSetting: "preserved" });
		}
		for (const invalid of [null, [], "false", 1]) {
			writeFileSync(path, JSON.stringify(invalid));
			expect(getStoredConfig()).toEqual({});
		}
	});

	it("CLAWDI_API_URL env overrides stored config", async () => {
		const { getConfig, setConfig } = await import("../src/lib/config");
		setConfig({ apiUrl: "https://from-disk.test" });
		process.env.CLAWDI_API_URL = "http://from-env";
		expect(getConfig().apiUrl).toBe("http://from-env");
	});

	it("stored config used when env not set", async () => {
		const { getConfig, setConfig } = await import("../src/lib/config");
		setConfig({ apiUrl: "https://from-disk.test" });
		expect(getConfig().apiUrl).toBe("https://from-disk.test");
	});
});

describe("auth persistence", () => {
	it("round-trips auth across set / get / clear", async () => {
		const { clearAuth, getAuth, isLoggedIn, setAuth } = await import("../src/lib/config");
		expect(isLoggedIn()).toBe(false);
		setAuth({ apiKey: "k", userId: "u", email: "e" });
		expect(isLoggedIn()).toBe(true);
		expect(getAuth()).toEqual({ apiKey: "k", userId: "u", email: "e" });
		clearAuth();
		expect(isLoggedIn()).toBe(false);
	});

	it("does not claim legacy Agent registrations while clearing credentials", async () => {
		const { clearAuth, setAuth } = await import("../src/lib/config");
		const { listRegisteredAgentTypes } = await import("../src/lib/select-adapter");
		const envDir = join(fakeHome, ".clawdi", "environments");
		const envPath = join(envDir, "codex.json");
		mkdirSync(envDir, { recursive: true });
		writeFileSync(envPath, JSON.stringify({ id: "env-codex", agentType: "codex" }));

		setAuth({ apiKey: "account-a-key", userId: "account-a" });
		expect(listRegisteredAgentTypes()).toEqual(["codex"]);
		clearAuth();
		expect(listRegisteredAgentTypes()).toEqual([]);
		expect(JSON.parse(readFileSync(envPath, "utf8"))).toEqual({
			id: "env-codex",
			agentType: "codex",
		});
	});

	it("writes auth.json with mode 0o600", async () => {
		const { setAuth } = await import("../src/lib/config");
		setAuth({ apiKey: "secret" });
		const authPath = join(fakeHome, ".clawdi", "auth.json");
		const stat = statSync(authPath);
		const mode = stat.mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("keeps malformed credential files as non-mutating read failures", async () => {
		const { getClawdiDir, getPendingAuth, getStoredAuth } = await import("../src/lib/config");
		const clawdiHome = getClawdiDir();
		mkdirSync(clawdiHome, { recursive: true });
		for (const fileName of ["auth.json", "pending-auth.json"]) {
			const path = join(clawdiHome, fileName);
			writeFileSync(path, "{stale credential\n");
			expect(fileName === "auth.json" ? getStoredAuth() : getPendingAuth()).toBeNull();
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, "utf8")).toBe("{stale credential\n");
		}
	});

	it("does not delete a newer credential committed after a stale failed read", async () => {
		const { getClawdiDir, getStoredAuth, readRecoverablePrivateJson, setAuth } = await import(
			"../src/lib/config"
		);
		const { withPrivateDirectoryLock } = await import("../src/lib/private-directory-lock");
		const clawdiHome = getClawdiDir();
		const authPath = join(clawdiHome, "auth.json");
		mkdirSync(clawdiHome, { recursive: true });
		writeFileSync(authPath, "{stale credential\n");

		let newerCommit: Promise<void> | undefined;
		const observed = readRecoverablePrivateJson(authPath, (candidate) => {
			const staleBytes = readFileSync(candidate, "utf8");
			try {
				return JSON.parse(staleBytes);
			} catch (error) {
				newerCommit = withPrivateDirectoryLock(
					join(clawdiHome, "credentials.lock"),
					async (lease) => {
						lease.assertOwned();
						setAuth({ apiKey: "newer-credential", userId: "newer-user" });
					},
				);
				throw error;
			}
		});

		expect(observed).toBeNull();
		if (!newerCommit) throw new Error("new credential commit did not start");
		await newerCommit;
		expect(getStoredAuth()).toEqual({ apiKey: "newer-credential", userId: "newer-user" });
	});
});

describe("config keys", () => {
	it("setConfigKey / unsetConfigKey round-trip", async () => {
		const { getStoredConfig, setConfigKey, unsetConfigKey } = await import("../src/lib/config");
		setConfigKey("apiUrl", "https://cloud.example.test");
		expect(getStoredConfig().apiUrl).toBe("https://cloud.example.test");
		unsetConfigKey("apiUrl");
		expect(getStoredConfig().apiUrl).toBeUndefined();
		setConfigKey("deployApiUrl", "https://deploy.example.test/v2");
		expect(getStoredConfig().deployApiUrl).toBe("https://deploy.example.test");
	});

	it("rejects invalid values before replacing the existing config", async () => {
		const { getStoredConfig, setConfigKey } = await import("../src/lib/config");
		setConfigKey("apiUrl", "https://cloud.example.test");
		setConfigKey("autoUpdate", "false");
		const path = join(fakeHome, ".clawdi", "config.json");
		const before = readFileSync(path, "utf8");

		expect(() => setConfigKey("autoUpdate", "FALSE")).toThrow("must be true or false");
		expect(() => setConfigKey("apiUrl", "cloud.example.test")).toThrow("absolute http");
		expect(() => setConfigKey("deployApiUrl", "ftp://deploy.example.test")).toThrow(
			"must use http:// or https://",
		);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(getStoredConfig()).toEqual({
			apiUrl: "https://cloud.example.test",
			autoUpdate: false,
		});
	});

	it("exits nonzero for invalid config set input without touching the old value", () => {
		const configPath = join(fakeHome, ".clawdi", "config.json");
		mkdirSync(join(fakeHome, ".clawdi"), { recursive: true });
		writeFileSync(configPath, '{"autoUpdate":false}\n');
		const result = Bun.spawnSync(
			["bun", join(import.meta.dir, "../src/index.ts"), "config", "set", "autoUpdate", "yes"],
			{
				env: { ...process.env, HOME: fakeHome, CLAWDI_HOME: join(fakeHome, ".clawdi") },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).not.toBe(0);
		expect(readFileSync(configPath, "utf8")).toBe('{"autoUpdate":false}\n');
	});
});
