import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	desktopReleaseBuilderArgs,
	readDesktopReleaseConfiguration,
} from "../src/release-contract";
import { evaluateDesktopUpdatePolicy } from "../src/update-policy";
import { readMacCodeSignature } from "../src/update-signature";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(desktopRoot, "release");
const configuration = readDesktopReleaseConfiguration(process.env, process.platform);

rmSync(releaseRoot, { recursive: true, force: true });
await run("bun", ["run", "build"]);
await run("bun", ["run", "prepare:native"], { CLAWDI_NATIVE_TARGET: "darwin-arm64" });
await run("bun", desktopReleaseBuilderArgs(configuration.version));
await verifyReleaseSignature();
verifyReleaseArtifacts(configuration.version);

async function verifyReleaseSignature(): Promise<void> {
	const executable = join(releaseRoot, "mac-arm64", "Clawdi.app", "Contents", "MacOS", "Clawdi");
	const policy = evaluateDesktopUpdatePolicy({
		isPackaged: true,
		platform: "darwin",
		isMacAppStore: false,
		channel: "stable",
		signature: existsSync(executable) ? await readMacCodeSignature(executable) : null,
	});
	if (!policy.enabled) {
		throw new Error("Desktop release must have a Developer ID Application signature and Team ID.");
	}
}

function verifyReleaseArtifacts(version: string): void {
	const files = readdirSync(releaseRoot);
	const dmg = files.filter((file) => file.endsWith(".dmg") && file.includes(version));
	const zip = files.filter((file) => file.endsWith(".zip") && file.includes(version));
	const metadataPath = join(releaseRoot, "latest-mac.yml");
	if (dmg.length !== 1 || zip.length !== 1 || !existsSync(metadataPath)) {
		throw new Error("Desktop release must produce one DMG, one ZIP, and latest-mac.yml.");
	}
	const metadata = readFileSync(metadataPath, "utf8");
	if (!metadata.includes(`version: ${version}`) || !metadata.includes(zip[0] ?? "\0")) {
		throw new Error("latest-mac.yml does not describe the signed ZIP release artifact.");
	}
}

async function run(
	command: string,
	args: string[],
	extraEnv: Record<string, string> = {},
): Promise<void> {
	const child = Bun.spawn([command, ...args], {
		cwd: desktopRoot,
		env: { ...process.env, ...extraEnv },
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(`${command} failed with exit ${exitCode}.`);
}
