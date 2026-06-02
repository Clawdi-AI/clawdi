import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, "..", "..");
const srcEntry = join(cliRoot, "src", "index.ts");
const SECRET = "sk-ai-provider-e2e-secret";
const PASSPHRASE = "ai-provider-e2e-passphrase";

interface Fixture {
	root: string;
	home: string;
	clawdiHome: string;
}

let providerServer: ReturnType<typeof Bun.serve>;
let providerRequests: Array<{ path: string; auth: string | null }> = [];

beforeAll(() => {
	providerServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			providerRequests.push({
				path: url.pathname,
				auth: req.headers.get("authorization"),
			});
			if (url.pathname === "/v1/models") {
				return json({ data: [{ id: "gpt-5.2" }] });
			}
			return json({ detail: "not found" }, 404);
		},
	});
});

afterAll(() => {
	providerServer.stop(true);
});

describe("ai-provider CLI process e2e", () => {
	it("adds, optionally probes, encrypts, restores, and dry-runs ai-provider apply without leaking secrets", async () => {
		const source = createFixture();
		const destination = createFixture();
		const backupPath = join(source.root, "providers.backup.json");
		const restoredEnv = join(destination.root, "providers.env");
		providerRequests = [];

		try {
			const added = await runCli(
				source,
				[
					"ai-provider",
					"add",
					"openai-main",
					"--type",
					"openai",
					"--base-url",
					`${providerServer.url.origin}/v1`,
					"--default-model",
					"gpt-5.2",
					"--auth",
					"env:OPENAI_API_KEY",
					"--set-default",
					"--json",
				],
				{ OPENAI_API_KEY: SECRET },
			);
			expect(added.code).toBe(0);
			expect(added.stdout).not.toContain(SECRET);
			expect(added.stderr).not.toContain(SECRET);

			const tested = await runCli(source, ["ai-provider", "test", "openai-main", "--json"], {
				OPENAI_API_KEY: SECRET,
			});
			expect(tested.code).toBe(0);
			expect(tested.stdout).toContain('"status": "available"');
			expect(tested.stdout).toContain('"status": "skipped"');
			expect(tested.stdout).not.toContain(SECRET);
			expect(tested.stderr).not.toContain(SECRET);
			expect(providerRequests).toEqual([]);

			const liveTested = await runCli(
				source,
				["ai-provider", "test", "openai-main", "--live", "--json"],
				{ OPENAI_API_KEY: SECRET },
			);
			expect(liveTested.code).toBe(0);
			expect(liveTested.stdout).toContain('"status": "ok"');
			expect(liveTested.stdout).not.toContain(SECRET);
			expect(liveTested.stderr).not.toContain(SECRET);
			expect(providerRequests).toEqual([{ path: "/v1/models", auth: `Bearer ${SECRET}` }]);

			const exported = await runCli(
				source,
				["ai-provider", "export", "--out", backupPath, "--include-secrets", "--secret-passphrase"],
				{
					CLAWDI_SECRET_BACKUP_PASSPHRASE: PASSPHRASE,
					OPENAI_API_KEY: SECRET,
				},
			);
			expect(exported.code).toBe(0);
			const backup = readFileSync(backupPath, "utf8");
			expect(backup).toContain("encrypted_secrets");
			expect(backup).not.toContain(SECRET);
			expect(exported.stdout).not.toContain(SECRET);
			expect(exported.stderr).not.toContain(SECRET);

			const imported = await runCli(
				destination,
				[
					"ai-provider",
					"import",
					backupPath,
					"--replace",
					"--restore-secrets",
					"env-file",
					"--out",
					restoredEnv,
					"--json",
				],
				{ CLAWDI_SECRET_BACKUP_PASSPHRASE: PASSPHRASE },
			);
			expect(imported.code).toBe(0);
			expect(imported.stdout).not.toContain(SECRET);
			expect(imported.stderr).not.toContain(SECRET);
			expect(readFileSync(restoredEnv, "utf8")).toBe(`OPENAI_API_KEY='${SECRET}'\n`);

			const dryRun = await runCli(destination, [
				"ai-provider",
				"apply",
				"--engine",
				"hermes",
				"--dry-run",
				"--json",
			]);
			expect(dryRun.code).toBe(0);
			expect(dryRun.stdout).toContain('"dry_run": true');
			expect(dryRun.stdout).toContain("hermes config set providers.openai-main.key_env");
			expect(dryRun.stdout).not.toContain(SECRET);
			expect(existsSync(join(destination.clawdiHome, "runtime", "hermes"))).toBe(false);

			const stubDir = join(destination.root, "bin");
			const openClawArgs = join(destination.root, "openclaw-args");
			const openClawStdin = join(destination.root, "openclaw-stdin.json");
			mkdirSync(stubDir, { recursive: true });
			writeFileSync(
				join(stubDir, "openclaw"),
				`#!/bin/sh\nprintf "%s\\n" "$@" > "${openClawArgs}"\ncat > "${openClawStdin}"\nexit 0\n`,
			);
			chmodSync(join(stubDir, "openclaw"), 0o755);

			const openClawApplied = await runCli(
				destination,
				["ai-provider", "apply", "--engine", "openclaw", "--json"],
				{ PATH: `${stubDir}:${process.env.PATH ?? ""}` },
			);
			expect(openClawApplied.code).toBe(0);
			expect(openClawApplied.stdout).toContain('"engine": "openclaw"');
			expect(openClawApplied.stdout).not.toContain(SECRET);
			expect(openClawApplied.stderr).not.toContain(SECRET);
			expect(readFileSync(openClawArgs, "utf8").trim().split("\n")).toEqual([
				"config",
				"patch",
				"--stdin",
			]);
			const openClawPatch = JSON.parse(readFileSync(openClawStdin, "utf8"));
			expect(openClawPatch.agents.defaults.model.primary).toBe("openai-main/gpt-5.2");
			expect(openClawPatch.models.mode).toBe("merge");
			expect(openClawPatch.models.providers["openai-main"].api).toBe("openai-responses");
			expect(openClawPatch.models.providers["openai-main"].apiKey).toEqual({
				source: "env",
				provider: "default",
				id: "OPENAI_API_KEY",
			});
		} finally {
			rmSync(source.root, { recursive: true, force: true });
			rmSync(destination.root, { recursive: true, force: true });
		}
	});
});

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "clawdi-ai-provider-e2e-"));
	const home = join(root, "home");
	const clawdiHome = join(root, "clawdi-state");
	mkdirSync(home, { recursive: true });
	mkdirSync(clawdiHome, { recursive: true });
	writeFileSync(join(clawdiHome, "auth.json"), `${JSON.stringify({ apiKey: "test-key" })}\n`, {
		mode: 0o600,
	});
	return { root, home, clawdiHome };
}

async function runCli(
	fixture: Fixture,
	args: string[],
	extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	const proc = Bun.spawn([process.execPath, srcEntry, ...args], {
		cwd: fixture.root,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			CLAWDI_API_URL: "http://api.test",
			CLAWDI_HOME: fixture.clawdiHome,
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
			CI: "true",
			HOME: fixture.home,
			NO_COLOR: "1",
			PATH: process.env.PATH ?? "",
			TMPDIR: tmpdir(),
			...extraEnv,
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}
