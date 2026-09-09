import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
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
await run("bun", ["run", "prepare:native"], {
	CLAWDI_NATIVE_TARGET: `darwin-${configuration.arch}`,
});
await run("bun", desktopReleaseBuilderArgs(configuration));
await verifyReleaseSignature();
await verifyReleaseArtifacts(configuration.version);

async function verifyReleaseSignature(): Promise<void> {
	const appBundle = join(
		releaseRoot,
		configuration.arch === "arm64" ? "mac-arm64" : "mac",
		"Clawdi.app",
	);
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
		channel: configuration.channel,
		feedUrl: configuration.updateFeedUrl,
		signature: existsSync(executable) ? signature : null,
	});
	if (!policy.enabled) {
		throw new Error("Desktop release must have a valid Developer ID Application signature.");
	}
}

async function verifyReleaseArtifacts(version: string): Promise<void> {
	const files = readdirSync(releaseRoot);
	const dmg = files.filter((file) => file.endsWith(".dmg") && file.includes(version));
	const zip = files.filter((file) => file.endsWith(".zip") && file.includes(version));
	const metadataPath = join(
		releaseRoot,
		configuration.channel === "stable" ? "latest-mac.yml" : "beta-mac.yml",
	);
	if (dmg.length !== 1 || zip.length !== 1 || !existsSync(metadataPath)) {
		throw new Error("Desktop release must produce one DMG, one ZIP, and channel update metadata.");
	}
	const zipName = zip[0];
	if (!zipName) throw new Error("Desktop release ZIP is missing.");
	const metadata = parse(readFileSync(metadataPath, "utf8"));
	if (!isRecord(metadata) || metadata.version !== version || !Array.isArray(metadata.files)) {
		throw new Error("Channel metadata has an invalid Desktop update structure.");
	}
	const file = metadata.files.find(
		(value) => isRecord(value) && value.url === zipName && typeof value.sha512 === "string",
	);
	if (!isRecord(file) || typeof file.sha512 !== "string") {
		throw new Error("Channel metadata does not describe the signed ZIP release artifact.");
	}
	const sha512 = createHash("sha512")
		.update(readFileSync(join(releaseRoot, zipName)))
		.digest("base64");
	if (file.sha512 !== sha512) throw new Error("Channel metadata ZIP checksum does not match.");
	const dmgPath = join(releaseRoot, dmg[0] ?? "");
	await run("codesign", ["--verify", "--strict", dmgPath]);
	await run("xcrun", [
		"notarytool",
		"submit",
		dmgPath,
		"--wait",
		"--timeout",
		"30m",
		"--key",
		process.env.APPLE_API_KEY ?? "",
		"--key-id",
		process.env.APPLE_API_KEY_ID ?? "",
		"--issuer",
		process.env.APPLE_API_ISSUER ?? "",
	]);
	await run("xcrun", ["stapler", "staple", dmgPath]);
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
	// Stapling changes DMG bytes after electron-builder generated the update metadata.
	for (const entry of metadata.files) {
		if (
			!isRecord(entry) ||
			typeof entry.url !== "string" ||
			![...dmg, ...zip].includes(entry.url)
		) {
			throw new Error("Update metadata references an unexpected artifact.");
		}
		const bytes = readFileSync(join(releaseRoot, entry.url));
		entry.sha512 = createHash("sha512").update(bytes).digest("base64");
		entry.size = bytes.length;
	}
	writeFileSync(metadataPath, stringify(metadata));
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
