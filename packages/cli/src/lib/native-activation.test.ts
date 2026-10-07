import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import {
	activateNativeLauncherTransaction,
	downloadAndStageNativeRelease,
	renameNativeDirectory,
	validateNativeArchive,
} from "./native-activation";
import type { NativeCompiledIdentity } from "./native-distribution";
import { NATIVE_PUBLISH_TARGET_CATALOG, nativeAssetName } from "./native-release-manifest";
import type { PrivateDirectoryLockLease } from "./private-directory-lock";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native directory rename retries", () => {
	it("retries Windows handle errors with backoff and lease checks until success", () => {
		const codes = ["EPERM", "EACCES", "EBUSY"];
		let attempts = 0;
		let elapsed = 0;
		let fences = 0;
		const sleeps: number[] = [];
		renameNativeDirectory(
			"stage",
			"final",
			{
				token: "test",
				assertOwned: () => {
					fences += 1;
				},
			},
			{
				platform: "win32",
				now: () => elapsed,
				sleep: (milliseconds) => {
					sleeps.push(milliseconds);
					elapsed += milliseconds;
				},
				rename: (from, to) => {
					expect([from, to]).toEqual(["stage", "final"]);
					expect(fences).toBe(attempts);
					const code = codes[attempts++];
					if (code) throw Object.assign(new Error("handle is busy"), { code });
				},
			},
		);
		expect(attempts).toBe(4);
		expect(sleeps).toEqual([10, 20, 30]);
	});

	it("gives up after ten seconds and rethrows the last rename error", () => {
		let elapsed = 0;
		let attempts = 0;
		let lastError: Error | undefined;
		let failure: unknown;
		try {
			renameNativeDirectory(
				"stage",
				"final",
				{ token: "test", assertOwned: () => undefined },
				{
					platform: "win32",
					now: () => elapsed,
					sleep: (milliseconds) => {
						expect(milliseconds).toBeGreaterThan(0);
						expect(milliseconds).toBeLessThanOrEqual(100);
						elapsed += milliseconds;
					},
					rename: () => {
						lastError = Object.assign(new Error(`blocked attempt ${++attempts}`), {
							code: "EPERM",
						});
						throw lastError;
					},
				},
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBe(lastError);
		expect(attempts).toBeGreaterThan(1);
		expect(elapsed).toBe(10_000);
	});

	for (const [platform, code] of [
		["win32", "ENOENT"],
		["linux", "EPERM"],
		["darwin", "EACCES"],
	] as const) {
		it(`does not retry ${code} on ${platform}`, () => {
			let attempts = 0;
			let sleeps = 0;
			let fences = 0;
			const error = Object.assign(new Error("rename failed"), { code });
			expect(() =>
				renameNativeDirectory(
					"stage",
					"final",
					{
						token: "test",
						assertOwned: () => {
							fences += 1;
						},
					},
					{
						platform,
						rename: () => {
							attempts += 1;
							throw error;
						},
						sleep: () => {
							sleeps += 1;
						},
					},
				),
			).toThrow(error);
			expect(attempts).toBe(1);
			expect(sleeps).toBe(0);
			expect(fences).toBe(0);
		});
	}

	it("stops before retrying when the lease is lost during backoff", () => {
		let attempts = 0;
		expect(() =>
			renameNativeDirectory(
				"stage",
				"final",
				{
					token: "test",
					assertOwned: () => {
						throw new Error("lease lost");
					},
				},
				{
					platform: "win32",
					sleep: () => undefined,
					rename: () => {
						attempts += 1;
						throw Object.assign(new Error("handle is busy"), { code: "EBUSY" });
					},
				},
			),
		).toThrow("lease lost");
		expect(attempts).toBe(1);
	});
});

(process.platform === "win32" ? describe.skip : describe)("native archive safety", () => {
	it("accepts the exact native resource roots", async () => {
		expect(await validateNativeArchive(buildArchive())).toBeUndefined();
	});

	it("rejects duplicate archive paths", async () => {
		const root = fixtureRoot();
		const tarPath = join(root, "duplicate.tar");
		run("tar", ["-cf", tarPath, "-C", root, "clawdi", "egress-addon", "skills"]);
		run("tar", ["-rf", tarPath, "-C", root, "clawdi"]);
		const compressed = spawnSync("gzip", ["-c", tarPath]);
		if (compressed.status !== 0 || !compressed.stdout) throw new Error("gzip fixture failed");
		await expect(validateNativeArchive(compressed.stdout)).rejects.toThrow("duplicate entry");
	});

	it("rejects symlinks before extraction", async () => {
		const root = fixtureRoot();
		symlinkSync("clawdi_egress_addon.py", join(root, "egress-addon", "linked.py"));
		await expect(validateNativeArchive(buildArchive(root))).rejects.toThrow("unsafe entry");
	});

	it("rejects a small gzip whose file declares more than the per-entry limit", async () => {
		const root = fixtureRoot();
		truncateSync(join(root, "clawdi"), 200 * 1024 * 1024 + 1);
		const archive = buildArchive(root);
		expect(archive.byteLength).toBeLessThan(2 * 1024 * 1024);
		await expect(validateNativeArchive(archive)).rejects.toThrow("entry exceeds the size limit");
	});
});

describe("native release download bounds", () => {
	it("does not call fetch when the parent signal is already aborted", async () => {
		const abort = new AbortController();
		abort.abort(new Error("already stopped"));
		let calls = 0;
		await expect(
			downloadAndStageNativeRelease({
				prefix: fixtureRoot(),
				version: "1.2.3",
				target: "linux-x64",
				releaseBaseUrl: "https://example.invalid/exact",
				signal: abort.signal,
				fetcher: testFetcher(async () => {
					calls += 1;
					return new Response();
				}),
			}),
		).rejects.toThrow("already stopped");
		expect(calls).toBe(0);
	});
});

(process.platform === "win32" ? describe.skip : describe)("native launcher transaction", () => {
	it("restores and revalidates the previous launcher after the new smoke fails", () => {
		const root = fixtureRoot();
		const previous = join(root, "previous-clawdi");
		const active = join(root, "active-clawdi");
		const launcher = join(root, "launcher");
		writeFileSync(previous, "#!/bin/sh\nprintf '1.2.3\\tlinux-x64\\n'\n", { mode: 0o755 });
		writeFileSync(active, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		symlinkSync(previous, launcher);
		let fences = 0;
		const lease: PrivateDirectoryLockLease = {
			token: "test",
			assertOwned: () => {
				fences += 1;
			},
		};

		expect(() =>
			activateNativeLauncherTransaction(
				{
					launcher,
					active: { executable: active, version: "1.2.4", target: "linux-x64" },
					previous: { executable: previous, version: "1.2.3", target: "linux-x64" },
				},
				lease,
			),
		).toThrow("activated native launcher failed version verification");
		expect(realpathSync(launcher)).toBe(realpathSync(previous));
		expect(fences).toBe(2);
	});

	it("reports when the restored previous executable also fails smoke", () => {
		const root = fixtureRoot();
		const previous = join(root, "previous-clawdi");
		const active = join(root, "active-clawdi");
		const launcher = join(root, "launcher");
		writeFileSync(previous, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		writeFileSync(active, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		symlinkSync(previous, launcher);
		const lease: PrivateDirectoryLockLease = { token: "test", assertOwned: () => undefined };

		expect(() =>
			activateNativeLauncherTransaction(
				{
					launcher,
					active: { executable: active, version: "1.2.4", target: "linux-x64" },
					previous: { executable: previous, version: "1.2.3", target: "linux-x64" },
				},
				lease,
			),
		).toThrow("rollback verification also failed");
		expect(realpathSync(launcher)).toBe(realpathSync(previous));
	});
});

function buildArchive(root = fixtureRoot()): Buffer {
	const archive = join(root, "native.tar.gz");
	run("tar", ["-czf", archive, "-C", root, "clawdi", "egress-addon", "skills"]);
	return readFileSync(archive);
}

function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-native-archive-"));
	roots.push(root);
	mkdirSync(join(root, "egress-addon"), { recursive: true });
	mkdirSync(join(root, "skills", "clawdi"), { recursive: true });
	mkdirSync(join(root, "skills", "hosted-versions", "1", "clawdi"), { recursive: true });
	writeFileSync(join(root, "clawdi"), "native\n");
	writeFileSync(join(root, "egress-addon", "clawdi_egress_addon.py"), "addon\n");
	writeFileSync(join(root, "skills", "clawdi", "SKILL.md"), "# skill\n");
	writeFileSync(join(root, "skills", "hosted-versions", "1", "clawdi", "SKILL.md"), "# hosted\n");
	return root;
}

function run(command: string, args: string[]): void {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
}

function testFetcher(
	implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
	return Object.assign(implementation, { preconnect: fetch.preconnect });
}

describe("Windows native launcher transaction", () => {
	for (const failed of [false, true]) {
		it(
			failed
				? "restores the previous junction after failed smoke"
				: "swaps a real junction and removes its backup after verification",
			() => {
				const root = fixtureRoot();
				const previousDir = join(root, "previous");
				const activeDir = join(root, "active");
				const launcher = join(root, "current");
				mkdirSync(previousDir);
				mkdirSync(activeDir);
				const previous = {
					version: "1.2.3",
					target: "win32-x64" as const,
					executable: join(previousDir, "clawdi.exe"),
				};
				const active = {
					version: "1.2.4",
					target: "win32-x64" as const,
					executable: join(activeDir, "clawdi.exe"),
				};
				writeFileSync(previous.executable, "1.2.3");
				writeFileSync(active.executable, failed ? "invalid" : "1.2.4");
				symlinkSync(previousDir, launcher, "junction");
				const seen: string[] = [];
				const readIdentity = (command: string): NativeCompiledIdentity | null => {
					seen.push(realpathSync.native(command));
					const version = readFileSync(command, "utf8");
					return version === "invalid" ? null : { version, target: "win32-x64" };
				};
				const activate = () =>
					activateNativeLauncherTransaction(
						{ launcher, previous, active },
						{ token: "test", assertOwned: () => undefined },
						{ platform: "win32", readIdentity },
					);
				if (failed) expect(activate).toThrow("failed version verification");
				else activate();
				expect(realpathSync.native(launcher)).toBe(
					realpathSync.native(failed ? previousDir : activeDir),
				);
				expect(seen).toEqual(
					failed
						? [realpathSync.native(active.executable), realpathSync.native(previous.executable)]
						: [realpathSync.native(active.executable)],
				);
				expect(readdirSync(root).some((entry) => entry.startsWith("current.old-"))).toBeFalse();
				expect(existsSync(previous.executable)).toBeTrue();
			},
		);
	}
	it("removes a failed first-install junction without deleting its target", () => {
		const root = fixtureRoot();
		const launcher = join(root, "current");
		expect(() =>
			activateNativeLauncherTransaction(
				{
					launcher,
					previous: null,
					active: { version: "1.2.3", target: "win32-arm64", executable: join(root, "clawdi.exe") },
				},
				{ token: "test", assertOwned: () => undefined },
				{ platform: "win32", readIdentity: () => null },
			),
		).toThrow("failed version verification");
		expect(existsSync(launcher)).toBeFalse();
		expect(existsSync(join(root, "skills"))).toBeTrue();
	});
});

describe("native release staging", () => {
	it.each(["win32-x64", "linux-x64"] as const)(
		"requests v2 for %s and tolerates future manifest rows",
		async (target) => {
			const executable = target.startsWith("win32-") ? "clawdi.exe" : "clawdi";
			const root = fixtureRoot();
			writeFileSync(join(root, executable), "native fixture\n");
			const archivePath = join(root, "native.tar.gz");
			tar.create({ file: archivePath, cwd: root, gzip: true, sync: true }, [
				executable,
				"egress-addon",
				"skills",
			]);
			const archive = readFileSync(archivePath);
			const manifest = [
				"clawdi.nativeRelease.v2",
				"version\t1.2.3",
				...NATIVE_PUBLISH_TARGET_CATALOG.map(
					({ target }) =>
						`artifact\t${target}\t${nativeAssetName(target)}\t${new Bun.CryptoHasher("sha256").update(archive).digest("hex")}`,
				),
				"metadata\tfuture",
				"artifact\tfreebsd-x64\tfuture\tunknown",
				"",
			].join("\n");
			const urls: string[] = [];
			const staged = await downloadAndStageNativeRelease({
				prefix: root,
				version: "1.2.3",
				target,
				releaseBaseUrl: "https://example.invalid/exact",
				fetcher: testFetcher(async (url) => {
					urls.push(String(url));
					return new Response(String(url).endsWith(".txt") ? manifest : archive);
				}),
			});
			expect(urls).toEqual([
				"https://example.invalid/exact/clawdi-cli-manifest-v2.txt",
				`https://example.invalid/exact/${nativeAssetName(target)}`,
			]);
			expect(readFileSync(join(staged.stageDir, executable), "utf8")).toBe("native fixture\n");
			expect(readFileSync(join(staged.stageDir, "clawdi-cli-manifest-v2.txt"), "utf8")).toBe(
				manifest,
			);
			expect(
				existsSync(join(staged.stageDir, executable === "clawdi" ? "clawdi.exe" : "clawdi")),
			).toBeFalse();
		},
	);
});
