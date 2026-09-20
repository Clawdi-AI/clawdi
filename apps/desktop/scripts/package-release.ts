import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import {
	desktopReleaseBuilderArgs,
	readDesktopReleaseConfiguration,
} from "../src/release-contract";
import { standardUpdateMetadataName } from "../src/update-metadata";
import { evaluateDesktopUpdatePolicy } from "../src/update-policy";
import { readMacCodeSignature } from "../src/update-signature";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(desktopRoot, "release");
const configuration = readDesktopReleaseConfiguration(process.env, process.platform);
const signedWindows = configuration.platform === "win32" && Boolean(configuration.windowsPublisher);

rmSync(releaseRoot, { recursive: true, force: true });
await run("bun", ["run", "build"]);
await run("bun", ["run", "prepare:native"], {
	CLAWDI_NATIVE_TARGET: `${configuration.platform}-${configuration.arch}`,
});
await run("bun", [
	...desktopReleaseBuilderArgs(configuration),
	`--config.afterPack=${join(desktopRoot, "scripts/after-pack.mjs")}`,
]);
verifyPackagedUpdateConfiguration();
if (configuration.platform === "darwin") {
	await verifyReleaseSignature();
	await verifyReleaseArtifacts(configuration.version);
} else {
	await verifyPlatformArtifacts();
}

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
		standardUpdateMetadataName(configuration.platform, configuration.arch, configuration.channel),
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

async function verifyPlatformArtifacts(): Promise<void> {
	const files = readdirSync(releaseRoot);
	const windows = configuration.platform === "win32";
	if (!windows || signedWindows) {
		const metadata = parse(
			readFileSync(
				join(
					releaseRoot,
					standardUpdateMetadataName(
						configuration.platform,
						configuration.arch,
						configuration.channel,
					),
				),
				"utf8",
			),
		);
		if (
			!isRecord(metadata) ||
			metadata.version !== configuration.version ||
			!Array.isArray(metadata.files) ||
			!metadata.files.length
		)
			throw new Error("Invalid update metadata.");
		if (
			!windows &&
			(metadata.files.length !== 1 ||
				!isRecord(metadata.files[0]) ||
				typeof metadata.files[0].url !== "string" ||
				!metadata.files[0].url.endsWith(".AppImage"))
		) {
			throw new Error("Linux update metadata must contain only the AppImage.");
		}
		for (const entry of metadata.files) {
			if (!isRecord(entry) || typeof entry.url !== "string" || !files.includes(entry.url))
				throw new Error("Missing update artifact.");
			const bytes = readFileSync(join(releaseRoot, entry.url));
			if (entry.sha512 !== createHash("sha512").update(bytes).digest("base64"))
				throw new Error("Update checksum mismatch.");
		}
	} else if (
		files.some(
			(name) => name.endsWith(".blockmap") || /^(latest|beta)(?:-[\w-]+)?\.yml$/.test(name),
		)
	) {
		throw new Error("Unsigned Windows releases must not contain update metadata.");
	}
	const extensions = windows ? [".exe"] : [".AppImage", ".deb", ".rpm"];
	for (const extension of extensions) {
		const matches = files.filter(
			(name) => name.endsWith(extension) && name.includes(configuration.version),
		);
		if (matches.length !== 1) throw new Error(`Expected one ${extension} installer.`);
		if (windows && !signedWindows && !matches[0]?.endsWith("-unsigned.exe"))
			throw new Error("Unsigned Windows installer must be named explicitly.");
		if (signedWindows) await verifyAuthenticode(join(releaseRoot, matches[0] ?? ""));
	}
	const unpacked = windows
		? `win${configuration.arch === "arm64" ? "-arm64" : ""}-unpacked`
		: `linux${configuration.arch === "arm64" ? "-arm64" : ""}-unpacked`;
	const cli = join(releaseRoot, unpacked, "resources", "native", windows ? "clawdi.exe" : "clawdi");
	if (signedWindows) {
		await verifyAuthenticode(cli);
		await verifyAuthenticode(join(releaseRoot, unpacked, "Clawdi.exe"));
		const config = parse(
			readFileSync(join(releaseRoot, unpacked, "resources", "app-update.yml"), "utf8"),
		);
		const publishers = Array.isArray(config?.publisherName)
			? config.publisherName
			: [config?.publisherName];
		if (!publishers.includes(configuration.windowsPublisher))
			throw new Error("Missing update publisher pin.");
	}
	if (configuration.arch === process.arch) await run(cli, ["update", "--native-identity"]);
}

async function verifyAuthenticode(path: string): Promise<void> {
	await run(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$s = Get-AuthenticodeSignature -LiteralPath $env.CLAWDI_VERIFY_FILE; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -cne $env.CLAWDI_VERIFY_PUBLISHER) { throw 'Invalid Authenticode signature or full publisher Subject DN' }",
		],
		{ CLAWDI_VERIFY_FILE: path, CLAWDI_VERIFY_PUBLISHER: configuration.windowsPublisher ?? "" },
	);
}

function verifyPackagedUpdateConfiguration(): void {
	const resources =
		configuration.platform === "darwin"
			? join(
					releaseRoot,
					configuration.arch === "arm64" ? "mac-arm64" : "mac",
					"Clawdi.app",
					"Contents",
					"Resources",
				)
			: join(
					releaseRoot,
					`${configuration.platform === "win32" ? "win" : "linux"}${configuration.arch === "arm64" ? "-arm64" : ""}-unpacked`,
					"resources",
				);
	const configPath = join(resources, "app-update.yml");
	if (configuration.platform === "win32" && !signedWindows) {
		if (existsSync(configPath))
			throw new Error("Unsigned Windows package must not contain app-update.yml.");
		return;
	}
	const config: unknown = parse(readFileSync(configPath, "utf8"));
	if (
		!isRecord(config) ||
		config.provider !== "generic" ||
		config.url !== configuration.updateFeedUrl ||
		config.channel !== (configuration.channel === "stable" ? "latest" : "beta")
	) {
		throw new Error("Packaged app-update.yml does not match the release feed/channel.");
	}
}
