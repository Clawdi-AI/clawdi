import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dir, "../../src/index.ts");
const source = (path: string) => JSON.stringify(resolve(import.meta.dir, "../../src", path));
let home = "";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "clawdi-actionable-errors-"));
	mkdirSync(join(home, "bin"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
	const result = spawnSync(process.execPath, args, {
		cwd: home,
		encoding: "utf8",
		timeout: 10_000,
		env: {
			HOME: home,
			PATH: join(home, "bin"),
			CI: "1",
			CLAWDI_API_URL: "http://127.0.0.1:1",
			CLAWDI_DEPLOY_API_URL: "http://127.0.0.1:2",
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
			...env,
		},
	});
	if (result.error) throw result.error;
	expect(result.signal).toBeNull();
	return result;
}

function runError(script: string, env: Record<string, string> = {}) {
	return run(["-e", `import {handleError} from ${source("lib/errors.ts")}; ${script}`], env);
}

describe("actionable CLI errors", () => {
	it("names the failed request host and gives connection guidance without raw transport errors", () => {
		const result = runError(`
			import {retryingFetch} from ${source("lib/api-client.ts")};
			globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
			try {
				await retryingFetch(new Request("https://custom.example.test/v1/agents", {method: "POST"}), 1000);
			} catch (error) { handleError(error); }
		`);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			"Couldn't reach https://custom.example.test. Check your connection or CLAWDI_API_URL.",
		);
		expect(result.stderr).not.toContain("fetch failed");
		expect(result.stderr).not.toContain("API error 0");
	});

	it.each([false, true])("prints the 401 login guidance once (debug=%s)", (debug) => {
		const result = runError(
			`import {ApiError} from ${source("lib/api-client.ts")};
			handleError(new ApiError({status: 401, body: "Not signed in. Run clawdi auth login first.", hint: "Not signed in. Run clawdi auth login first."}));`,
			debug ? { CLAWDI_DEBUG: "1" } : {},
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			"Not signed in, or your session expired. Run `clawdi auth login`.",
		);
		if (debug) {
			expect(result.stderr).toContain("HTTP 401");
			expect(result.stderr).toMatch(/\n\s+at /);
		} else {
			expect(result.stderr.match(/clawdi auth login/g)).toHaveLength(1);
			expect(result.stderr).not.toContain("401");
			expect(result.stderr).not.toContain("at ");
		}
	});

	it("does not repeat a hint that matches the API error body", () => {
		const result = runError(`
			import {ApiError} from ${source("lib/api-client.ts")};
			handleError(new ApiError({status: 403, body: "Permission denied.", hint: "Permission denied."}));
		`);
		expect(result.status).toBe(1);
		expect(result.stderr.match(/Permission denied\./g)).toHaveLength(1);
	});

	it.each([
		{ status: 401, detail: "API key has expired", expected: "Your API key has expired." },
		{
			status: 410,
			detail:
				"API keys can no longer be created. Run `clawdi auth login` (use `--no-open` on a server).",
			expected: "API keys can no longer be created.",
		},
	])(
		"prints the API key migration guidance once for HTTP $status",
		({ status, detail, expected }) => {
			const result = runError(`
			import {ApiError} from ${source("lib/api-client.ts")};
			handleError(new ApiError({status: ${status}, body: ${JSON.stringify(JSON.stringify({ detail }))}, hint: ""}));
		`);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(expected);
			expect(result.stderr).toContain("--no-open");
			expect(result.stderr.match(/clawdi auth login/g)).toHaveLength(1);
		},
	);

	it.each([false, true])(
		"gives a bug-report next step and shows stacks only in debug (debug=%s)",
		(debug) => {
			const result = runError(
				'handleError(new TypeError("items.find is not a function"));',
				debug ? { CLAWDI_DEBUG: "1" } : {},
			);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("Unexpected error (items.find is not a function).");
			expect(result.stderr).toContain("Re-run with CLAWDI_DEBUG=1");
			expect(result.stderr).toContain("https://github.com/Clawdi-AI/clawdi/issues");
			expect(/\n\s+at /.test(result.stderr)).toBe(debug);
		},
	);

	it("keeps expected errors concise", () => {
		const result = runError('handleError(new Error("Invalid input."));');
		expect(result.status).toBe(1);
		expect(result.stderr.trim()).toBe("✗ Invalid input.");
	});

	it("returns a useful signed-out wallet JSON error", () => {
		const result = run([entry, "wallet", "status", "--json"]);
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({
			schema_version: "clawdi.wallet.error.v1",
			status: "error",
			error: { code: "not_signed_in", message: "Not signed in. Run `clawdi auth login` first." },
		});
	});

	it("prints signed-out wallet guidance in interactive mode", () => {
		const result = runError(`
			import {runWalletStatusCommand} from ${source("commands/wallet.ts")};
			await runWalletStatusCommand({}, {interactive: true}).catch(handleError);
		`);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Not signed in. Run `clawdi auth login` first.");
	});

	it.each([false, true])(
		"checks deploy auth before loading providers (manual key=%s)",
		(manual) => {
			const result = runError(`
			import {deployCommand} from ${source("commands/deploy.ts")};
			import {setAuth} from ${source("lib/config.ts")};
			${manual ? 'setAuth({apiKey: "clawdi_test", userId: "u1", endpointBinding: {version: 1, cloudApiOrigin: "http://127.0.0.1:1"}});' : ""}
			globalThis.fetch = async () => { throw new Error("Metadata must not be loaded before auth"); };
			await deployCommand({}, {interactive: true}).catch(handleError);
		`);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(
				"Deploying a Cloud Agent needs a browser sign-in. Run `clawdi auth login` (not --manual).",
			);
			expect(result.stderr).not.toMatch(/Saved providers|Loading plans|Clerk|Metadata must/);
		},
	);

	it("preserves the deploy authorization JSON envelope", () => {
		const result = run([entry, "deploy", "--json"]);
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stdout)).toEqual({
			schema_version: "clawdi.deploy.v1",
			status: "authorization_required",
			authorization: { command: "clawdi auth login" },
		});
		expect(result.stderr).toBe("");
	});

	it("does not expose sign-in provider internals in deploy errors", () => {
		const result = runError(`
			import {safeDeployError} from ${source("commands/deploy.ts")};
			import {ClerkOAuthError} from ${source("lib/clerk-oauth.ts")};
			const error = safeDeployError(new ClerkOAuthError("oauth_login_required", "Clerk returned invalid internals"));
			handleError(new Error(error.message));
		`);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Your sign-in is unavailable. Run `clawdi auth login` again.");
		expect(result.stderr).not.toMatch(/Clerk|internals/);
	});

	it("explains when journalctl cannot start", () => {
		const result = run([entry, "daemon", "logs"]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Couldn't run journalctl --user -u clawdi-serve.service");
		expect(result.stderr).toMatch(/ENOENT|not found/);
		expect(result.stderr).toContain("Is the daemon installed? Run `clawdi daemon status`.");
	});

	it("explains a journalctl failure after it starts", () => {
		writeFileSync(join(home, "bin", "journalctl"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
		const result = run([entry, "daemon", "logs"]);
		expect(result.status).toBe(3);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			"Couldn't run journalctl --user -u clawdi-serve.service (exit code 3).",
		);
		expect(result.stderr).toContain("clawdi daemon status");
	});

	it.each(["darwin", "win32"])("points to daemon install for missing %s logs", (platform) => {
		const result = runError(`
			Object.defineProperty(process, "platform", {value: ${JSON.stringify(platform)}});
			import {serveLogs} from ${source("commands/serve.ts")};
			await serveLogs({});
		`);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("clawdi daemon install");
		expect(result.stderr).not.toContain("Enable Sync");
	});

	it("describes the actual platform log sources in help", () => {
		const result = run([entry, "daemon", "logs", "--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout.replace(/\s+/g, " ")).toContain(
			"Show the daemon's recent log lines (journald on Linux, log file on macOS/Windows)",
		);
		expect(result.stdout).not.toContain("tail -F");
	});
});
