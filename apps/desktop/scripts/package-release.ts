import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
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
await run("bun", desktopReleaseBuilderArgs(configuration));
await verifyReleaseSignature();
await verifyReleaseArtifacts(configuration.version);

async function verifyReleaseSignature(): Promise<void> {
	const appBundle = join(releaseRoot, "mac-arm64", "Clawdi.app");
	const executable = join(appBundle, "Contents", "MacOS", "Clawdi");
	const cli = join(appBundle, "Contents", "Resources", "native", "clawdi");
	await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appBundle]);
	await run("codesign", ["--verify", "--strict", "--verbose=2", cli]);
	await run("xcrun", ["stapler", "validate", appBundle]);
	await run("spctl", ["--assess", "--type", "execute", "--verbose=4", appBundle]);
	await run(cli, ["update", "--native-identity"]);
	const signature = await readMacCodeSignature(executable);
	const policy = evaluateDesktopUpdatePolicy({
		isPackaged: true,
		platform: "darwin",
		isMacAppStore: false,
		channel: "stable",
		feedUrl: configuration.updateFeedUrl,
		signature: existsSync(executable) ? signature : null,
	});
	if (!policy.enabled) {
		throw new Error("Desktop release must have a Developer ID Application signature and Team ID.");
	}
}

async function verifyReleaseArtifacts(version: string): Promise<void> {
	const files = readdirSync(releaseRoot);
	const dmg = files.filter((file) => file.endsWith(".dmg") && file.includes(version));
	const zip = files.filter((file) => file.endsWith(".zip") && file.includes(version));
	const metadataPath = join(releaseRoot, "latest-mac.yml");
	if (dmg.length !== 1 || zip.length !== 1 || !existsSync(metadataPath)) {
		throw new Error("Desktop release must produce one DMG, one ZIP, and latest-mac.yml.");
	}
	const zipName = zip[0];
	if (!zipName) throw new Error("Desktop release ZIP is missing.");
	const metadata = parse(readFileSync(metadataPath, "utf8"));
	if (!isRecord(metadata) || metadata.version !== version || !Array.isArray(metadata.files)) {
		throw new Error("latest-mac.yml has an invalid Desktop update structure.");
	}
	const file = metadata.files.find(
		(value) => isRecord(value) && value.url === zipName && typeof value.sha512 === "string",
	);
	if (!isRecord(file) || typeof file.sha512 !== "string") {
		throw new Error("latest-mac.yml does not describe the signed ZIP release artifact.");
	}
	const sha512 = createHash("sha512")
		.update(readFileSync(join(releaseRoot, zipName)))
		.digest("base64");
	if (file.sha512 !== sha512) throw new Error("latest-mac.yml ZIP checksum does not match.");
	const dmgPath = join(releaseRoot, dmg[0] ?? "");
	await run("xcrun", ["stapler", "validate", dmgPath]);
	await run("spctl", [
		"--assess",
		"--type",
		"open",
		"--context",
		"context:primary-signature",
		"--verbose=4",
		dmgPath,
	]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
