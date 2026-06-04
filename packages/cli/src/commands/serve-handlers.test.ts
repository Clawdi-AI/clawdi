import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rejectUnsupportedOpts } from "./serve";

/**
 * Behavior tests for daemon singleton handler behavior:
 *   - rejectUnsupportedOpts (helper used by status/uninstall/restart/logs/doctor)
 *   - singleton daemon handlers rejecting legacy target selectors
 *
 * Strategy: swap `process.exit` to throw a tagged error so we can
 * `expect(...).toThrow()` and inspect the captured `console.error`
 * output. Real listRegisteredAgentTypes / file-system calls are
 * left in place — the test environment has 0 registered agents,
 * which is enough to hit every "rejects before reaching the OS"
 * branch we care about.
 */

const captured = {
	stderr: [] as string[],
	exitCode: null as number | null,
};

class ExitCalled extends Error {
	constructor(public code: number) {
		super(`process.exit(${code})`);
	}
}

let restoreExit: (() => void) | null = null;

beforeEach(() => {
	captured.stderr = [];
	captured.exitCode = null;
	const origExit = process.exit;
	const origErr = console.error;
	process.exit = ((code?: number) => {
		captured.exitCode = code ?? 0;
		throw new ExitCalled(code ?? 0);
	}) as typeof process.exit;
	console.error = (...args: unknown[]) => {
		captured.stderr.push(args.map(String).join(" "));
	};
	restoreExit = () => {
		process.exit = origExit;
		console.error = origErr;
	};
});

afterEach(() => {
	restoreExit?.();
	restoreExit = null;
});

describe("rejectUnsupportedOpts", () => {
	const ALLOWED = new Set(["agent", "json"]);

	it("returns silently when opts only contain allowed keys", () => {
		expect(() => rejectUnsupportedOpts("foo", { agent: "x", json: true }, ALLOWED)).not.toThrow();
		expect(captured.exitCode).toBeNull();
	});

	it("returns silently on empty opts", () => {
		expect(() => rejectUnsupportedOpts("foo", {}, ALLOWED)).not.toThrow();
		expect(captured.exitCode).toBeNull();
	});

	it("exits 1 when an unsupported key is present", () => {
		expect(() =>
			rejectUnsupportedOpts("doctor", { agent: "codex", environmentId: "x" }, new Set(["json"])),
		).toThrow(ExitCalled);
		expect(captured.exitCode).toBe(1);
		// Both offenders surfaced, kebab-cased, in the error.
		const msg = captured.stderr.join("\n");
		expect(msg).toMatch(/daemon doctor/);
		expect(msg).toMatch(/--agent/);
		expect(msg).toMatch(/--environment-id/);
	});

	it("kebab-cases camelCase option names in the error", () => {
		expect(() =>
			rejectUnsupportedOpts("status", { environmentId: "x" }, new Set(["agent"])),
		).toThrow(ExitCalled);
		expect(captured.stderr.join("\n")).toMatch(/--environment-id/);
		expect(captured.stderr.join("\n")).not.toMatch(/--environmentId/);
	});
});

describe("subcommand handler rejects parent-leaked options", () => {
	it("install rejects legacy selectors", async () => {
		const { serveInstall } = await import("./serve");
		await expect(serveInstall({ agent: "codex" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
		expect(captured.stderr.join("\n")).toMatch(/daemon install.*--agent/);
	});

	it("uninstall rejects legacy selectors", async () => {
		const { serveUninstall } = await import("./serve");
		await expect(serveUninstall({ agent: "codex" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
		expect(captured.stderr.join("\n")).toMatch(/daemon uninstall.*--agent/);
	});

	it("restart rejects legacy selectors", async () => {
		const { serveRestart } = await import("./serve");
		await expect(serveRestart({ agent: "codex" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
		expect(captured.stderr.join("\n")).toMatch(/daemon restart.*--agent/);
	});

	it("uninstall rejects --environment-id", async () => {
		const { serveUninstall } = await import("./serve");
		await expect(
			serveUninstall({
				environmentId: "00000000-0000-0000-0000-000000000001",
			} as Record<string, unknown>),
		).rejects.toThrow(ExitCalled);
		expect(captured.stderr.join("\n")).toMatch(/daemon uninstall.*--environment-id/);
	});

	it("status rejects --environment-id", async () => {
		const { serveStatus } = await import("./serve");
		await expect(
			serveStatus({
				environmentId: "00000000-0000-0000-0000-000000000001",
			} as Record<string, unknown>),
		).rejects.toThrow(ExitCalled);
		expect(captured.stderr.join("\n")).toMatch(/daemon status.*--environment-id/);
	});

	it("doctor rejects --agent", async () => {
		const { serveDoctor } = await import("./serve");
		await expect(serveDoctor({ agent: "codex" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
		expect(captured.stderr.join("\n")).toMatch(/daemon doctor.*--agent/);
	});
});

describe("full control RPC handler surface", () => {
	it("advertises sync, vault, auth, update, and operation RPC methods", async () => {
		const { createControlRpcHandlers } = await import("./serve");
		const handlers = createControlRpcHandlers();
		const methodsResult = (await handlers["daemon.methods"]?.({})) as
			| { methods?: string[] }
			| undefined;

		expect(methodsResult?.methods).toContain("sync.push");
		expect(methodsResult?.methods).toContain("sync.pull");
		expect(methodsResult?.methods).toContain("vault.resolve");
		expect(methodsResult?.methods).toContain("auth.login");
		expect(methodsResult?.methods).toContain("update.install");
		expect(methodsResult?.methods).toContain("operation.status");
	});

	it("requires an explicit cwd, project, or all=true for sync.push", async () => {
		const { createControlRpcHandlers } = await import("./serve");
		const handler = createControlRpcHandlers()["sync.push"];
		if (!handler) throw new Error("missing sync.push handler");

		await expect((async () => handler({}))()).rejects.toThrow(
			"sync.push RPC requires cwd or project unless all=true",
		);
	});

	it("blocks vault plaintext reads unless explicitly confirmed", async () => {
		const { createControlRpcHandlers } = await import("./serve");
		const handler = createControlRpcHandlers()["vault.resolve"];
		if (!handler) throw new Error("missing vault.resolve handler");

		await expect(
			(async () => handler({ key: "OPENAI_API_KEY", include_value: true }))(),
		).rejects.toThrow("vault.resolve plaintext access requires confirm_secret_access=true");
	});

	it("does not allow vault.inject secret rendering in background operation logs", async () => {
		const { createControlRpcHandlers } = await import("./serve");
		const handler = createControlRpcHandlers()["vault.inject"];
		if (!handler) throw new Error("missing vault.inject handler");

		await expect(
			(async () =>
				handler({
					input: "OPENAI_API_KEY=clawdi://prod/openai/key",
					confirm_secret_access: true,
					wait: false,
				}))(),
		).rejects.toThrow("vault.inject secret rendering cannot run as a background operation");
	});

	it("does not overwrite existing auth with an unverified imported API key", async () => {
		const originalClawdiHome = process.env.CLAWDI_HOME;
		const originalToken = process.env.CLAWDI_AUTH_TOKEN;
		const originalFetch = globalThis.fetch;
		const tmpHome = mkdtempSync(join(tmpdir(), "clawdi-rpc-auth-"));
		process.env.CLAWDI_HOME = join(tmpHome, ".clawdi");
		delete process.env.CLAWDI_AUTH_TOKEN;
		globalThis.fetch = Object.assign(async () => new Response("", { status: 401 }), {
			preconnect: originalFetch.preconnect,
		});
		try {
			const [{ createControlRpcHandlers }, { getAuth, setAuth }] = await Promise.all([
				import("./serve"),
				import("../lib/config"),
			]);
			setAuth({ apiKey: "old-key", userId: "old-user", email: "old@example.com" });
			const handler = createControlRpcHandlers()["auth.login"];
			if (!handler) throw new Error("missing auth.login handler");

			await expect(
				(async () =>
					handler({
						api_key: "bad-key",
						replace: true,
						confirm_secret_access: true,
					}))(),
			).rejects.toThrow("API key verification failed with HTTP 401");
			expect(getAuth()?.apiKey).toBe("old-key");
		} finally {
			globalThis.fetch = originalFetch;
			if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
			else process.env.CLAWDI_HOME = originalClawdiHome;
			if (originalToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = originalToken;
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});

describe("daemon HTTP RPC listener safety", () => {
	it("rejects non-loopback listen hosts unless explicitly allowed", async () => {
		const { serve } = await import("./serve");

		await expect(
			serve({ rpcHost: "0.0.0.0", rpcPort: "17654" } as Record<string, unknown>),
		).rejects.toThrow("Refusing to listen on non-loopback HTTP RPC host 0.0.0.0");
	});

	it("allows a loopback listen host without an explicit port before continuing to the auth gate", async () => {
		const { serve } = await import("./serve");

		await expect(serve({ rpcHost: "127.0.0.1" } as Record<string, unknown>)).rejects.toThrow(
			ExitCalled,
		);
	});

	it("allows explicit non-loopback opt-in before continuing to the auth gate", async () => {
		const originalHome = process.env.CLAWDI_HOME;
		const originalToken = process.env.CLAWDI_AUTH_TOKEN;
		const tmpHome = mkdtempSync(join(tmpdir(), "clawdi-rpc-listen-"));
		process.env.CLAWDI_HOME = join(tmpHome, ".clawdi");
		delete process.env.CLAWDI_AUTH_TOKEN;
		try {
			const { serve } = await import("./serve");
			await expect(
				serve({
					rpcHost: "0.0.0.0",
					rpcPort: "17654",
					rpcAllowRemote: true,
				} as Record<string, unknown>),
			).rejects.toThrow(ExitCalled);
		} finally {
			if (originalHome === undefined) delete process.env.CLAWDI_HOME;
			else process.env.CLAWDI_HOME = originalHome;
			if (originalToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = originalToken;
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});

describe("legacy daemon run migration", () => {
	it("installs the singleton unit, persists an explicit env id, and removes the old unit", async () => {
		if (process.platform !== "linux") return;

		const originalHome = process.env.HOME;
		const originalClawdiHome = process.env.CLAWDI_HOME;
		const originalPath = process.env.PATH;
		const originalToken = process.env.CLAWDI_AUTH_TOKEN;
		const originalArgv1 = process.argv[1];
		const tmpHome = mkdtempSync(join(tmpdir(), "clawdi-legacy-daemon-"));
		const stubBin = join(tmpHome, "bin");
		const fakeEntry = join(tmpHome, "clawdi-bin");
		const singletonUnit = join(tmpHome, ".config", "systemd", "user", "clawdi-serve.service");
		const legacyUnit = join(tmpHome, ".config", "systemd", "user", "clawdi-serve-codex.service");
		try {
			process.env.HOME = tmpHome;
			delete process.env.CLAWDI_HOME;
			process.env.CLAWDI_AUTH_TOKEN = "clawdi_test_token";
			mkdirSync(stubBin, { recursive: true });
			writeExecutable(join(stubBin, "systemctl"), "#!/bin/sh\nexit 0\n");
			process.env.PATH = `${stubBin}:${originalPath ?? ""}`;
			writeExecutable(fakeEntry, "#!/bin/sh\nexit 0\n");
			process.argv[1] = fakeEntry;
			mkdirSync(dirname(legacyUnit), { recursive: true });
			writeFileSync(legacyUnit, "legacy unit\n");

			const { serve } = await import("./serve");
			await expect(
				serve({
					agent: "codex",
					environmentId: "env-codex",
				} as Record<string, unknown>),
			).rejects.toThrow(ExitCalled);

			expect(captured.exitCode).toBe(0);
			expect(existsSync(singletonUnit)).toBe(true);
			expect(existsSync(legacyUnit)).toBe(false);
			expect(
				readFileSync(join(tmpHome, ".clawdi", "environments", "codex.json"), "utf-8"),
			).toContain('"id": "env-codex"');
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalClawdiHome === undefined) delete process.env.CLAWDI_HOME;
			else process.env.CLAWDI_HOME = originalClawdiHome;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalToken === undefined) delete process.env.CLAWDI_AUTH_TOKEN;
			else process.env.CLAWDI_AUTH_TOKEN = originalToken;
			process.argv[1] = originalArgv1 ?? "";
			rmSync(tmpHome, { recursive: true, force: true });
		}
	});
});

function writeExecutable(path: string, content: string): void {
	writeFileSync(path, content, { mode: 0o755 });
	chmodSync(path, 0o755);
}
