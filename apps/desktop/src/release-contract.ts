import { normalizeDesktopUpdateFeedUrl } from "./update-policy";

export interface DesktopReleaseConfiguration {
	version: string;
	updateFeedUrl: string;
}

export function readDesktopReleaseConfiguration(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
): DesktopReleaseConfiguration {
	if (platform !== "darwin") throw new Error("Desktop release packaging must run on macOS.");
	const version = env.CLAWDI_DESKTOP_VERSION?.trim() ?? "";
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
		throw new Error("CLAWDI_DESKTOP_VERSION must be an explicit stable semver such as 1.2.3.");
	}
	const hasSigningIdentity = Boolean(
		env.CSC_NAME?.trim() || (env.CSC_LINK?.trim() && env.CSC_KEY_PASSWORD),
	);
	if (!hasSigningIdentity) {
		throw new Error(
			"A Developer ID signing identity is required through CSC_NAME or CSC_LINK with CSC_KEY_PASSWORD.",
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
	return { version, updateFeedUrl };
}

export function desktopReleaseBuilderArgs(configuration: DesktopReleaseConfiguration): string[] {
	return [
		"x",
		"electron-builder",
		"--mac",
		"dmg",
		"zip",
		"--arm64",
		"--publish",
		"never",
		"--config.forceCodeSigning=true",
		"--config.mac.notarize=true",
		`--config.extraMetadata.version=${configuration.version}`,
		"--config.extraMetadata.clawdiUpdateChannel=stable",
		`--config.extraMetadata.clawdiUpdateFeedUrl=${configuration.updateFeedUrl}`,
		"--config.publish.provider=generic",
		`--config.publish.url=${configuration.updateFeedUrl}`,
	];
}

function allPresent(env: Record<string, string | undefined>, names: string[]): boolean {
	return names.every((name) => Boolean(env[name]?.trim()));
}
