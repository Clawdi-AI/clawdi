import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectNativeInstall,
	NATIVE_INSTALL_IDENTITY_NAME,
	writeNativeInstallIdentity,
} from "./native-distribution";
import { NATIVE_BUILD_TARGET_CATALOG, nativeAssetName } from "./native-release-manifest";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

(process.platform === "win32" ? describe.skip : describe)("native install ownership", () => {
	it("requires the strict activation-written identity in addition to the layout", () => {
		const prefix = mkdtempSync(join(tmpdir(), "clawdi-native-identity-"));
		roots.push(prefix);
		const identity = { version: "1.2.3", target: "linux-x64" as const };
		const versionDir = join(prefix, "share", "clawdi", "versions", "1.2.3-linux-x64");
		const executable = join(versionDir, "clawdi");
		const manifest = nativeManifest(identity.version);
		mkdirSync(join(versionDir, "egress-addon"), { recursive: true });
		mkdirSync(join(versionDir, "skills", "clawdi"), { recursive: true });
		mkdirSync(join(prefix, "bin"), { recursive: true });
		writeFileSync(executable, "native\n");
		writeFileSync(join(versionDir, "egress-addon", "clawdi_egress_addon.py"), "addon\n");
		writeFileSync(join(versionDir, "skills", "clawdi", "SKILL.md"), "# skill\n");
		writeFileSync(join(versionDir, "clawdi-cli-manifest-v2.txt"), manifest);
		symlinkSync("../share/clawdi/versions/1.2.3-linux-x64/clawdi", join(prefix, "bin", "clawdi"));

		expect(detectNativeInstall(executable, identity)).toBeNull();
		writeNativeInstallIdentity(versionDir, identity, manifest);
		expect(detectNativeInstall(executable, identity)?.launcher).toBe(join(prefix, "bin", "clawdi"));

		rmSync(join(versionDir, "clawdi-cli-manifest-v2.txt"));
		writeFileSync(
			join(versionDir, "clawdi-cli-manifest.txt"),
			manifest.replace("clawdi.nativeRelease.v2", "clawdi.nativeRelease.v1"),
		);
		expect(detectNativeInstall(executable, identity)).toBeNull();
		writeFileSync(join(versionDir, "clawdi-cli-manifest-v2.txt"), manifest);

		writeFileSync(join(versionDir, NATIVE_INSTALL_IDENTITY_NAME), "clawdi.nativeInstall.v1\n");
		expect(detectNativeInstall(executable, identity)).toBeNull();
	});
});

function nativeManifest(version: string): string {
	return [
		"clawdi.nativeRelease.v2",
		`version\t${version}`,
		...NATIVE_BUILD_TARGET_CATALOG.map(
			({ target }, index) =>
				`artifact\t${target}\t${nativeAssetName(target)}\t${String(index).repeat(64)}`,
		),
		"",
	].join("\n");
}

describe("Windows native install ownership", () => {
	it("requires a v2 marker and a junction to the exact running version directory", () => {
		const prefix = realpathSync.native(mkdtempSync(join(tmpdir(), "clawdi-windows-identity-")));
		roots.push(prefix);
		const identity = { version: "1.2.3", target: "win32-x64" as const };
		const root = join(prefix, "share", "clawdi");
		const versionDir = join(root, "versions", "1.2.3-win32-x64");
		const current = join(root, "current");
		const executable = join(versionDir, "clawdi.exe");
		mkdirSync(join(versionDir, "egress-addon"), { recursive: true });
		mkdirSync(join(versionDir, "skills", "clawdi"), { recursive: true });
		writeFileSync(executable, "native\n");
		writeFileSync(join(versionDir, "egress-addon", "clawdi_egress_addon.py"), "addon\n");
		writeFileSync(join(versionDir, "skills", "clawdi", "SKILL.md"), "# skill\n");
		const manifest = [
			"clawdi.nativeRelease.v2",
			`version\t${identity.version}`,
			...NATIVE_BUILD_TARGET_CATALOG.map(
				({ target }, index) =>
					`artifact\t${target}\t${nativeAssetName(target)}\t${String(index).repeat(64)}`,
			),
			"",
		].join("\n");
		writeFileSync(join(versionDir, "clawdi-cli-manifest-v2.txt"), manifest);
		writeNativeInstallIdentity(versionDir, identity, manifest);
		expect(detectNativeInstall(executable, identity, "win32")).toBeNull();
		symlinkSync(versionDir, current, "junction");
		expect(realpathSync.native(current)).toBe(realpathSync.native(versionDir));
		expect(detectNativeInstall(join(current, "clawdi.exe"), identity, "win32")?.launcher).toBe(
			join(current, "clawdi.exe"),
		);
		expect(detectNativeInstall(executable, identity, "linux")).toBeNull();
		expect(
			detectNativeInstall(executable, { ...identity, target: "win32-arm64" }, "win32"),
		).toBeNull();
		rmSync(current, { recursive: true, force: true });
		const other = join(root, "versions", "1.2.4-win32-x64");
		mkdirSync(other);
		symlinkSync(other, current, "junction");
		expect(detectNativeInstall(executable, identity, "win32")).toBeNull();
		rmSync(current, { recursive: true, force: true });
		mkdirSync(current);
		expect(detectNativeInstall(executable, identity, "win32")).toBeNull();
		rmSync(join(versionDir, "clawdi-cli-manifest-v2.txt"));
		writeFileSync(
			join(versionDir, "clawdi-cli-manifest.txt"),
			nativeManifest(identity.version).replace(
				"clawdi.nativeRelease.v2",
				"clawdi.nativeRelease.v1",
			),
		);
		expect(detectNativeInstall(executable, identity, "win32")).toBeNull();
	});
});
