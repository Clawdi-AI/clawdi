import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	NATIVE_PUBLISH_TARGET_CATALOG,
	nativeAssetName,
} from "../../src/lib/native-release-manifest";
import { getCliVersion } from "../../src/lib/version";
import { windowsTaskInstalled } from "../../src/serve/windows-task";

const testRoot = process.env.CLAWDI_WINDOWS_TEST_ROOT;
const nativeBinary = process.env.CLAWDI_NATIVE_BINARY;
const enabled = process.platform === "win32" && testRoot && nativeBinary;

(enabled ? describe : describe.skip)("Windows native lifecycle", () => {
	it("installs three versions, preserves rollback, configures Codex and installs a user daemon", async () => {
		if (!testRoot || !nativeBinary) throw new Error("Windows native CI fixture is required");
		const root = realpathSync.native(mkdtempSync(join(testRoot, "lifecycle-")));
		const prefix = join(root, "prefix with spaces");
		const nativeRoot = join(prefix, "share", "clawdi");
		const current = join(nativeRoot, "current");
		const launcher = join(current, "clawdi.exe");
		const installer = resolve(import.meta.dir, "../../../../install.ps1");
		const userPath = powershell("[Environment]::GetEnvironmentVariable('Path', 'User')");
		const originalEnv = { ...process.env };
		const version = getCliVersion();
		const versions = [`${version}-g2.1`, `${version}-g2.2`, version];
		let installedDaemon = false;
		const api = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (request.method === "POST" && new URL(request.url).pathname === "/v1/agents") {
					return Response.json({ id: "windows-native-test-agent" });
				}
				return Response.json({ detail: "not found" }, { status: 404 });
			},
		});
		try {
			process.env.CLAWDI_HOME = join(root, "clawdi");
			process.env.CODEX_HOME = join(root, "codex");
			process.env.CLAWDI_API_URL = api.url.origin;
			process.env.CLAWDI_AUTH_TOKEN = "windows-native-test-token";
			process.env.CLAWDI_AUTH_TOKEN_ORIGIN = api.url.origin;
			process.env.CLAWDI_NO_AUTO_UPDATE = "1";
			process.env.CLAWDI_NO_UPDATE_CHECK = "1";
			process.env.CLAWDI_INSTALL_PREFIX = prefix;
			delete process.env.CLAWDI_NO_MODIFY_PATH;
			for (const selected of versions) {
				const release = await buildRelease(
					root,
					selected,
					selected === version ? nativeBinary : null,
				);
				process.env.CLAWDI_VERSION = selected;
				process.env.CLAWDI_RELEASE_BASE = release;
				const install = await runAsync("powershell.exe", [
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-Command",
					`$ErrorActionPreference='Stop'; & ${literal(installer)}; if ((clawdi --version) -cne ${literal(selected)}) { throw 'Current session PATH was not updated' }`,
				]);
				expect(install.code, `${install.stdout}\n${install.stderr}`).toBe(0);
				expect(run(launcher, ["--version"]).trim()).toBe(selected);
				expect(lstatSync(current).isSymbolicLink()).toBeTrue();
				expect(realpathSync.native(current)).toBe(
					realpathSync.native(join(nativeRoot, "versions", `${selected}-win32-x64`)),
				);
			}
			expect(readdirSync(join(nativeRoot, "versions")).sort()).toEqual(
				versions
					.slice(1)
					.map((entry) => `${entry}-win32-x64`)
					.sort(),
			);
			const previousDir = join(nativeRoot, "versions", `${version}-g2.2-win32-x64`);
			for (const file of ["clawdi.exe", "clawdi-cli-manifest-v2.txt", "skills/clawdi/SKILL.md"]) {
				expect(lstatSync(join(previousDir, file)).isFile()).toBeTrue();
			}
			expect(
				readdirSync(nativeRoot).some(
					(entry) => entry.startsWith("current.old-") || entry.startsWith(".stage-"),
				),
			).toBeFalse();
			const updatedPath = powershell("[Environment]::GetEnvironmentVariable('Path', 'User')");
			expect(updatedPath.split(";").filter((entry) => entry === current)).toHaveLength(1);

			// Missing agent executables still use the adapter's supported CODEX_HOME layout.
			mkdirSync(process.env.CODEX_HOME, { recursive: true });
			const setup = await runAsync(launcher, ["setup", "--agent", "codex", "--no-daemon"]);
			expect(setup.code, `${setup.stdout}\n${setup.stderr}`).toBe(0);
			expect(
				readFileSync(join(process.env.CODEX_HOME, "skills", "clawdi", "SKILL.md"), "utf8"),
			).toBe(readFileSync(join(current, "skills", "clawdi", "SKILL.md"), "utf8"));
			expect(readFileSync(join(process.env.CODEX_HOME, "config.toml"), "utf8")).toContain(
				launcher.replaceAll("\\", "\\\\"),
			);
			expect(windowsTaskInstalled()).toBeFalse();
			installedDaemon = true;
			const daemon = await runAsync(launcher, ["daemon", "install"]);
			expect(daemon.code, `${daemon.stdout}\n${daemon.stderr}`).toBe(0);
			expect(windowsTaskInstalled()).toBeTrue();
			expect(
				readFileSync(join(process.env.CLAWDI_HOME, "serve", "windows-task", "run.ps1"), "utf8"),
			).toContain(literal(launcher));
			const uninstall = await runAsync(launcher, ["daemon", "uninstall"]);
			expect(uninstall.code, `${uninstall.stdout}\n${uninstall.stderr}`).toBe(0);
			expect(windowsTaskInstalled()).toBeFalse();
			installedDaemon = false;

			// A corrupt manifest must fail before touching the installed launcher.
			const release = process.env.CLAWDI_RELEASE_BASE;
			writeFileSync(
				join(release, "clawdi-cli-manifest-v2.txt"),
				"clawdi.nativeRelease.v2\nversion\tinvalid\n",
			);
			const invalid = await runAsync("powershell.exe", [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				installer,
			]);
			expect(invalid.code).not.toBe(0);
			expect(run(launcher, ["--version"]).trim()).toBe(version);
			expect(readdirSync(nativeRoot).some((entry) => entry.startsWith(".stage-"))).toBeFalse();
		} finally {
			try {
				if (installedDaemon && existsSync(launcher)) run(launcher, ["daemon", "uninstall"]);
			} finally {
				api.stop(true);
				powershell(`[Environment]::SetEnvironmentVariable('Path', ${literal(userPath)}, 'User')`);
				for (const key of Object.keys(process.env)) {
					if (!(key in originalEnv)) delete process.env[key];
				}
				Object.assign(process.env, originalEnv);
				rmSync(root, { recursive: true, force: true });
			}
		}
	}, 600_000);
});

async function buildRelease(root: string, version: string, binary: string | null): Promise<string> {
	const directory = join(root, `release-${version}`);
	const payload = join(directory, "payload");
	mkdirSync(payload, { recursive: true });
	const executable = join(payload, "clawdi.exe");
	if (binary) cpSync(binary, executable);
	else {
		const build = await Bun.build({
			entrypoints: [resolve(import.meta.dir, "../../src/index.ts")],
			compile: { target: "bun-windows-x64", outfile: executable },
			define: {
				CLAWDI_CLI_VERSION: JSON.stringify(version),
				CLAWDI_NATIVE_TARGET: JSON.stringify("win32-x64"),
			},
			minify: true,
		});
		if (!build.success) throw new Error(build.logs.map((entry) => entry.message).join("\n"));
	}
	cpSync(resolve(import.meta.dir, "../../egress-addon"), join(payload, "egress-addon"), {
		recursive: true,
	});
	cpSync(resolve(import.meta.dir, "../../skills"), join(payload, "skills"), { recursive: true });
	const asset = nativeAssetName("win32-x64");
	run("tar.exe", [
		"-czf",
		join(directory, asset),
		"-C",
		payload,
		"clawdi.exe",
		"egress-addon",
		"skills",
	]);
	const sha256 = createHash("sha256")
		.update(readFileSync(join(directory, asset)))
		.digest("hex");
	writeFileSync(
		join(directory, "clawdi-cli-manifest-v2.txt"),
		[
			"clawdi.nativeRelease.v2",
			`version\t${version}`,
			...NATIVE_PUBLISH_TARGET_CATALOG.map(
				({ target }) => `artifact\t${target}\t${nativeAssetName(target)}\t${sha256}`,
			),
			"",
		].join("\n"),
	);
	return directory;
}

function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function powershell(script: string): string {
	return run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`$ErrorActionPreference='Stop'; ${script}`,
	]).trim();
}

function run(command: string, args: string[]): string {
	const result = spawnSync(command, args, { encoding: "utf8", timeout: 180_000, env: process.env });
	if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
	return result.stdout;
}

async function runAsync(command: string, args: string[]) {
	const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
	const timer = setTimeout(() => child.kill(), 180_000);
	try {
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}
