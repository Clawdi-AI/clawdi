import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { compareSemver } from "../../src/lib/semver";
import {
	configuredNativeBinary,
	createNativeReleaseFixture,
	derivedNativeFixtureVersions,
	deriveNativeVersion,
	type NativeInstallResult,
	type NativeReleaseFixture,
	readNativeIdentity,
	rewriteNativeReleaseManifest,
	runNativeInstaller,
	runNativeInstallerAsync,
} from "./native-fixture";

const nativeBinary = configuredNativeBinary();
const enabled = nativeBinary && process.platform === "linux" && process.arch === "x64";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

(enabled ? describe : describe.skip)("native installer lifecycle", () => {
	it("adds the zsh PATH block once and preserves it on a second install", () => {
		const input = pathInstallerFixture("prefix with spaces and $cash");
		const profile = join(input.home, ".zshrc");
		const existing = "# Existing shell settings\n";
		writeFileSync(profile, existing);
		const options = { ...input, env: { SHELL: "/bin/zsh" } };
		const first = runNativeInstaller(options);
		expect(first.code, first.stderr).toBe(0);
		expect(first.stdout).toContain(`Added ${input.prefix}/bin to PATH in ${profile}.`);
		expect(first.stdout).toContain("Open a new terminal, or run:");
		const configured = readFileSync(profile, "utf8");
		expect(configured.startsWith(existing)).toBeTrue();
		expect(configured.split("# Added by the Clawdi installer")).toHaveLength(2);
		const shell = command("sh", ["-c", '. "$1"; . "$1"; printf "%s\\n" "$PATH"', "sh", profile], {
			...process.env,
			PATH: "/usr/bin:/bin",
		});
		expect(shell.code, shell.stderr).toBe(0);
		expect(shell.stdout.trim()).toBe(`${input.prefix}/bin:/usr/bin:/bin`);
		const alreadyConfigured = command(
			"sh",
			["-c", '. "$1"; printf "%s\\n" "$PATH"', "sh", profile],
			{ ...process.env, PATH: `/usr/bin:${input.prefix}/bin:/bin` },
		);
		expect(alreadyConfigured.stdout.trim()).toBe(`/usr/bin:${input.prefix}/bin:/bin`);
		const second = runNativeInstaller(options);
		expect(second.code, second.stderr).toBe(0);
		expect(readFileSync(profile, "utf8")).toBe(configured);
	}, 120_000);

	it("leaves shell profiles untouched when PATH modification is disabled", () => {
		const input = pathInstallerFixture();
		const profile = join(input.home, ".zshrc");
		const existing = "# Keep my shell profile unchanged\n";
		writeFileSync(profile, existing);
		const result = runNativeInstaller({
			...input,
			env: { SHELL: "/bin/zsh", CLAWDI_NO_MODIFY_PATH: "1" },
		});
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain(
			`Add ${input.prefix}/bin to PATH to run clawdi. (CLAWDI_NO_MODIFY_PATH is set.)`,
		);
		expect(readFileSync(profile, "utf8")).toBe(existing);
		expect(readdirSync(input.home)).toEqual([".zshrc"]);
	}, 120_000);

	it("leaves shell profiles untouched when the install directory is already on PATH", () => {
		const input = pathInstallerFixture();
		const profile = join(input.home, ".zshrc");
		const existing = "# PATH is already configured\n";
		writeFileSync(profile, existing);
		const result = runNativeInstaller({
			...input,
			includePrefixInPath: true,
			env: { SHELL: "/bin/zsh" },
		});
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).not.toContain("Added ");
		expect(result.stdout).not.toContain("Add ");
		expect(readFileSync(profile, "utf8")).toBe(existing);
		expect(readdirSync(input.home)).toEqual([".zshrc"]);
	}, 120_000);

	for (const scenario of [
		{ shell: "/bin/bash", profile: ".bashrc" },
		{ shell: "/bin/sh", profile: ".profile" },
		{
			shell: "/bin/zsh",
			profile: "zsh-config/.zshrc",
			variable: "ZDOTDIR",
			configDirectory: "zsh-config",
		},
		{
			shell: "/bin/fish",
			profile: "shell-config/fish/conf.d/clawdi.fish",
			variable: "XDG_CONFIG_HOME",
			configDirectory: "shell-config",
		},
	]) {
		it(`creates ${scenario.profile} for ${scenario.shell}`, () => {
			const input = pathInstallerFixture();
			const profile = join(input.home, scenario.profile);
			const configHome = scenario.configDirectory
				? join(input.home, scenario.configDirectory)
				: input.home;
			const result = runNativeInstaller({
				...input,
				env: {
					SHELL: scenario.shell,
					...(scenario.variable ? { [scenario.variable]: configHome } : {}),
				},
			});
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain(`Added ${input.prefix}/bin to PATH in ${profile}.`);
			expect(mode(profile)).toBe(0o644);
			if (scenario.shell === "/bin/fish") {
				expect(readFileSync(profile, "utf8")).toContain(`fish_add_path -g "${input.prefix}/bin"`);
			} else {
				const shell = command("sh", ["-c", '. "$1"; printf "%s\\n" "$PATH"', "sh", profile], {
					...process.env,
					PATH: "/usr/bin:/bin",
				});
				expect(shell.code, shell.stderr).toBe(0);
				expect(shell.stdout.trim()).toBe(`${input.prefix}/bin:/usr/bin:/bin`);
			}
		}, 120_000);
	}

	for (const permissions of [0o444, 0o200]) {
		it(`uses manual PATH instructions for a profile with mode ${permissions.toString(8)}`, () => {
			const input = pathInstallerFixture();
			const profile = join(input.home, ".zshrc");
			const existing = "# Keep my shell profile unchanged\n";
			writeFileSync(profile, existing);
			chmodSync(profile, permissions);
			const result = runNativeInstaller({ ...input, env: { SHELL: "/bin/zsh" } });
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain(`Add ${input.prefix}/bin to PATH to run clawdi.`);
			chmodSync(profile, 0o644);
			expect(readFileSync(profile, "utf8")).toBe(existing);
			expect(command(join(input.prefix, "bin", "clawdi"), ["--version"]).code).toBe(0);
		}, 120_000);
	}

	it("preserves owned profile symlinks and skips targets belonging to another user", () => {
		const input = pathInstallerFixture();
		const profile = join(input.home, ".zshrc");
		const ownedTarget = join(input.home, "shell-rc");
		writeFileSync(ownedTarget, "# Existing shell settings\n");
		symlinkSync(ownedTarget, profile);
		const owned = runNativeInstaller({ ...input, env: { SHELL: "/bin/zsh" } });
		expect(owned.code, owned.stderr).toBe(0);
		expect(owned.stdout).toContain(`Added ${input.prefix}/bin to PATH in ${profile}.`);
		expect(readlinkSync(profile)).toBe(ownedTarget);
		expect(readFileSync(ownedTarget, "utf8")).toContain("# Added by the Clawdi installer");
		rmSync(profile);
		const target = "/etc/profile";
		const before = readFileSync(target, "utf8");
		expect(statSync(target).uid).not.toBe(statSync(input.home).uid);
		symlinkSync(target, profile);
		const result = runNativeInstaller({ ...input, env: { SHELL: "/bin/zsh" } });
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain(`Add ${input.prefix}/bin to PATH to run clawdi.`);
		expect(readlinkSync(profile)).toBe(target);
		expect(readFileSync(target, "utf8")).toBe(before);
	}, 120_000);

	it("uses manual PATH instructions when HOME is missing", () => {
		const input = pathInstallerFixture();
		const result = runNativeInstaller({ ...input, env: { HOME: "", SHELL: "/bin/zsh" } });
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain(`Add ${input.prefix}/bin to PATH to run clawdi.`);
		expect(readdirSync(input.home)).toEqual([]);
	}, 120_000);

	it("installs, switches exact versions, prunes conservatively, and resolves packaged resources", async () => {
		if (!nativeBinary) throw new Error("native binary is required");
		const root = fixtureRoot();
		const prefix = join(root, "prefix");
		const home = join(root, "home");
		const clawdiHome = join(root, "clawdi-home");
		const resourceRoot = dirname(nativeBinary);
		const currentIdentity = readNativeIdentity(nativeBinary);
		const [firstVersion, secondVersion] = derivedNativeFixtureVersions(currentIdentity.version, 2);
		if (!firstVersion || !secondVersion) {
			throw new Error("two native fixture versions are required");
		}
		mkdirSync(home, { mode: 0o755 });
		mkdirSync(clawdiHome, { mode: 0o755 });

		const firstBinary = join(root, `clawdi-${firstVersion}`);
		const secondBinary = join(root, `clawdi-${secondVersion}`);
		deriveNativeVersion(nativeBinary, firstBinary, firstVersion);
		deriveNativeVersion(nativeBinary, secondBinary, secondVersion);
		const releases = [firstBinary, secondBinary, nativeBinary].map((binary) =>
			createNativeReleaseFixture({ root, binary, resourceRoot }),
		);

		const first = runNativeInstaller({
			fixture: releases[0],
			prefix,
			home,
			clawdiHome,
			testRoot: root,
			shadowClawdi: true,
		});
		expect(first.code, first.stderr).toBe(0);
		expect(first.stdout).toContain(`Installing clawdi v${firstVersion} for linux-x64...`);
		expect(first.stdout).toContain(
			`Put ${prefix}/bin before other PATH entries to run this native installation.`,
		);
		expect(first.curlLog).toContain("--connect-timeout 10 --max-time 180");
		expect(first.curlLog).toContain("--proto =https --proto-redir =https");
		const launcher = join(prefix, "bin", "clawdi");
		expect(lstatSync(launcher).isSymbolicLink()).toBeTrue();
		expect(command(launcher, ["--version"]).stdout.trim()).toBe(firstVersion);

		const second = runNativeInstaller({
			fixture: releases[1],
			prefix,
			home,
			clawdiHome,
			testRoot: root,
		});
		expect(second.code, second.stderr).toBe(0);
		expect(command(launcher, ["--version"]).stdout.trim()).toBe(secondVersion);

		const nativeRoot = join(prefix, "share", "clawdi");
		const staleStage = join(nativeRoot, ".stage-stale-valid");
		const freshStage = join(nativeRoot, ".stage-fresh-concurrent");
		cpSync(join(nativeRoot, "versions", `${secondVersion}-${currentIdentity.target}`), staleStage, {
			recursive: true,
		});
		mkdirSync(freshStage);
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
		utimesSync(staleStage, old, old);

		const current = runNativeInstaller({
			fixture: releases[2],
			prefix,
			home,
			clawdiHome,
			testRoot: root,
			exactVersion: false,
		});
		expect(current.code, current.stderr).toBe(0);
		expect(current.curlLog).toContain("https://registry.npmjs.org/-/package/clawdi/dist-tags");
		expect(command(launcher, ["--version"]).stdout.trim()).toBe(currentIdentity.version);
		expect(readdirSync(join(nativeRoot, "versions")).sort()).toEqual(
			[
				`${secondVersion}-${currentIdentity.target}`,
				`${currentIdentity.version}-${currentIdentity.target}`,
			].sort(),
		);
		expect(existsSync(staleStage)).toBeFalse();
		expect(existsSync(freshStage)).toBeTrue();

		const activeDir = join(
			nativeRoot,
			"versions",
			`${currentIdentity.version}-${currentIdentity.target}`,
		);
		assertPublicNativeModes(prefix, activeDir);
		expect(readFileSync(join(activeDir, "skills", "clawdi", "SKILL.md"), "utf8")).toBe(
			readFileSync(join(resourceRoot, "skills", "clawdi", "SKILL.md"), "utf8"),
		);
		expect(readFileSync(join(activeDir, "egress-addon", "clawdi_egress_addon.py"), "utf8")).toBe(
			readFileSync(join(resourceRoot, "egress-addon", "clawdi_egress_addon.py"), "utf8"),
		);
		await assertCompiledSetupUsesInstalledSkill({ launcher, root, home, clawdiHome, activeDir });
	}, 120_000);

	it("serializes concurrent installers without pruning a fresh stage", async () => {
		if (!nativeBinary) throw new Error("native binary is required");
		const root = fixtureRoot();
		const prefix = join(root, "prefix");
		const home = join(root, "home");
		const clawdiHome = join(root, "clawdi-home");
		mkdirSync(home);
		mkdirSync(clawdiHome);
		const fixture = createNativeReleaseFixture({
			root,
			binary: nativeBinary,
			resourceRoot: dirname(nativeBinary),
		});
		const input = {
			artifactDelaySeconds: 1,
			clawdiHome,
			fixture,
			home,
			prefix,
			testRoot: root,
		};
		const results = await Promise.all([
			runNativeInstallerAsync(input),
			runNativeInstallerAsync(input),
		]);
		for (const result of results) expect(result.code, result.stderr).toBe(0);
		const identity = readNativeIdentity(nativeBinary);
		const nativeRoot = join(prefix, "share", "clawdi");
		expect(command(join(prefix, "bin", "clawdi"), ["--version"]).stdout.trim()).toBe(
			identity.version,
		);
		expect(readdirSync(join(nativeRoot, "versions"))).toEqual([
			`${identity.version}-${identity.target}`,
		]);
		expect(readdirSync(nativeRoot).filter((entry) => entry.startsWith(".stage-"))).toEqual([]);
	}, 120_000);

	it("automatic activation preserves a newer version installed after discovery", () => {
		if (!nativeBinary) throw new Error("native binary is required");
		const root = fixtureRoot();
		const home = join(root, "home");
		const clawdiHome = join(root, "clawdi-home");
		const prefix = join(root, "prefix");
		mkdirSync(home);
		mkdirSync(clawdiHome);
		const base = createNativeReleaseFixture({
			root,
			binary: nativeBinary,
			resourceRoot: dirname(nativeBinary),
		});
		const version = derivedNativeFixtureVersions(base.version, 1)[0];
		if (!version) throw new Error("derived version is required");
		const binary = join(root, "derived-clawdi");
		deriveNativeVersion(nativeBinary, binary, version);
		const derived = createNativeReleaseFixture({
			root,
			binary,
			resourceRoot: dirname(nativeBinary),
		});
		const [older, newer] = [base, derived].sort((a, b) => compareSemver(a.version, b.version));
		if (!older || !newer) throw new Error("two releases are required");
		const installed = runNativeInstaller({
			fixture: newer,
			prefix,
			home,
			clawdiHome,
			testRoot: root,
		});
		expect(installed.code, installed.stderr).toBe(0);
		const launcher = join(prefix, "bin", "clawdi");
		const activeTarget = readlinkSync(launcher);
		const stage = join(prefix, "share", "clawdi", ".stage-stale-auto-update");
		cpSync(join(older.directory, "payload"), stage, { recursive: true });
		cpSync(
			join(older.directory, "clawdi-cli-manifest.txt"),
			join(stage, "clawdi-cli-manifest.txt"),
		);
		const result = command(
			join(stage, "clawdi"),
			[
				"update",
				"--native-activate",
				"--native-auto-update",
				"--native-stage",
				stage,
				"--native-prefix",
				prefix,
				"--native-version",
				older.version,
				"--native-target",
				older.target,
			],
			{
				...process.env,
				HOME: home,
				CLAWDI_HOME: clawdiHome,
				CLAWDI_NO_AUTO_UPDATE: "1",
				CLAWDI_NO_UPDATE_CHECK: "1",
			},
		);
		expect(result.code, result.stderr).toBe(76);
		expect(readlinkSync(launcher)).toBe(activeTarget);
		expect(command(launcher, ["--version"]).stdout.trim()).toBe(newer.version);
	}, 60_000);

	it("fails closed for damaged archives and unowned launchers", () => {
		if (!nativeBinary) throw new Error("native binary is required");
		const root = fixtureRoot();
		const home = join(root, "home");
		const clawdiHome = join(root, "clawdi-home");
		const prefix = join(root, "prefix");
		mkdirSync(home);
		mkdirSync(clawdiHome);
		const baseline = createNativeReleaseFixture({
			root,
			binary: nativeBinary,
			resourceRoot: dirname(nativeBinary),
		});
		const installed = runNativeInstaller({
			fixture: baseline,
			prefix,
			home,
			clawdiHome,
			testRoot: root,
		});
		expect(installed.code, installed.stderr).toBe(0);
		const launcher = join(prefix, "bin", "clawdi");
		const activeTarget = readlinkSync(launcher);

		withReleaseClone(baseline, root, "checksum", (checksum) => {
			const manifestPath = join(checksum.directory, "clawdi-cli-manifest.txt");
			writeFileSync(
				manifestPath,
				readFileSync(manifestPath, "utf8").replace(
					/(artifact\tlinux-x64\tclawdi-cli-linux-x64\.tar\.gz\t)[0-9a-f]{64}/,
					`$1${"0".repeat(64)}`,
				),
			);
			assertRejectedWithoutActivation(
				checksum,
				prefix,
				home,
				clawdiHome,
				root,
				launcher,
				activeTarget,
			);
		});

		withReleaseClone(baseline, root, "unsafe", (unsafe) => {
			symlinkSync(
				"clawdi_egress_addon.py",
				join(unsafe.directory, "payload", "egress-addon", "link.py"),
			);
			repack(unsafe);
			assertRejectedWithoutActivation(
				unsafe,
				prefix,
				home,
				clawdiHome,
				root,
				launcher,
				activeTarget,
			);
		});

		withReleaseClone(baseline, root, "traversal", (traversal) => {
			run("tar", [
				"-czf",
				join(traversal.directory, `clawdi-cli-${traversal.target}.tar.gz`),
				"--transform=s|^egress-addon/clawdi_egress_addon.py$|../escape.py|",
				"-C",
				join(traversal.directory, "payload"),
				"clawdi",
				"egress-addon",
				"skills",
			]);
			rewriteNativeReleaseManifest(traversal);
			assertRejectedWithoutActivation(
				traversal,
				prefix,
				home,
				clawdiHome,
				root,
				launcher,
				activeTarget,
			);
			expect(existsSync(join(prefix, "share", "clawdi", "escape.py"))).toBeFalse();
		});

		withReleaseClone(baseline, root, "bomb", (bomb) => {
			const bombPath = join(bomb.directory, "payload", "egress-addon", "bomb.bin");
			writeFileSync(bombPath, "");
			truncateSync(bombPath, 513 * 1024 * 1024);
			repack(bomb);
			assertRejectedWithoutActivation(bomb, prefix, home, clawdiHome, root, launcher, activeTarget);
		});

		for (const kind of ["regular", "broken"] as const) {
			const candidatePrefix = join(root, `prefix-${kind}`);
			mkdirSync(join(candidatePrefix, "bin"), { recursive: true });
			const candidate = join(candidatePrefix, "bin", "clawdi");
			const originalLauncher = "../share/clawdi/versions/missing-linux-x64/clawdi";
			if (kind === "regular") writeFileSync(candidate, "unowned\n", { mode: 0o755 });
			else symlinkSync(originalLauncher, candidate);
			const rejected = runNativeInstaller({
				fixture: baseline,
				prefix: candidatePrefix,
				home,
				clawdiHome,
				testRoot: root,
			});
			expect(rejected.code).not.toBe(0);
			expect(rejected.stderr).toContain(
				kind === "regular" ? "unowned executable" : "broken native launcher",
			);
			expect(kind === "regular" ? readFileSync(candidate, "utf8") : readlinkSync(candidate)).toBe(
				kind === "regular" ? "unowned\n" : originalLauncher,
			);
			expect(readdirSync(join(candidatePrefix, "share", "clawdi", "versions"))).toEqual([]);
		}
	}, 120_000);
});

function pathInstallerFixture(prefixName = "prefix") {
	if (!nativeBinary) throw new Error("native binary is required");
	const root = fixtureRoot();
	const home = join(root, "home");
	const clawdiHome = join(root, "clawdi-home");
	mkdirSync(home);
	mkdirSync(clawdiHome);
	return {
		home,
		clawdiHome,
		prefix: join(root, prefixName),
		testRoot: root,
		includePrefixInPath: false,
		fixture: createNativeReleaseFixture({
			root,
			binary: nativeBinary,
			resourceRoot: dirname(nativeBinary),
		}),
	};
}

function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-native-installer-"));
	chmodSync(root, 0o755);
	roots.push(root);
	return root;
}

function command(binary: string, args: string[], env = process.env) {
	const result = spawnSync(binary, args, { env, encoding: "utf8" });
	return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

async function commandAsync(binary: string, args: string[], env = process.env) {
	const child = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, stdout, stderr };
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

function assertPublicNativeModes(prefix: string, active: string): void {
	for (const directory of [
		prefix,
		join(prefix, "bin"),
		join(prefix, "share"),
		join(prefix, "share", "clawdi"),
		join(prefix, "share", "clawdi", "versions"),
		active,
		join(active, "skills"),
		join(active, "egress-addon"),
	]) {
		expect(mode(directory), directory).toBe(0o755);
	}
	expect(mode(join(active, "clawdi"))).toBe(0o755);
	for (const file of [
		join(active, "clawdi-cli-manifest.txt"),
		join(active, "clawdi-native-install.txt"),
		join(active, "skills", "clawdi", "SKILL.md"),
		join(active, "egress-addon", "clawdi_egress_addon.py"),
	]) {
		expect(mode(file), file).toBe(0o644);
	}
}

async function assertCompiledSetupUsesInstalledSkill(input: {
	launcher: string;
	root: string;
	home: string;
	clawdiHome: string;
	activeDir: string;
}): Promise<void> {
	const codexHome = join(input.home, ".codex");
	const fakeBin = join(input.root, "agent-bin");
	mkdirSync(fakeBin);
	mkdirSync(codexHome);
	writeFileSync(join(fakeBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const api = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/v1/agents") {
				return Response.json({ id: "native-setup-agent" });
			}
			return Response.json({ detail: "not found" }, { status: 404 });
		},
	});
	try {
		const env = {
			...process.env,
			CLAWDI_API_URL: api.url.origin,
			CLAWDI_AUTH_TOKEN: "native-test-token",
			CLAWDI_AUTH_TOKEN_ORIGIN: api.url.origin,
			CLAWDI_HOME: input.clawdiHome,
			CLAWDI_NO_AUTO_UPDATE: "1",
			CLAWDI_NO_UPDATE_CHECK: "1",
			CODEX_HOME: codexHome,
			HOME: input.home,
			NO_COLOR: "1",
			PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
		};
		const setup = await commandAsync(
			input.launcher,
			["setup", "--agent", "codex", "--no-daemon"],
			env,
		);
		expect(setup.code, `${setup.stdout}\n${setup.stderr}`).toBe(0);
		expect(readFileSync(join(codexHome, "skills", "clawdi", "SKILL.md"), "utf8")).toBe(
			readFileSync(join(input.activeDir, "skills", "clawdi", "SKILL.md"), "utf8"),
		);
	} finally {
		api.stop(true);
	}
}

function cloneRelease(source: NativeReleaseFixture, destination: string): NativeReleaseFixture {
	cpSync(source.directory, destination, { recursive: true });
	return { ...source, directory: destination };
}

function withReleaseClone<T>(
	source: NativeReleaseFixture,
	root: string,
	childName: string,
	use: (fixture: NativeReleaseFixture) => T,
): T {
	const resolvedRoot = resolve(root);
	const destination = resolve(resolvedRoot, childName);
	if (!destination.startsWith(`${resolvedRoot}${sep}`)) {
		throw new Error("native release fixture must be a child of its test root");
	}
	const fixture = cloneRelease(source, destination);
	try {
		return use(fixture);
	} finally {
		rmSync(destination, { recursive: true, force: true });
	}
}

function repack(fixture: NativeReleaseFixture): void {
	run("tar", [
		"-czf",
		join(fixture.directory, `clawdi-cli-${fixture.target}.tar.gz`),
		"-C",
		join(fixture.directory, "payload"),
		"clawdi",
		"egress-addon",
		"skills",
	]);
	rewriteNativeReleaseManifest(fixture);
}

function assertRejectedWithoutActivation(
	fixture: NativeReleaseFixture,
	prefix: string,
	home: string,
	clawdiHome: string,
	testRoot: string,
	launcher: string,
	activeTarget: string,
): NativeInstallResult {
	const result = runNativeInstaller({ fixture, prefix, home, clawdiHome, testRoot });
	expect(result.code).not.toBe(0);
	expect(readlinkSync(launcher)).toBe(activeTarget);
	return result;
}

function run(commandName: string, args: string[]): void {
	const result = spawnSync(commandName, args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${commandName} failed: ${result.stderr}`);
}
