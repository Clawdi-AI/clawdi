import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeNativeInstallIdentity } from "../../../../packages/cli/src/lib/native-distribution";
import {
	nativeAssetName,
	nativeBuildTargetForPlatform,
} from "../../../../packages/cli/src/lib/native-release-manifest";

/** Fake release metadata for resolver tests; never used as a real release. */
export function writeFixtureNativeMetadata(directory: string, version: string): void {
	const target = nativeBuildTargetForPlatform();
	if (!target) throw new Error("Unsupported native CLI fixture target.");
	const manifest = `clawdi.nativeRelease.v2\nversion\t${version}\nartifact\t${target}\t${nativeAssetName(target)}\t${"a".repeat(64)}\n`;
	mkdirSync(join(directory, "skills", "clawdi"), { recursive: true });
	mkdirSync(join(directory, "egress-addon"), { recursive: true });
	writeFileSync(join(directory, "skills", "clawdi", "SKILL.md"), "# Fixture\n");
	writeFileSync(join(directory, "egress-addon", "clawdi_egress_addon.py"), "# Fixture\n");
	writeFileSync(join(directory, "clawdi-cli-manifest-v2.txt"), manifest);
	writeNativeInstallIdentity(directory, { version, target }, manifest);
}
