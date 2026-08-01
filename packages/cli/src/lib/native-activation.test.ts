import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	activateNativeLauncherTransaction,
	downloadAndStageNativeRelease,
	validateNativeArchive,
} from "./native-activation";
import type { PrivateDirectoryLockLease } from "./private-directory-lock";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native archive safety", () => {
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

describe("native launcher transaction", () => {
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
	mkdirSync(join(root, "skills", "hosted-versions", "2", "clawdi"), { recursive: true });
	writeFileSync(join(root, "clawdi"), "native\n");
	writeFileSync(join(root, "egress-addon", "clawdi_egress_addon.py"), "addon\n");
	writeFileSync(join(root, "skills", "clawdi", "SKILL.md"), "# skill\n");
	writeFileSync(join(root, "skills", "hosted-versions", "1", "clawdi", "SKILL.md"), "# hosted\n");
	writeFileSync(join(root, "skills", "hosted-versions", "2", "clawdi", "SKILL.md"), "# hosted\n");
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
