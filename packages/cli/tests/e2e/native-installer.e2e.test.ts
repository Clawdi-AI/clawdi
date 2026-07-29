import { afterAll, describe, expect, it } from "bun:test";
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
import { gzipSync } from "node:zlib";
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

afterAll(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

(enabled ? describe : describe.skip)("native installer lifecycle", () => {
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

		withReleaseClone(baseline, root, "duplicate", (duplicate) => {
			const plainTar = join(duplicate.directory, "duplicate.tar");
			run("tar", [
				"-cf",
				plainTar,
				"-C",
				join(duplicate.directory, "payload"),
				"clawdi",
				"egress-addon",
				"skills",
			]);
			run("tar", ["-rf", plainTar, "-C", join(duplicate.directory, "payload"), "clawdi"]);
			const compressed = spawnSync("gzip", ["-c", plainTar], {
				maxBuffer: 256 * 1024 * 1024,
			});
			if (compressed.status !== 0) throw new Error(`gzip failed: ${compressed.stderr}`);
			writeFileSync(
				join(duplicate.directory, `clawdi-cli-${duplicate.target}.tar.gz`),
				compressed.stdout,
			);
			rewriteNativeReleaseManifest(duplicate);
			assertRejectedWithoutActivation(
				duplicate,
				prefix,
				home,
				clawdiHome,
				root,
				launcher,
				activeTarget,
			);
		});

		withReleaseClone(baseline, root, "bomb", (bomb) => {
			const bombPath = join(bomb.directory, "payload", "egress-addon", "bomb.bin");
			writeFileSync(bombPath, "");
			truncateSync(bombPath, 513 * 1024 * 1024);
			repack(bomb);
			assertRejectedWithoutActivation(bomb, prefix, home, clawdiHome, root, launcher, activeTarget);
		});

		withReleaseClone(baseline, root, "listing-bomb", (listingBomb) => {
			writeFileSync(
				join(listingBomb.directory, `clawdi-cli-${listingBomb.target}.tar.gz`),
				gzipSync(manyEntryTar(72_000), { level: 1 }),
			);
			rewriteNativeReleaseManifest(listingBomb);
			const listingRejected = assertRejectedWithoutActivation(
				listingBomb,
				prefix,
				home,
				clawdiHome,
				root,
				launcher,
				activeTarget,
			);
			expect(listingRejected.stderr).toContain("path listing exceeds the size limit");
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

function manyEntryTar(count: number): Buffer {
	const archive = Buffer.alloc((count + 2) * 512);
	const prefix = `skills/${"p".repeat(147)}`;
	for (let index = 0; index < count; index += 1) {
		const header = archive.subarray(index * 512, (index + 1) * 512);
		const name = `${String(index).padStart(5, "0")}-${"x".repeat(90)}`;
		header.write(name, 0, 100, "ascii");
		writeTarOctal(header, 100, 8, 0o644);
		writeTarOctal(header, 108, 8, 0);
		writeTarOctal(header, 116, 8, 0);
		writeTarOctal(header, 124, 12, 0);
		writeTarOctal(header, 136, 12, 0);
		header.fill(0x20, 148, 156);
		header.write("0", 156, 1, "ascii");
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		header.write(prefix, 345, 155, "ascii");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	}
	return archive;
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
	header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function run(commandName: string, args: string[]): void {
	const result = spawnSync(commandName, args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${commandName} failed: ${result.stderr}`);
}
