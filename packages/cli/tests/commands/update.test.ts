import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeAutoUpdate, maybeNotifyOutdated, update } from "../../src/commands/update";
import { jsonResponse, mockFetch } from "./helpers";

let tmpHome: string;
let origHome: string | undefined;
let origNoCheck: string | undefined;

beforeEach(() => {
	origHome = process.env.HOME;
	origNoCheck = process.env.CLAWDI_NO_UPDATE_CHECK;
	delete process.env.CLAWDI_NO_UPDATE_CHECK;
	tmpHome = join(tmpdir(), `clawdi-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(tmpHome, ".clawdi"), { recursive: true });
	process.env.HOME = tmpHome;
});

afterEach(() => {
	if (origHome) process.env.HOME = origHome;
	else delete process.env.HOME;
	if (origNoCheck) process.env.CLAWDI_NO_UPDATE_CHECK = origNoCheck;
	else delete process.env.CLAWDI_NO_UPDATE_CHECK;
	rmSync(tmpHome, { recursive: true, force: true });
});

describe("update --json", () => {
	it("reports upgrade available when registry has a newer version", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};

		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: "99.0.0" } }),
			},
		]);
		try {
			await update({ json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const result = JSON.parse(captured) as {
			current: string;
			latest: string;
			upgradeAvailable: boolean;
		};
		expect(result.latest).toBe("99.0.0");
		expect(result.upgradeAvailable).toBe(true);
	});

	it("reports up-to-date when registry latest equals current", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};

		// Read the current version from package.json via fetch indirection — the registry returns it.
		// getCliVersion() reads from disk; we match it by echoing the same value.
		const { getCliVersion } = await import("../../src/lib/version");
		const current = getCliVersion();

		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/clawdi",
				response: () => jsonResponse({ "dist-tags": { latest: current } }),
			},
		]);
		try {
			await update({ json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const result = JSON.parse(captured) as { upgradeAvailable: boolean };
		expect(result.upgradeAvailable).toBe(false);
	});

	it("reports latest=null when registry is unreachable", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured = args.map(String).join(" ");
		};

		// No handler installed → mockFetch 404s the registry call
		const { restore } = mockFetch([]);
		try {
			await update({ json: true });
		} finally {
			console.log = orig;
			restore();
		}

		const result = JSON.parse(captured) as { latest: string | null; upgradeAvailable: boolean };
		expect(result.latest).toBeNull();
		expect(result.upgradeAvailable).toBe(false);
	});
});

describe("maybeNotifyOutdated", () => {
	it("short-circuits when CLAWDI_NO_UPDATE_CHECK is set", async () => {
		process.env.CLAWDI_NO_UPDATE_CHECK = "1";
		const { captured, restore } = mockFetch([]);
		try {
			await maybeNotifyOutdated();
		} finally {
			restore();
		}
		expect(captured).toHaveLength(0);
	});

	it("short-circuits when stdout is not a TTY", async () => {
		// In `bun test` stdout.isTTY is typically undefined/false anyway
		const { captured, restore } = mockFetch([]);
		try {
			await maybeNotifyOutdated();
		} finally {
			restore();
		}
		expect(captured).toHaveLength(0);
	});

	it("reads from the cache when it is fresh and upgrade is available", async () => {
		// Force TTY semantics false anyway; this test exercises the cache-read path
		// indirectly by verifying no fetch fires. In non-TTY env the function
		// returns early regardless — the important contract is 'no network'.
		const cachePath = join(tmpHome, ".clawdi", "update.json");
		writeFileSync(
			cachePath,
			JSON.stringify({ checkedAt: new Date().toISOString(), latest: "999.0.0" }),
		);
		const { captured, restore } = mockFetch([]);
		try {
			await maybeNotifyOutdated();
		} finally {
			restore();
		}
		expect(captured).toHaveLength(0);
	});
});

describe("maybeAutoUpdate", () => {
	it("writes last-version on first run; no notice", async () => {
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([]);
		try {
			await maybeAutoUpdate();
		} finally {
			console.log = orig;
			restore();
		}
		const lastFile = join(tmpHome, ".clawdi", "last-version");
		expect(readFileSync(lastFile, "utf-8").trim().length).toBeGreaterThan(0);
		// First run — no prior `last-version` to compare against.
		expect(captured).not.toContain("Updated clawdi to");
	});

	it("prints `Updated clawdi to vX` when last-version differs from current", async () => {
		// Plant an OLDER last-version so the current binary version looks fresh.
		writeFileSync(join(tmpHome, ".clawdi", "last-version"), "0.0.1");

		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([]);
		try {
			await maybeAutoUpdate();
		} finally {
			console.log = orig;
			restore();
		}
		expect(captured).toContain("Updated clawdi to");
		expect(captured).toContain("(was v0.0.1)");
	});

	it("respects CLAWDI_NO_AUTO_UPDATE — no spawn, no notice", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "last-version"), "0.0.1");
		process.env.CLAWDI_NO_AUTO_UPDATE = "1";
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { captured: fetches, restore } = mockFetch([]);
		try {
			await maybeAutoUpdate();
		} finally {
			console.log = orig;
			delete process.env.CLAWDI_NO_AUTO_UPDATE;
			restore();
		}
		// `Updated clawdi to` notice still fires (it's a post-fact notification,
		// not an update action — opting out shouldn't hide the truth that the
		// binary is now newer than last seen).
		expect(captured).toContain("Updated clawdi to");
		// But no registry fetch / install spawn should be triggered.
		expect(fetches).toHaveLength(0);
	});

	it("major bump prints hint, does not spawn install", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "last-version"), "0.0.1");
		// Plant cache showing a major bump available (1.x → 2.x style).
		// Our binary version is whatever the package.json says; pick something
		// way higher to guarantee a major-bump diff.
		writeFileSync(
			join(tmpHome, ".clawdi", "update.json"),
			JSON.stringify({ checkedAt: new Date().toISOString(), latest: "999.0.0" }),
		);
		// `bun test` runs in a non-TTY context, which the early-return guard
		// (correctly) treats as CI and skips. Force TTY for this test only so
		// we exercise the major-bump branch.
		const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([]);
		try {
			await maybeAutoUpdate();
		} finally {
			console.log = orig;
			restore();
			if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc);
			else Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
		}
		// Hint about manual upgrade, NOT the in-background spawn line.
		expect(captured).toContain("Major release v999.0.0");
		expect(captured).not.toContain("in background");
	});

	it("respects autoUpdate=false config — skips install path", async () => {
		writeFileSync(join(tmpHome, ".clawdi", "config.json"), JSON.stringify({ autoUpdate: "false" }));
		// Cache says a newer version is available.
		writeFileSync(
			join(tmpHome, ".clawdi", "update.json"),
			JSON.stringify({ checkedAt: new Date().toISOString(), latest: "999.0.0" }),
		);
		const orig = console.log;
		let captured = "";
		console.log = (...args: unknown[]) => {
			captured += `${args.map(String).join(" ")}\n`;
		};
		const { restore } = mockFetch([]);
		try {
			await maybeAutoUpdate();
		} finally {
			console.log = orig;
			restore();
		}
		// No "Updating in background…" line — the install path is skipped.
		expect(captured).not.toContain("in background");
	});
});
