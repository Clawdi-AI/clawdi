import { parseDn } from "builder-util-runtime";
import {
	type DesktopPlatform,
	requireDesktopArchitecture,
	requireDesktopPlatform,
} from "./platform";

export interface DesktopReleaseConfiguration {
	version: string;
	platform: DesktopPlatform;
	windowsPublisher?: string;
	arch: "arm64" | "x64";
	channel: "stable" | "beta";
	updateFeedUrl: string;
}

export function readDesktopReleaseConfiguration(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
): DesktopReleaseConfiguration {
	const desktopPlatform = requireDesktopPlatform(platform);
	const arch = requireDesktopArchitecture(env.CLAWDI_DESKTOP_ARCH?.trim() || process.arch);
	const version = env.CLAWDI_DESKTOP_VERSION?.trim() ?? "";
	const channel = env.CLAWDI_DESKTOP_UPDATE_CHANNEL?.trim() || "stable";
	if (channel !== "stable" && channel !== "beta") {
		throw new Error("CLAWDI_DESKTOP_UPDATE_CHANNEL must be stable or beta.");
	}
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta\.(0|[1-9]\d*))?$/.exec(version);
	if (!match || Boolean(match[4]) !== (channel === "beta")) {
		throw new Error(
			"Desktop version must match its channel: 1.2.3 for stable or 1.2.3-beta.1 for beta.",
		);
	}
	const hasSigningIdentity = Boolean(
		env.CSC_KEYCHAIN?.trim() ||
			env.CSC_NAME?.trim() ||
			(env.CSC_LINK?.trim() && env.CSC_KEY_PASSWORD),
	);
	if (desktopPlatform === "darwin" && !hasSigningIdentity) {
		throw new Error(
			"A Developer ID signing identity is required through CSC_KEYCHAIN, CSC_NAME, or CSC_LINK with CSC_KEY_PASSWORD.",
		);
	}
	const updateFeedUrl = normalizeDesktopUpdateFeedUrl(env.CLAWDI_DESKTOP_UPDATE_FEED_URL);
	if (!updateFeedUrl) {
		throw new Error(
			"CLAWDI_DESKTOP_UPDATE_FEED_URL must be an explicit strict HTTPS generic feed URL.",
		);
	}

	if (
		desktopPlatform === "darwin" &&
		!allPresent(env, ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"])
	) {
		throw new Error(
			"Apple notarization requires APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER.",
		);
	}
	const windowsSigning = [
		env.WIN_CSC_LINK?.trim(),
		env.WIN_CSC_KEY_PASSWORD?.trim(),
		env.CLAWDI_WINDOWS_PUBLISHER?.trim(),
	];
	const windowsSigningConfigured = windowsSigning.every(Boolean);
	if (desktopPlatform === "win32" && windowsSigning.some(Boolean) && !windowsSigningConfigured) {
		throw new Error(
			"Windows signing requires WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD and CLAWDI_WINDOWS_PUBLISHER together.",
		);
	}
	const windowsPublisher = windowsSigningConfigured ? windowsSigning[2] : undefined;
	if (
		desktopPlatform === "win32" &&
		windowsSigningConfigured &&
		!isDesktopWindowsPublisherDn(windowsPublisher)
	) {
		throw new Error(
			"CLAWDI_WINDOWS_PUBLISHER must be the complete certificate Subject DN, not a CN-only display name.",
		);
	}
	return {
		version,
		arch,
		channel,
		updateFeedUrl,
		platform: desktopPlatform,
		...(desktopPlatform === "win32" ? { windowsPublisher } : {}),
	};
}

export function desktopReleaseBuilderArgs(configuration: DesktopReleaseConfiguration): string[] {
	const signedWindows =
		configuration.platform === "win32" && Boolean(configuration.windowsPublisher);
	const artifactNameOption =
		configuration.platform === "darwin"
			? "artifactName"
			: `${configuration.platform === "win32" ? "win" : "linux"}.artifactName`;
	return [
		"run",
		"electron-builder",
		...(configuration.platform === "darwin"
			? ["--mac", "dmg", "zip"]
			: configuration.platform === "win32"
				? ["--win", "nsis"]
				: ["--linux", "AppImage", "deb", "rpm"]),
		`--${configuration.arch}`,
		"--publish",
		"never",
		...(configuration.platform === "darwin"
			? ["--config.forceCodeSigning=true", "--config.mac.notarize=true", "--config.dmg.sign=true"]
			: signedWindows
				? [
						"--config.forceCodeSigning=true",
						`--config.win.signtoolOptions.publisherName=${configuration.windowsPublisher}`,
					]
				: []),
		// electron-builder expands these placeholders after selecting the target.
		`--config.${artifactNameOption}=Clawdi-\${version}-${configuration.platform}-\${arch}${configuration.platform === "win32" && !signedWindows ? "-unsigned" : ""}.\${ext}`,
		`--config.extraMetadata.version=${configuration.version}`,
		`--config.extraMetadata.clawdiUpdateChannel=${configuration.channel}`,
		"--config.publish.provider=generic",
		"--config.generateUpdatesFilesForAllChannels=false",
		`--config.publish.channel=${configuration.channel === "stable" ? "latest" : "beta"}`,
		`--config.publish.url=${configuration.updateFeedUrl}`,
	];
}

function allPresent(env: Record<string, string | undefined>, names: string[]): boolean {
	return names.every((name) => Boolean(env[name]?.trim()));
}

export function normalizeDesktopUpdateFeedUrl(value: unknown): string | null {
	if (typeof value !== "string" || value !== value.trim()) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!url.hostname ||
		!url.pathname.endsWith("/")
	) {
		return null;
	}
	return url.href;
}

// Require DN notation here. The release verifier checks the complete Subject;
// electron-updater remains responsible for downloaded-installer verification.
export function isDesktopWindowsPublisherDn(value: unknown): value is string {
	if (
		typeof value !== "string" ||
		value !== value.trim() ||
		["\r", "\n", "\0"].some((character) => value.includes(character))
	)
		return false;
	try {
		// Use the same RFC2253 parser as electron-updater 6.8.9, including quoted
		// and escaped values. Reject both a bare CN label and a CN-only DN.
		const fields = parseDn(value);
		return fields.has("CN") && fields.size > 1;
	} catch {
		return false;
	}
}
