import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectNativeInstall,
	NATIVE_INSTALL_IDENTITY_NAME,
	writeNativeInstallIdentity,
} from "./native-distribution";
import { NATIVE_TARGETS, type NativeTarget, nativeAssetName } from "./native-release-manifest";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native install ownership", () => {
	it("requires the strict activation-written identity in addition to the layout", () => {
		const prefix = mkdtempSync(join(tmpdir(), "clawdi-native-identity-"));
		roots.push(prefix);
		const identity = { version: "1.2.3", target: "linux-x64" as const };
		const versionDir = join(prefix, "share", "clawdi", "versions", "1.2.3-linux-x64");
		const executable = join(versionDir, "clawdi");
		const manifest = nativeManifest(identity.version);
		mkdirSync(join(versionDir, "egress-addon"), { recursive: true });
		mkdirSync(join(versionDir, "skills", "clawdi"), { recursive: true });
		mkdirSync(join(versionDir, "runtime-adapters", "whatsapp", "openclaw"), { recursive: true });
		mkdirSync(join(versionDir, "runtime-adapters", "whatsapp", "hermes"), { recursive: true });
		mkdirSync(join(prefix, "bin"), { recursive: true });
		writeFileSync(executable, "native\n");
		writeFileSync(join(versionDir, "egress-addon", "clawdi_egress_addon.py"), "addon\n");
		writeFileSync(join(versionDir, "skills", "clawdi", "SKILL.md"), "# skill\n");
		writeFileSync(
			join(versionDir, "runtime-adapters", "whatsapp", "openclaw", "openclaw.plugin.json"),
			"{}\n",
		);
		writeFileSync(
			join(versionDir, "runtime-adapters", "whatsapp", "hermes", "plugin.yaml"),
			"name: test\n",
		);
		writeFileSync(join(versionDir, "clawdi-cli-manifest.txt"), manifest);
		symlinkSync("../share/clawdi/versions/1.2.3-linux-x64/clawdi", join(prefix, "bin", "clawdi"));

		expect(detectNativeInstall(executable, identity)).toBeNull();
		writeNativeInstallIdentity(versionDir, identity, manifest);
		expect(detectNativeInstall(executable, identity)?.launcher).toBe(join(prefix, "bin", "clawdi"));

		writeFileSync(join(versionDir, NATIVE_INSTALL_IDENTITY_NAME), "clawdi.nativeInstall.v1\n");
		expect(detectNativeInstall(executable, identity)).toBeNull();
	});
});

function nativeManifest(version: string): string {
	return [
		"clawdi.nativeRelease.v1",
		`version\t${version}`,
		...NATIVE_TARGETS.map(
			(target: NativeTarget, index) =>
				`artifact\t${target}\t${nativeAssetName(target)}\t${String(index).repeat(64)}`,
		),
		"",
	].join("\n");
}
