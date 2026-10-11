import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as tar from "tar";
import {
	validateNativePublicationArchive,
	writeNativeReleaseManifest,
} from "../scripts/native-publication.mjs";
import { validateNativeArchive } from "../src/lib/native-activation";
import {
	NATIVE_BUILD_TARGET_CATALOG,
	NATIVE_RELEASE_MANIFEST_V2_NAME,
	type NativeBuildTarget,
	nativeAssetName,
	parseNativeReleaseManifestV2,
} from "../src/lib/native-release-manifest";
import { runNativeInstaller } from "./e2e/native-fixture";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function payload(executableName = "clawdi"): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-native-publication-"));
	roots.push(root);
	for (const path of [
		executableName,
		"egress-addon/clawdi_egress_addon.py",
		"skills/clawdi/SKILL.md",
		"skills/hosted-versions/1/clawdi/SKILL.md",
		"skills/future-skill/SKILL.md",
	]) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), "fixture\n");
	}
	return root;
}

const nativePackager = resolve(import.meta.dir, "../scripts/package-native-release.mjs");

function packagePayload(root: string, outdir: string, target: NativeBuildTarget, bin: string) {
	const result = spawnSync(process.execPath, [nativePackager, root, outdir], {
		encoding: "utf8",
		env: {
			...process.env,
			CLAWDI_NATIVE_TARGET: target,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
		},
	});
	expect(result.status, result.stderr).toBe(0);
	return readFileSync(join(outdir, nativeAssetName(target)));
}

async function archiveEntries(archive: Buffer) {
	const entries: Array<{
		path: string;
		type: string;
		mode: number | undefined;
		uid: number | undefined;
		gid: number | undefined;
		mtime: Date | undefined;
	}> = [];
	await new Promise<void>((resolvePromise, reject) => {
		const stream = tar.list({
			strict: true,
			onReadEntry(entry) {
				entries.push({
					path: entry.path,
					type: entry.type,
					mode: entry.mode,
					uid: entry.uid,
					gid: entry.gid,
					mtime: entry.mtime,
				});
				entry.resume();
			},
		});
		stream.on("end", resolvePromise);
		stream.on("error", reject);
		stream.end(archive);
	});
	return entries;
}

describe("shared native release packaging", () => {
	test.each(["darwin-x64", "darwin-arm64"] as const)(
		"reproduces %s after extraction and changes only the signed payload",
		async (target) => {
			const root = payload();
			chmodSync(join(root, "clawdi"), 0o755);
			const bin = join(root, "bin");
			mkdirSync(bin);
			// Packaging must work even when the host tar cannot create archives.
			writeFileSync(join(bin, "tar"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
			const outdir = join(root, "release");
			const original = packagePayload(root, outdir, target, bin);
			const originalEntries = await archiveEntries(original);
			expect(originalEntries.map((entry) => entry.path)).toEqual([
				"clawdi",
				"egress-addon/clawdi_egress_addon.py",
				"skills/",
				"skills/clawdi/",
				"skills/clawdi/SKILL.md",
				"skills/future-skill/",
				"skills/future-skill/SKILL.md",
				"skills/hosted-versions/",
				"skills/hosted-versions/1/",
				"skills/hosted-versions/1/clawdi/",
				"skills/hosted-versions/1/clawdi/SKILL.md",
			]);
			for (const entry of originalEntries) {
				expect(entry.mode).toBe(
					entry.path === "clawdi" || entry.type === "Directory" ? 0o755 : 0o644,
				);
				expect(entry.uid).toBeUndefined();
				expect(entry.gid).toBeUndefined();
			}
			const stage = join(root, "stage");
			mkdirSync(stage);
			const extracted = spawnSync(
				"bash",
				[
					"-c",
					'umask 077; exec tar -xpzf "$1" -C "$2"',
					"extract",
					join(outdir, nativeAssetName(target)),
					stage,
				],
				{ encoding: "utf8" },
			);
			expect(extracted.status, extracted.stderr).toBe(0);
			for (const { path } of originalEntries) {
				utimesSync(join(stage, path), new Date("2020-01-01"), new Date("2021-01-01"));
			}
			expect(packagePayload(stage, outdir, target, bin)).toEqual(original);
			writeFileSync(join(stage, "clawdi"), "signed fixture\n");
			const signed = packagePayload(stage, outdir, target, bin);
			expect(signed).not.toEqual(original);
			expect(await archiveEntries(signed)).toEqual(originalEntries);
			expect(packagePayload(stage, outdir, target, bin)).toEqual(signed);
			const unpacked = join(root, "signed");
			mkdirSync(unpacked);
			await tar.extract({ file: join(outdir, nativeAssetName(target)), cwd: unpacked });
			for (const { path, type } of originalEntries) {
				if (type !== "File") continue;
				expect(readFileSync(join(unpacked, path), "utf8")).toBe(
					path === "clawdi" ? "signed fixture\n" : readFileSync(join(root, path), "utf8"),
				);
			}
		},
	);
});

async function archive(root: string, executableName = "clawdi"): Promise<Buffer> {
	const file = join(root, "artifact.tar.gz");
	await tar.create({ file, cwd: root, gzip: true }, [executableName, "egress-addon", "skills"]);
	return readFileSync(file);
}

describe("native publication inventory", () => {
	test("accepts Windows executable archives only with the selected executable name", async () => {
		const bytes = await archive(payload("clawdi.exe"), "clawdi.exe");
		expect(await validateNativePublicationArchive(bytes, "clawdi.exe")).toBeUndefined();
		await expect(validateNativePublicationArchive(bytes)).rejects.toThrow("unsafe entry");
		await expect(
			validateNativePublicationArchive(await archive(payload()), "clawdi.exe"),
		).rejects.toThrow("unsafe entry");
	});

	test("rejects missing Windows executables and unsafe Windows archive entries", async () => {
		const root = payload("clawdi.exe");
		const file = join(root, "missing-executable.tar.gz");
		await tar.create({ file, cwd: root, gzip: true }, ["egress-addon", "skills"]);
		await expect(
			validateNativePublicationArchive(readFileSync(file), "clawdi.exe"),
		).rejects.toThrow("native archive is missing clawdi.exe");
		rmSync(join(root, "clawdi.exe"));
		mkdirSync(join(root, "clawdi.exe"));
		writeFileSync(join(root, "clawdi.exe", "nested.exe"), "fixture");
		await expect(
			validateNativePublicationArchive(await archive(root, "clawdi.exe"), "clawdi.exe"),
		).rejects.toThrow("unexpected executable entry");
	});

	test("accepts required resources and additional intentional skill files", async () => {
		expect(await validateNativePublicationArchive(await archive(payload()))).toBeUndefined();
	});

	test("rejects Python caches without changing legacy installation compatibility", async () => {
		for (const path of [
			"egress-addon/__pycache__/cache.json",
			"egress-addon/addon.pyc",
			"skills/future-skill/cache.pyo",
		]) {
			const root = payload();
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), "cache\n");
			const bytes = await archive(root);
			expect(await validateNativeArchive(bytes)).toBeUndefined();
			await expect(validateNativePublicationArchive(bytes)).rejects.toThrow(
				"Python cache or bytecode",
			);
		}
	});

	test("retains the required addon source check", async () => {
		const root = payload();
		rmSync(join(root, "egress-addon", "clawdi_egress_addon.py"));
		await expect(validateNativePublicationArchive(await archive(root))).rejects.toThrow(
			"native archive is missing egress-addon/clawdi_egress_addon.py",
		);
	});
});

describe("native publication manifests", () => {
	test("generates only v2 with all supported targets and checksums", () => {
		const root = payload();
		for (const { target } of NATIVE_BUILD_TARGET_CATALOG) {
			writeFileSync(join(root, nativeAssetName(target)), `fixture ${target}\n`);
		}
		writeNativeReleaseManifest(root, "1.2.3");
		expect(existsSync(join(root, "clawdi-cli-manifest.txt"))).toBe(false);
		const v2 = readFileSync(join(root, NATIVE_RELEASE_MANIFEST_V2_NAME), "utf8");
		const parsed = parseNativeReleaseManifestV2(v2);
		expect(parsed.artifacts).toHaveLength(8);
		for (const { asset, sha256 } of parsed.artifacts) {
			expect(sha256).toBe(
				createHash("sha256")
					.update(readFileSync(join(root, asset)))
					.digest("hex"),
			);
		}
	});

	test("checks the v2 manifest, target matrix, version and Windows checksums", async () => {
		const root = await releaseFixture();
		const check = () =>
			spawnSync(
				process.execPath,
				[resolve(import.meta.dir, "../scripts/check-native-release.mjs"), root, "1.2.3"],
				{ encoding: "utf8" },
			);
		const valid = check();
		expect(valid.status, valid.stderr).toBe(0);
		expect(valid.stdout).toContain("v2: 8 targets");
		const v2Path = join(root, NATIVE_RELEASE_MANIFEST_V2_NAME);
		const v2 = readFileSync(v2Path, "utf8");
		rmSync(v2Path);
		expect(check().status).not.toBe(0);
		writeFileSync(v2Path, v2.replace("version\t1.2.3", "version\t1.2.4"));
		expect(check().stderr).toContain("native release version mismatch");
		writeFileSync(v2Path, v2.replace("artifact\twin32-arm64\t", "artifact\tunknown\t"));
		expect(check().stderr).toContain("supported target matrix");
		writeFileSync(v2Path, `${v2}artifact\tfreebsd-x64\tfuture\tunknown\n`);
		expect(check().stderr).toContain("supported target matrix");
		writeFileSync(v2Path, v2);
		writeFileSync(join(root, nativeAssetName("win32-arm64")), "corrupted archive");
		expect(check().stderr).toContain("checksum mismatch for clawdi-cli-win32-arm64.tar.gz");
	});

	test("the Unix installer accepts a release publishing only v2", async () => {
		const root = await releaseFixture();
		const home = join(root, "home");
		mkdirSync(home);
		const result = runNativeInstaller({
			fixture: { directory: root, version: "1.2.3", target: "linux-x64" },
			prefix: join(root, "prefix"),
			home,
			clawdiHome: join(root, "clawdi-home"),
			testRoot: root,
		});
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("Installing clawdi v1.2.3 for linux-x64");
		expect(result.curlLog).toContain(NATIVE_RELEASE_MANIFEST_V2_NAME);
		expect(result.curlLog).not.toContain("/clawdi-cli-manifest.txt");
	});
});

async function releaseFixture(): Promise<string> {
	const root = payload();
	writeFileSync(
		join(root, "clawdi"),
		`#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '1.2.3\\n'
else
  printf '1.2.3\\tlinux-x64\\n'
fi
`,
	);
	chmodSync(join(root, "clawdi"), 0o755);
	const unixArchive = await archive(root);
	const windowsArchive = await archive(payload("clawdi.exe"), "clawdi.exe");
	for (const { target } of NATIVE_BUILD_TARGET_CATALOG) {
		writeFileSync(
			join(root, nativeAssetName(target)),
			target.startsWith("win32-") ? windowsArchive : unixArchive,
		);
	}
	writeNativeReleaseManifest(root, "1.2.3");
	return root;
}
