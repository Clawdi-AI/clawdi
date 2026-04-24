import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let origHome: string | undefined;
let origApiUrl: string | undefined;
let fakeHome: string;

beforeEach(() => {
	origHome = process.env.HOME;
	origApiUrl = process.env.CLAWDI_API_URL;
	fakeHome = join(tmpdir(), `clawdi-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(fakeHome, { recursive: true });
	process.env.HOME = fakeHome;
	delete process.env.CLAWDI_API_URL;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origApiUrl) process.env.CLAWDI_API_URL = origApiUrl;
	rmSync(fakeHome, { recursive: true, force: true });
});

describe("getConfig env override", () => {
	it("defaults to http://localhost:8000 when nothing set", async () => {
		const { getConfig } = await import("../src/lib/config");
		expect(getConfig().apiUrl).toBe("http://localhost:8000");
	});

	it("CLAWDI_API_URL env overrides stored config", async () => {
		const { getConfig, setConfig } = await import("../src/lib/config");
		setConfig({ apiUrl: "http://from-disk" });
		process.env.CLAWDI_API_URL = "http://from-env";
		expect(getConfig().apiUrl).toBe("http://from-env");
	});

	it("stored config used when env not set", async () => {
		const { getConfig, setConfig } = await import("../src/lib/config");
		setConfig({ apiUrl: "http://from-disk" });
		expect(getConfig().apiUrl).toBe("http://from-disk");
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

	it("writes auth.json with mode 0o600", async () => {
		const { setAuth } = await import("../src/lib/config");
		setAuth({ apiKey: "secret" });
		const authPath = join(fakeHome, ".clawdi", "auth.json");
		const stat = statSync(authPath);
		const mode = stat.mode & 0o777;
		expect(mode).toBe(0o600);
	});
});

describe("config keys", () => {
	it("setConfigKey / unsetConfigKey round-trip", async () => {
		const { getStoredConfig, setConfigKey, unsetConfigKey } = await import("../src/lib/config");
		setConfigKey("apiUrl", "http://x");
		expect(getStoredConfig().apiUrl).toBe("http://x");
		unsetConfigKey("apiUrl");
		expect(getStoredConfig().apiUrl).toBeUndefined();
	});
});
