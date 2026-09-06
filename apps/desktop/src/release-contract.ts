import { normalizeDesktopUpdateFeedUrl } from "./update-policy";

export interface DesktopReleaseConfiguration {
	version: string;
	channel: "stable" | "beta";
	updateFeedUrl: string;
}

export function readDesktopReleaseConfiguration(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
): DesktopReleaseConfiguration {
	if (platform !== "darwin") throw new Error("Desktop release packaging must run on macOS.");
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
	if (!hasSigningIdentity) {
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

	if (!allPresent(env, ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"])) {
		throw new Error(
			"Apple notarization requires APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER.",
		);
	}
	return { version, channel, updateFeedUrl };
}

export function desktopReleaseBuilderArgs(configuration: DesktopReleaseConfiguration): string[] {
	return [
		"run",
		"electron-builder",
		"--mac",
		"dmg",
		"zip",
		"--arm64",
		"--publish",
		"never",
		"--config.forceCodeSigning=true",
		"--config.mac.notarize=true",
		"--config.dmg.sign=true",
		`--config.extraMetadata.version=${configuration.version}`,
		`--config.extraMetadata.clawdiUpdateChannel=${configuration.channel}`,
		`--config.extraMetadata.clawdiUpdateFeedUrl=${configuration.updateFeedUrl}`,
		"--config.publish.provider=generic",
		"--config.generateUpdatesFilesForAllChannels=false",
		`--config.publish.channel=${configuration.channel === "stable" ? "latest" : "beta"}`,
		`--config.publish.url=${configuration.updateFeedUrl}`,
	];
}

function allPresent(env: Record<string, string | undefined>, names: string[]): boolean {
	return names.every((name) => Boolean(env[name]?.trim()));
}
