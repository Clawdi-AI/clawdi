import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { uninstall } from "../../src/commands/uninstall";
import { setAuth } from "../../src/lib/config";
import { writeNativeInstallIdentity } from "../../src/lib/native-distribution";
import {
	NATIVE_BUILD_TARGET_CATALOG,
	nativeAssetName,
} from "../../src/lib/native-release-manifest";
import { reserveManagedSkill } from "../../src/runtime/managed-skill-reservation";
import { jsonResponse, mockFetch } from "./helpers";

let home: string;
const saved = { ...process.env };
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "clawdi-uninstall-"));
	process.env.HOME = home;
	process.env.CLAWDI_HOME = join(home, ".clawdi");
	delete process.env.CLAWDI_AUTH_TOKEN;
	delete process.env.CLAWDI_UNINSTALL_KEEP_CLI;
	delete process.env.ZDOTDIR;
	delete process.env.XDG_CONFIG_HOME;
	delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(() => {
	process.env = { ...saved };
	process.exitCode = 0;
	rmSync(home, { recursive: true, force: true });
});
const noDaemon = () => ({ removed: false });

function nativeInstall(installedBy?: "desktop") {
	const prefix = join(home, ".local");
	const directory = join(prefix, "share/clawdi/versions/1.2.3-linux-x64");
	const launcher = join(prefix, "bin/clawdi");
	for (const file of ["egress-addon/clawdi_egress_addon.py", "skills/clawdi/SKILL.md"]) {
		mkdirSync(dirname(join(directory, file)), { recursive: true });
		writeFileSync(join(directory, file), "fixture");
	}
	writeFileSync(join(directory, "clawdi"), "#!/bin/sh\nprintf '1.2.3\\tlinux-x64\\n'\n", {
		mode: 0o755,
	});
	const manifest = [
		"clawdi.nativeRelease.v2",
		"version\t1.2.3",
		...NATIVE_BUILD_TARGET_CATALOG.map(
			({ target }) => `artifact\t${target}\t${nativeAssetName(target)}\t${"a".repeat(64)}`,
		),
		"",
	].join("\n");
	writeFileSync(join(directory, "clawdi-cli-manifest-v2.txt"), manifest);
	writeNativeInstallIdentity(
		directory,
		{ version: "1.2.3", target: "linux-x64" },
		manifest,
		installedBy,
	);
	mkdirSync(dirname(launcher), { recursive: true });
	symlinkSync(join(directory, "clawdi"), launcher);
	return { prefix, directory, launcher };
}

(process.platform === "win32" ? describe.skip : describe)("uninstall", () => {
	test("full cleanup reuses daemon, teardown, and sign-out without deleting agent data", async () => {
		const env = join(home, ".clawdi/environments/claude_code.json");
		mkdirSync(dirname(env), { recursive: true });
		writeFileSync(env, JSON.stringify({ id: "agent-kept", agent_type: "claude_code" }));
		const skill = join(home, ".claude/skills/clawdi");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), "fixture");
		reserveManagedSkill({
			targetDir: skill,
			id: "clawdi",
			version: 1,
			digest: "a".repeat(64),
			manager: "local-setup",
		});
		const history = join(home, ".claude/history.jsonl");
		writeFileSync(history, "keep agent data");
		const bin = join(home, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		process.env.PATH = `${bin}:${process.env.PATH}`;
		setAuth({ apiKey: "clawdi_test_local" });
		const service = join(home, "service");
		writeFileSync(service, "fixture");
		const output = spyOn(console, "log").mockImplementation(() => {});
		try {
			const result = await uninstall(
				{ yes: true, json: true },
				{
					home,
					uninstallDaemon: () => {
						rmSync(service);
						return { removed: true };
					},
				},
			);
			expect(result.status).toBe("completed");
			expect(
				result.steps.filter((step) => step.status === "removed").map((step) => step.step),
			).toEqual(["daemon", "integrations", "auth", "local-state"]);
			expect(output).toHaveBeenCalledTimes(1);
			expect(JSON.parse(String(output.mock.calls[0]?.[0])).schemaVersion).toBe(
				"clawdi.uninstall.v1",
			);
			expect(existsSync(skill)).toBe(false);
			expect(existsSync(service)).toBe(false);
			expect(existsSync(join(home, ".clawdi"))).toBe(false);
			expect(readFileSync(history, "utf8")).toBe("keep agent data");
		} finally {
			output.mockRestore();
		}
	});

	test.each([200, 503])(
		"revokes OAuth server-side and reports revocation failures (%s)",
		async (status) => {
			process.env.CLAWDI_API_URL = "http://localhost:8000";
			setAuth({
				authType: "clerk_oauth",
				apiKey: "test-access",
				refreshToken: "test-refresh",
				accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
				issuer: "https://clerk.example.test",
				clientId: "test-cli",
				tokenEndpoint: "https://clerk.example.test/oauth/token",
				scopes: [],
				userId: "account-kept",
				endpointBinding: { version: 1, cloudApiOrigin: "http://localhost:8000" },
			});
			const { restore, captured } = mockFetch([
				{
					method: "POST",
					path: "/v1/cli/auth/oauth/revoke",
					response: () => jsonResponse({ status: "revoked" }, status),
				},
			]);
			try {
				const result = await uninstall({ yes: true }, { home, uninstallDaemon: noDaemon });
				expect(captured.map((call) => new URL(call.url).pathname)).toEqual([
					"/v1/cli/auth/oauth/revoke",
				]);
				expect(result.status).toBe(status === 200 ? "completed" : "failed");
				expect(existsSync(join(home, ".clawdi"))).toBe(false);
			} finally {
				restore();
			}
		},
	);

	test("rerunning after cleanup succeeds", async () => {
		await uninstall({ yes: true }, { home, uninstallDaemon: noDaemon });
		const result = await uninstall({ yes: true }, { home, uninstallDaemon: noDaemon });
		expect(result.status).toBe("completed");
		expect(
			result.steps.every((step) => step.status === "skipped" || step.step === "local-state"),
		).toBe(true);
	});

	test("keeps npm or Homebrew launchers even with --remove-cli", async () => {
		const { launcher, directory } = nativeInstall();
		rmSync(launcher);
		const foreign = join(home, "npm/bin/clawdi");
		mkdirSync(dirname(foreign), { recursive: true });
		writeFileSync(foreign, "npm owned");
		symlinkSync(foreign, launcher);
		const result = await uninstall(
			{ yes: true, removeCli: true },
			{ home, uninstallDaemon: noDaemon },
		);
		expect(result.status).toBe("completed");
		expect(readFileSync(foreign, "utf8")).toBe("npm owned");
		expect(existsSync(launcher)).toBe(true);
		expect(existsSync(directory)).toBe(true);
	});

	test("--remove-cli removes only the exact installer PATH block", async () => {
		const { launcher, directory, prefix } = nativeInstall();
		const marker = "# Added by the Clawdi installer (https://clawdi.ai/install.sh)";
		const block = `${marker}\ncase ":$PATH:" in *":${prefix}/bin:"*) ;; *) export PATH="${prefix}/bin:$PATH" ;; esac\n`;
		const custom = `${marker}\nexport PATH="/custom/bin:$PATH"\n`;
		writeFileSync(join(home, ".bashrc"), `# before\n${block}${custom}# after\n`);
		const result = await uninstall(
			{ yes: true, removeCli: true },
			{ home, uninstallDaemon: noDaemon },
		);
		expect(result.status).toBe("completed");
		expect(existsSync(launcher)).toBe(false);
		expect(existsSync(directory)).toBe(false);
		expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe(`# before\n${custom}# after\n`);
		expect(
			(await uninstall({ yes: true, removeCli: true }, { home, uninstallDaemon: noDaemon })).status,
		).toBe("completed");
	});

	test("Desktop ownership removes the native CLI automatically; an explicit keep choice wins", async () => {
		const { launcher } = nativeInstall("desktop");
		process.env.CLAWDI_UNINSTALL_KEEP_CLI = "1";
		await uninstall({ yes: true }, { home, uninstallDaemon: noDaemon });
		expect(existsSync(launcher)).toBe(true);
		delete process.env.CLAWDI_UNINSTALL_KEEP_CLI;
		await uninstall({ yes: true }, { home, uninstallDaemon: noDaemon });
		expect(existsSync(launcher)).toBe(false);
	});

	test("refuses a CLAWDI_HOME override that would remove the user's home", async () => {
		process.env.CLAWDI_HOME = home;
		const ownFile = join(home, "keep.txt");
		writeFileSync(ownFile, "keep personal data");
		const result = await uninstall({ yes: true }, { home, uninstallDaemon: noDaemon });
		expect(result.steps.find((step) => step.step === "local-state")?.status).toBe("failed");
		expect(readFileSync(ownFile, "utf8")).toBe("keep personal data");
		expect(result.status).toBe("failed");
	});

	test("continues after a service failure and exits nonzero", async () => {
		mkdirSync(join(home, ".clawdi"));
		const result = await uninstall(
			{ yes: true },
			{
				home,
				uninstallDaemon: () => {
					throw new Error("service failed");
				},
			},
		);
		expect(result.status).toBe("failed");
		expect(result.steps.find((step) => step.step === "daemon")?.status).toBe("failed");
		expect(existsSync(join(home, ".clawdi"))).toBe(false);
		expect(process.exitCode).toBe(1);
	});
});

test("a non-interactive command requires --yes even with --json", async () => {
	const child = Bun.spawn(
		["bun", join(import.meta.dir, "../../src/index.ts"), "uninstall", "--json"],
		{
			env: { ...process.env, CLAWDI_NO_AUTO_UPDATE: "1", CLAWDI_NO_UPDATE_CHECK: "1" },
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		},
	);
	const stderr = await new Response(child.stderr).text();
	expect(await child.exited).toBe(1);
	expect(stderr).toContain("Re-run with --yes");
});
